import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const requestedVersion = String(process.argv[2] || "").replace(/^v/, "");
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

if (!versionPattern.test(requestedVersion)) {
  console.error("Usage: npm run version:set -- <major.minor.patch>");
  process.exit(1);
}

if (requestedVersion.split(".").some((part) => Number(part) > 65_535)) {
  console.error("Each version component must be 65535 or lower for browser stores.");
  process.exit(1);
}

const files = ["manifest.json", "package.json", "package-lock.json"];

for (const file of files) {
  const document = JSON.parse(await readFile(file, "utf8"));
  document.version = requestedVersion;

  if (file === "package-lock.json") {
    document.packages[""].version = requestedVersion;
  }

  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
}

console.log(`Updated release metadata to v${requestedVersion}.`);
