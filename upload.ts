import * as core from "@actions/core";
import { globby } from "globby";
import { lstatSync } from "fs";
import path from "path";
import md5File from "md5-file";
import { OctokitClient } from "./typings";
import { Context } from "@actions/github/lib/context";

export const uploadReleaseArtifacts = async (
  client: OctokitClient,
  context: Context,
  uploadUrl: string,
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
            "content-length": lstatSync(filePath).size,
            "content-type": "application/octet-stream",
          },
          baseUrl: uploadUrl,
          name: nameWithExt,
          repo: context.repo.repo,
          release_id: context.payload.release?.id,
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
            "content-length": lstatSync(filePath).size,
            "content-type": "application/octet-stream",
          },
          baseUrl: uploadUrl,
          name: newName,
          repo: context.repo.repo,
          release_id: context.payload.release?.id,
          data: `@${filePath}`,
        });
      }
    }
  }
  core.endGroup();
};
