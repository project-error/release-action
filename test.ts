import { inc, prerelease } from "semver";

function main() {
  const semVer = "1.8.4-beta.20231105.0";

  const currentDate = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const newSemver = inc(semVer, "prerelease", "beta");

  console.log(newSemver);

  const newSemver2 = inc(newSemver, "prerelease", "beta");

  console.log(newSemver2);

  const pre = prerelease(newSemver2);

  console.log("is pre", pre);
}

main();
