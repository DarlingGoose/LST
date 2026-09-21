import { readFile, stat } from "node:fs/promises";
import process from "node:process";

const manifest = JSON.parse(await readFile("src/manifest.json", "utf8"));
const browser = process.argv[2];

if (!new Set(["firefox", "chrome"]).has(browser)) {
  console.error("Usage: node scripts/verify-package.mjs <firefox|chrome>");
  process.exit(1);
}

const packagedManifest = JSON.parse(
  await readFile(`.${browser}-build/manifest.json`, "utf8")
);
const archive = `web-ext-artifacts/lst-${browser}-${manifest.version}.zip`;

await stat(archive).catch(() => {
  console.error(`Expected release archive was not created: ${archive}`);
  process.exit(1);
});

const zip = await readFile(archive);
const eocdSignature = 0x06054b50;
const centralSignature = 0x02014b50;
let eocdOffset = -1;

for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 65_557); offset--) {
  if (zip.readUInt32LE(offset) === eocdSignature) {
    eocdOffset = offset;
    break;
  }
}

if (eocdOffset < 0) {
  console.error(`Package verification failed: ${archive} is not a readable ZIP archive.`);
  process.exit(1);
}

const entryCount = zip.readUInt16LE(eocdOffset + 10);
let centralOffset = zip.readUInt32LE(eocdOffset + 16);
const entries = [];

for (let index = 0; index < entryCount; index++) {
  if (zip.readUInt32LE(centralOffset) !== centralSignature) {
    console.error("Package verification failed: invalid ZIP central directory.");
    process.exit(1);
  }

  const nameLength = zip.readUInt16LE(centralOffset + 28);
  const extraLength = zip.readUInt16LE(centralOffset + 30);
  const commentLength = zip.readUInt16LE(centralOffset + 32);
  const nameStart = centralOffset + 46;
  entries.push(zip.subarray(nameStart, nameStart + nameLength).toString("utf8"));
  centralOffset += 46 + nameLength + extraLength + commentLength;
}

const required = [
  "manifest.json",
  "background/index.js",
  "content/index.js",
  "content/capture-bridge.js",
  "content/styles.css",
  "page/page-hook.js",
  "sites/playback-site.js",
  "shared/episode-identity.js",
  "shared/playback-policy.js",
  "shared/settings-schema.js",
  "shared/structured-response.js",
  "shared/subtitle-import.js",
  "shared/subtitle-sync.js",
  "shared/translation-context.js",
  "ui/options/options.css",
  "ui/options/options.html",
  "ui/options/options.js",
  "ui/popup/popup.css",
  "ui/popup/popup.html",
  "ui/popup/popup.js",
  "ui/setup/setup.html",
  "ui/setup/setup.js",
  "assets/icons/icon-128.png"
];
const forbidden = [
  "package.json",
  "package-lock.json",
  "amo-metadata.json",
  "docs/releases/amo-reviewer-notes.md",
  "PRIVACY.md"
];
const errors = [];

if (packagedManifest.version !== manifest.version) {
  errors.push(`${browser} package version does not match the shared manifest`);
}

if (browser === "firefox") {
  if (packagedManifest.background?.service_worker) {
    errors.push("Firefox package manifest still contains background.service_worker");
  }
  if (!packagedManifest.background?.scripts?.includes("background/index.js")) {
    errors.push("Firefox package manifest is missing background.scripts");
  }
  if (Number.parseInt(
    packagedManifest.browser_specific_settings?.gecko_android?.strict_min_version,
    10
  ) < 142) {
    errors.push("Firefox package manifest must require Firefox Android 142 or newer");
  }
} else {
  if (packagedManifest.background?.service_worker !== "background/index.js") {
    errors.push("Chrome package manifest is missing background.service_worker");
  }
  if (packagedManifest.background?.scripts) {
    errors.push("Chrome package manifest still contains background.scripts");
  }
  if (packagedManifest.browser_specific_settings) {
    errors.push("Chrome package manifest still contains Firefox metadata");
  }
}

if (!entries.includes("manifest.json")) {
  errors.push("manifest.json is not at the archive root");
}
for (const entry of required) {
  if (!entries.includes(entry)) errors.push(`missing ${entry}`);
}
for (const entry of forbidden) {
  if (entries.includes(entry)) errors.push(`development-only file included: ${entry}`);
}
if (entries.some((entry) =>
  !entry.endsWith("/") && entry.startsWith("lst-local-subtitle-translate/")
)) {
  errors.push("archive contains an extra top-level extension directory");
}

if (errors.length) {
  console.error(`Package verification failed:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}

console.log(`Verified ${archive}: ${entries.length} entries with manifest.json at the root.`);
