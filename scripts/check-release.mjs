import { readFile } from "node:fs/promises";
import process from "node:process";

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const errors = [];

if (manifest.version !== packageJson.version) {
  errors.push(`manifest version ${manifest.version} does not match package version ${packageJson.version}`);
}

if (process.env.GITHUB_REF_TYPE === "tag") {
  const tagVersion = String(process.env.GITHUB_REF_NAME || "").replace(/^v/, "");
  if (tagVersion !== manifest.version) {
    errors.push(`tag ${process.env.GITHUB_REF_NAME} does not match manifest version ${manifest.version}`);
  }
}

const gecko = manifest.browser_specific_settings?.gecko || {};
if (!gecko.id || gecko.id.includes("local.dev")) {
  errors.push("manifest must use a permanent Firefox add-on ID");
}

if (Number.parseInt(gecko.strict_min_version, 10) < 140) {
  errors.push("Firefox strict_min_version must be at least 140 for built-in data consent");
}

const transmitted = gecko.data_collection_permissions?.required || [];
if (!transmitted.includes("websiteContent")) {
  errors.push("manifest must declare websiteContent transmission for subtitle text");
}

for (const size of [16, 32, 48, 64, 96, 128]) {
  if (!manifest.icons?.[size]) errors.push(`manifest icon ${size}px is missing`);
}

if (errors.length) {
  console.error(`Release checks failed:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}

console.log(`Release metadata is consistent for v${manifest.version}.`);
