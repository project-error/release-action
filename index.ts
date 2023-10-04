import { Octokit } from "@octokit/rest";
import * as core from "@actions/core";
import { Context } from "@actions/github/lib/context";
import semverValid from "semver/functions/valid";
import semverRcompare from "semver/functions/rcompare";
import semverInc from "semver/functions/inc";
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
import { prerelease, ReleaseType } from "semver";
import conventionalCommitsParser from "conventional-commits-parser";
import { generateChangelogFromParsedCommits, getNextSemverBump } from "./utils";

function validateArgs(): ActionArgs {
  const args = {
    repoToken: process.env.GITHUB_TOKEN as string,
    title: core.getInput("title", { required: false }),
    preRelease: JSON.parse(core.getInput("prerelease", { required: false })),
    automaticReleaseTag: core.getInput("automatic_release_tag", {
      required: false,
    }),
    environment: core.getInput("environment", { required: false }) as
      | "dev"
      | "test"
      | "prod",
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

    core.debug(`Github context ${JSON.stringify(context)}`);
    core.startGroup("Initializing action");
    core.info(`Running in ${args.preRelease ? "pre-release" : "release"} mode`);
    core.endGroup();

    core.startGroup("Getting release tags");
    const previousReleaseTag = args.automaticReleaseTag
      ? args.automaticReleaseTag
      : await searchForPreviousEnvironmentReleaseTag(
          octokit,
          {
            owner: context.repo.owner,
            repo: context.repo.repo,
          },
          args.environment,
        );

    core.info(`Previous release tag: ${previousReleaseTag}`);
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

    const parsedCommits = await parseCommits(
      octokit,
      context.repo.owner,
      context.repo.repo,
      commitsSinceRelease,
    );

    core.info(`Found ${commitsSinceRelease.length} commits since last release`);

    const changelog = await getChangelog(
      octokit,
      context.repo.owner,
      context.repo.repo,
      commitsSinceRelease,
    );

    if (args.automaticReleaseTag) {
      await createGithubTag(octokit, {
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

      await createNewRelease(octokit, {
        owner: context.repo.owner,
        repo: context.repo.repo,
        tag_name: args.automaticReleaseTag,
        body: changelog,
        prerelease: args.preRelease,
        name: args.title ? args.title : args.automaticReleaseTag,
      });
    } else {
      const latestReleaseTag = await searchForPreviousReleaseTag(octokit, {
        owner: context.repo.owner,
        repo: context.repo.repo,
      });

      const newReleaseTag = await createNewReleaseTag(
        latestReleaseTag,
        parsedCommits,
        args.environment,
      );
      core.info(`New release tag: ${newReleaseTag}`);

      await createGithubTag(octokit, {
        owner: context.repo.owner,
        repo: context.repo.repo,
        ref: `refs/tags/${newReleaseTag}`,
        sha: context.sha,
      });

      await createNewRelease(octokit, {
        owner: context.repo.owner,
        repo: context.repo.repo,
        tag_name: newReleaseTag,
        body: changelog,
        prerelease: args.preRelease,
        name: args.title ? `${args.title} - ${newReleaseTag}` : newReleaseTag,
      });
    }
  } catch (err) {
    if (err instanceof Error) {
      core.setFailed(err?.message);
      throw err;
    }

    core.setFailed("An unexpected error occurred");
    throw err;
  }
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

const createNewReleaseTag = async (
  currentTag: string,
  commits: ParsedCommit[],
  environment: "dev" | "test" | "prod",
) => {
  let increment = getNextSemverBump(commits, environment);

  core.info(`Next semver bump: ${increment}`);

  if (environment === "test") {
    if (!increment) {
      core.info("New prerelease bump");
      return semverInc(currentTag, "prerelease", "pre");
    }

    const preinc = ("pre" + increment) as ReleaseType;
    const preTag = semverInc(currentTag, preinc, "pre");

    core.info(`New pre-release tag: ${preTag}`);
    return preTag;
  }

  // @ts-ignore
  return semverInc(currentTag, increment);
};

async function searchForPreviousReleaseTag(
  octokit: OctokitClient,
  tagInfo: ReposListTagsParams,
) {
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

  return tagList[0].name;
}

async function searchForPreviousEnvironmentReleaseTag(
  octokit: OctokitClient,
  tagInfo: ReposListTagsParams,
  environment: "dev" | "test" | "prod",
) {
  const listTagsOptions = octokit.repos.listTags.endpoint.merge(tagInfo);
  const tl = await octokit.paginate(listTagsOptions);

  core.info(`Found ${tl.length} tags`);

  const tagList = tl
    .map((tag: any) => {
      core.info(`Found tag ${tag.name}`);
      if (environment === "test") {
        core.info(`Environment is test, checking for prerelease tag`);
        const preArr = prerelease(tag.name);
        if (preArr?.length > 0 && preArr?.includes("pre")) {
          const t = semverValid(tag.name);
          core.info(`Prerelease tag: ${t}`);
          return {
            ...tag,
            semverTag: t ?? null,
          };
        }

        return {
          ...tag,
          semverTag: null,
        };
      } else {
        core.info(`Environment is not test, checking for semver tag`);
        const t = semverValid(tag.name);
        core.info(`Semver tag: ${t}`);
        const preArr = prerelease(tag.name);
        if (preArr?.length > 0 && preArr?.includes("pre")) {
          return {
            ...tag,
            semverTag: null,
          };
        }
        return {
          ...tag,
          semverTag: t,
        };
      }
    })
    .filter((tag) => tag?.semverTag !== null)
    .sort((a, b) => semverRcompare(a.semverTag, b.semverTag));

  core.info(`Found ${tagList.length} semver tags`);

  // return the latest tag
  return tagList[0] ? tagList[0].name : "";
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

const parseGitTag = (inputRef: string): string => {
  const re = /^(refs\/)?tags\/(.*)$/;
  const resMatch = inputRef.match(re);
  if (!resMatch || !resMatch[2]) {
    core.debug(`Input "${inputRef}" does not appear to be a tag`);
    return "";
  }
  return resMatch[2];
};

async function parseCommits(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  commits: BaseheadCommits["data"]["commits"],
) {
  const parsedCommits: ParsedCommit[] = [];

  for (const commit of commits) {
    core.info(`Processing commit ${commit.sha}`);

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
        revertPattern: /^Revert \"([\s\S]*)\"$/,
      },
    );

    if (changelogCommit.merge) {
      core.debug(`Ignoring merge commit: ${changelogCommit.merge}`);
      continue;
    }

    if (changelogCommit.revert) {
      core.debug(`Ignoring revert commit: ${changelogCommit.revert}`);
      continue;
    }

    const parsedCommit: ParsedCommit = {
      commitMsg: changelogCommit,
      commit,
    };

    parsedCommits.push(parsedCommit);
  }

  return parsedCommits;
}

async function createGithubTag(
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
