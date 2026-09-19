import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const sourceFiles = [
  "background.js",
  "content.js",
  "episode-identity.js",
  "manifest.json",
  "options.css",
  "options.html",
  "options.js",
  "page-hook.js",
  "playback-site.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "setup.html",
  "setup.js",
  "styles.css",
  "structured-response.js",
  "subtitle-import.js",
  "subtitle-sync.js",
  "translation-context.js",
  "translation-coordinator.js",
  "translation-guard.js"
];

export async function prepareBrowser(browser) {
  if (!new Set(["firefox", "chrome"]).has(browser)) {
    throw new Error(`Unsupported browser: ${browser}`);
  }

  const outputDirectory = `.${browser}-build`;

  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });

  for (const file of sourceFiles) {
    await cp(file, `${outputDirectory}/${file}`);
  }
  await cp("icons", `${outputDirectory}/icons`, { recursive: true });
  await cp("favicons", `${outputDirectory}/favicons`, { recursive: true });

  const manifestPath = `${outputDirectory}/manifest.json`;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  if (browser === "firefox") {
    // Firefox MV3 uses background.scripts. The shared source keeps
    // service_worker for Chromium, but AMO should not receive it.
    delete manifest.background?.service_worker;
    manifest.browser_specific_settings ||= {};
    manifest.browser_specific_settings.gecko_android = {
      ...(manifest.browser_specific_settings.gecko_android || {}),
      strict_min_version: "142.0"
    };
  } else {
    // Chromium MV3 uses service_worker and must not receive Gecko metadata.
    delete manifest.background?.scripts;
    delete manifest.browser_specific_settings;

    if (!manifest.background?.service_worker) {
      throw new Error("Chrome manifest is missing background.service_worker");
    }
  }

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Prepared ${browser} source in ${outputDirectory}.`);
}
