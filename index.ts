import { Octokit } from "@octokit/rest";
import * as core from "@actions/core";
import { Context } from "@actions/github/lib/context";
import semverValid from "semver/functions/valid";
import semverRcompare from "semver/functions/rcompare";
import semverLt from "semver/functions/lt";
import conventionalCommitsParser, { Commit } from "conventional-commits-parser";
import { generateChangelogFromParsedCommits } from "./utils";
import {
  ActionArgs,
  BaseheadCommits,
  CreateRefParams,
  CreateReleaseParams,
  GetReleaseByTagParams,
  GitGetRefParams,
  OctokitClient,
  ParsedCommit,
  ReposListTagsParams,
} from "./typings";

function validateArgs(): ActionArgs {
  const args = {
    repoToken: process.env.GITHUB_TOKEN as string,
    title: core.getInput("title", { required: false }),
    preRelease: JSON.parse(core.getInput("prerelease", { required: false })),
    automaticReleaseTag: core.getInput("automatic_release_tag", {
      required: false,
    }),
  };

  return args;
}

export async function main() {
  try {
    const args = validateArgs();
    const context = new Context();

    if (!args.repoToken) {
      core.setFailed(
        "No repo token specified. Please set the GITHUB_TOKEN environment variable.",
      );
      return;
    }

    const octokit = new Octokit({
      auth: args.repoToken,
    });

    core.startGroup("Initializing action");
    core.debug(`Github context ${JSON.stringify(context)}`);
    core.endGroup();

    core.startGroup("Getting release tags");

    const releaseTag = args.automaticReleaseTag
      ? args.automaticReleaseTag
      : parseGitTag(context.ref);

    if (!releaseTag) {
      core.setFailed("No release tag found");
      return;
    }

    const previousReleaseTag = args.automaticReleaseTag
      ? args.automaticReleaseTag
      : await searchForPreviousReleaseTag(octokit, releaseTag, {
          owner: context.repo.owner,
          repo: context.repo.repo,
        });

    core.endGroup();

    const commitsSinceRelease = await getCommitsSinceRelease(
      octokit,
      {
        owner: context.repo.owner,
        repo: context.repo.repo,
        ref: `tags/${previousReleaseTag}`,
      },
      context.sha,
    );

    const changelog = await getChangelog(
      octokit,
      context.repo.owner,
      context.repo.repo,
      commitsSinceRelease,
    );

    if (args.automaticReleaseTag) {
      await createReleaseTag(octokit, {
        owner: context.repo.owner,
        repo: context.repo.repo,
        ref: `refs/tags/${args.automaticReleaseTag}`,
        sha: context.sha,
      });

      await deletePreviousGithubRelease(octokit, {
        owner: context.repo.owner,
        repo: context.repo.repo,
        tag: args.automaticReleaseTag,
      });
    }

    await createNewRelease(octokit, {
      owner: context.repo.owner,
      repo: context.repo.repo,
      tag_name: releaseTag,
      body: changelog,
      prerelease: args.preRelease,
      name: args.title ? args.title : releaseTag,
    });
  } catch (err) {
    if (err instanceof Error) {
      core.setFailed(err?.message);
      throw err;
    }

    core.setFailed("An unexpected error occurred");
    throw err;
  }
}

async function createReleaseTag(
  octokit: OctokitClient,
  refInfo: CreateRefParams,
) {
  core.startGroup("Creating release tag");

  const tagName = refInfo.ref.substring(5);

  core.info(`Attempting to create or update tag ${tagName}`);

  try {
    await octokit.git.createRef(refInfo);
  } catch (err) {
    const existingTag = refInfo.ref.substring(5);
    core.info(`Tag ${existingTag} already exists, attempting to update`);

    await octokit.git.updateRef({
      ...refInfo,
      ref: existingTag,
      force: true,
    });
  }

  core.info(`Successfully created or updated tag ${tagName}`);
  core.endGroup();
}

async function createNewRelease(
  octokit: OctokitClient,
  params: CreateReleaseParams,
): Promise<string> {
  core.startGroup(`Generating new release for the ${params.tag_name} tag`);

  core.info("Creating new release");
  const resp = await octokit.repos.createRelease(params);

  core.endGroup();

  return resp.data.upload_url;
}

const parseGitTag = (inputRef: string): string => {
  const re = /^(refs\/)?tags\/(.*)$/;
  const resMatch = inputRef.match(re);
  if (!resMatch || !resMatch[2]) {
    core.debug(`Input "${inputRef}" does not appear to be a tag`);
    return "";
  }
  return resMatch[2];
};

async function searchForPreviousReleaseTag(
  octokit: OctokitClient,
  currentReleaseTag: string,
  tagInfo: ReposListTagsParams,
) {
  const validSemver = semverValid(currentReleaseTag);
  if (!validSemver) {
    core.setFailed("No valid semver tag found");
    return;
  }

  const listTagsOptions = octokit.repos.listTags.endpoint.merge(tagInfo);
  const tl = await octokit.paginate(listTagsOptions);

  const tagList = tl
    .map((tag: any) => {
      core.debug(`Found tag ${tag.name}`);
      const t = semverValid(tag.name);
      return {
        ...tag,
        semverTag: t,
      };
    })
    .filter((tag) => tag.semverTag !== null)
    .sort((a, b) => semverRcompare(a.semverTag, b.semverTag));

  let previousReleaseTag = "";
  for (const tag of tagList) {
    if (semverLt(tag.semverTag, currentReleaseTag)) {
      previousReleaseTag = tag.name;
      break;
    }
  }

  return previousReleaseTag;
}

async function getCommitsSinceRelease(
  octokit: OctokitClient,
  tagInfo: GitGetRefParams,
  currentSha: string,
) {
  core.startGroup("Fetching commit history");
  let resp;

  let previousReleaseRef = "";
  core.info(`Searching for SHA corresponding to release tag ${tagInfo.ref}`);

  try {
    await octokit.git.getRef(tagInfo);
    previousReleaseRef = parseGitTag(tagInfo.ref);
  } catch (err) {
    core.info(
      `Could not find SHA for release tag ${tagInfo.ref}. Assuming this is the first release.`,
    );
    previousReleaseRef = "HEAD";
  }

  core.info(`Fetching commits betwen ${previousReleaseRef} and ${currentSha}`);

  try {
    resp = await octokit.repos.compareCommitsWithBasehead({
      repo: tagInfo.repo,
      owner: tagInfo.owner,
      basehead: `${previousReleaseRef}...${currentSha}`,
    });

    core.info(`Found ${resp.data.commits.length} commits since last release`);
  } catch (err) {
    core.warning(
      `Could not fetch commits between ${previousReleaseRef} and ${currentSha}`,
    );
  }

  let commits: BaseheadCommits["data"]["commits"] = [];
  if (resp?.data?.commits) {
    commits = resp.data.commits;
  }

  core.debug(`Currently ${commits.length} commits in the list`);

  core.endGroup();
  return commits;
}

async function getChangelog(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  commits: BaseheadCommits["data"]["commits"],
): Promise<string> {
  const parsedCommits: ParsedCommit[] = [];

  for (const commit of commits) {
    core.info(`Processing commit ${commit.sha}`);
    core.info(
      `Searching for pull requests associated with commit ${commit.sha}`,
    );

    const pulls = await octokit.repos.listPullRequestsAssociatedWithCommit({
      owner,
      repo,
      commit_sha: commit.sha,
    });

    if (pulls.data.length) {
      core.info(
        `Found ${pulls.data.length} pull request(s) associated with commit ${commit.sha}`,
      );
    }

    const changelogCommit = conventionalCommitsParser.sync(
      commit.commit.message,
      {
        mergePattern: /^Merge pull request #(\d+) from (.*)$/,
      },
    );

    if (changelogCommit.merge) {
      core.debug(`Ignoring merge commit: ${changelogCommit.merge}`);
      continue;
    }

    const parsedCommit: ParsedCommit = {
      commitMsg: changelogCommit,
      commit,
    };

    parsedCommits.push(parsedCommit);
  }

  const changelog = generateChangelogFromParsedCommits(parsedCommits);

  return changelog;
}

async function deletePreviousGithubRelease(
  octokit: OctokitClient,
  releaseInfo: GetReleaseByTagParams,
) {
  core.startGroup(`Deleting previous release with tag ${releaseInfo.tag}`);

  try {
    const resp = await octokit.repos.getReleaseByTag(releaseInfo);

    core.info(`Found release ${resp.data.id}, deleting`);
    await octokit.repos.deleteRelease({
      owner: releaseInfo.owner,
      repo: releaseInfo.repo,
      release_id: resp.data.id,
    });
  } catch (err) {
    core.info(`Could not find release with tag ${releaseInfo.tag}`);
  }

  core.endGroup();
}

main();
