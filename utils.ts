import { ParsedCommit } from "./typings";

export const getShortSHA = (sha: string): string => {
  const coreAbbrev = 7;
  return sha.substring(0, coreAbbrev);
};

enum ConventionalCommitTypes {
  feat = "Features",
  fix = "Bug Fixes",
  docs = "Documentation",
  style = "Styles",
  refactor = "Code Refactoring",
  perf = "Performance Improvements",
  test = "Tests",
  build = "Builds",
  ci = "Continuous Integration",
  chore = "Chores",
  revert = "Reverts",
}

const getFormattedChangelogEntry = (parsedCommit: ParsedCommit): string => {
  let entry = "";

  const url = parsedCommit.commit.html_url;
  const sha = getShortSHA(parsedCommit.commit.sha);
  const author = parsedCommit.commit.commit?.author?.name ?? "Unknown";

  entry = `- ${sha}: ${parsedCommit.commitMsg.header} (${author})`;
  if (parsedCommit.commitMsg.type) {
    const scopeStr = parsedCommit.commitMsg.scope
      ? `**${parsedCommit.commitMsg.scope}**: `
      : "";
    entry = `- ${scopeStr}${parsedCommit.commitMsg.subject} ([${author}](${url}))`;
  }

  return entry;
};

export const generateChangelogFromParsedCommits = (
  parsedCommits: ParsedCommit[],
): string => {
  let changelog = "";

  for (const key of Object.keys(ConventionalCommitTypes)) {
    const clBlock = parsedCommits
      .filter((val) => val.commitMsg.type === key)
      .map((val) => getFormattedChangelogEntry(val))
      .reduce((acc, line) => `${acc}\n${line}`, "");
    if (clBlock) {
      changelog += `\n\n## ${(ConventionalCommitTypes as any)[key]}\n`;
      changelog += clBlock.trim();
    }
  }

  // Commits
  const commits = parsedCommits
    .filter((val) => val.commitMsg.type === null)
    .map((val) => getFormattedChangelogEntry(val))
    .reduce((acc, line) => `${acc}\n${line}`, "");
  if (commits) {
    changelog += "\n\n## Commits\n";
    changelog += commits.trim();
  }

  return changelog;
};
