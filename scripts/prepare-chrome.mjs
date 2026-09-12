import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const outputDirectory = ".chrome-build";

const sourceFiles = [
  "background.js",
  "content.js",
  "manifest.json",
  "options.html",
  "options.js",
  "page-hook.js",
  "popup.html",
  "popup.js",
  "styles.css"
];

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

for (const file of sourceFiles) {
  await cp(file, `${outputDirectory}/${file}`);
}

await cp("icons", `${outputDirectory}/icons`, { recursive: true });

const manifestPath = `${outputDirectory}/manifest.json`;
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

// Chromium MV3 uses background.service_worker.
// background.scripts is Firefox-specific.
delete manifest.background?.scripts;

// Firefox/Gecko-only metadata should not be submitted to Chrome.
delete manifest.browser_specific_settings;

if (!manifest.background?.service_worker) {
  throw new Error("Chrome manifest is missing background.service_worker");
}

await writeFile(
  manifestPath,
  `${JSON.stringify(manifest, null, 2)}\n`
);

console.log(`Prepared Chrome source in ${outputDirectory}.`);
