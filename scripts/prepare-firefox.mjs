import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const outputDirectory = ".firefox-build";
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

// Firefox MV3 uses background.scripts. Keeping service_worker in the shared
// source manifest is necessary for Chromium, but it should not be submitted
// to AMO because Firefox intentionally ignores it.
delete manifest.background?.service_worker;

manifest.browser_specific_settings ||= {};
manifest.browser_specific_settings.gecko_android = {
  ...(manifest.browser_specific_settings.gecko_android || {}),
  strict_min_version: "142.0"
};

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Prepared Firefox source in ${outputDirectory}.`);
