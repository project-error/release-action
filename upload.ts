import * as core from "@actions/core";
import { globby } from "globby";
import { lstatSync } from "fs";
import path from "path";
import md5File from "md5-file";
import { CreateReleaseResponse, OctokitClient } from "./typings";
import { Context } from "@actions/github/lib/context";

export const uploadReleaseArtifacts = async (
  client: OctokitClient,
  context: Context,
  release: CreateReleaseResponse,
  files: string[],
): Promise<void> => {
  core.startGroup("Uploading release artifacts");
  for (const fileGlob of files) {
    const paths = await globby(fileGlob);
    if (paths.length == 0) {
      core.error(`${fileGlob} doesn't match any files`);
    }

    for (const filePath of paths) {
      core.info(`Uploading: ${filePath}`);
      const nameWithExt = path.basename(filePath);

      try {
        await client.repos.uploadReleaseAsset({
          owner: context.repo.owner,
          headers: {
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "multipart/form-data",
          },
          baseUrl: release.data.upload_url,
          release_id: release.data.id,
          name: nameWithExt,
          repo: context.repo.repo,
          data: `@${filePath}`,
        });
      } catch (err: any) {
        core.info(
          `Problem uploading ${filePath} as a release asset (${err.message}). Will retry with the md5 hash appended to the filename.`,
        );
        const hash = await md5File(filePath);
        const basename = path.basename(filePath, path.extname(filePath));
        const ext = path.extname(filePath);
        const newName = `${basename}-${hash}${ext}`;
        await client.repos.uploadReleaseAsset({
          owner: context.repo.owner,
          headers: {
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "multipart/form-data",
          },
          baseUrl: release.data.upload_url,
          name: newName,
          repo: context.repo.repo,
          release_id: release.data.id,
          data: `@${filePath}`,
        });
      }
    }
  }
  core.endGroup();
};
