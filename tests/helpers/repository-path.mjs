const extensionPaths = Object.freeze({
  "background.js": "src/background/index.js",
  "capture-bridge.js": "src/content/capture-bridge.js",
  "content.js": "src/content/index.js",
  "styles.css": "src/content/styles.css",
  "page-hook.js": "src/page/page-hook.js",
  "playback-site.js": "src/sites/playback-site.js",
  "episode-identity.js": "src/shared/episode-identity.js",
  "playback-policy.js": "src/shared/playback-policy.js",
  "settings-schema.js": "src/shared/settings-schema.js",
  "structured-response.js": "src/shared/structured-response.js",
  "subtitle-import.js": "src/shared/subtitle-import.js",
  "subtitle-sync.js": "src/shared/subtitle-sync.js",
  "translation-context.js": "src/shared/translation-context.js",
  "translation-coordinator.js": "src/shared/translation-coordinator.js",
  "translation-guard.js": "src/shared/translation-guard.js",
  "manifest.json": "src/manifest.json",
  "options.css": "src/ui/options/options.css",
  "options.html": "src/ui/options/options.html",
  "options.js": "src/ui/options/options.js",
  "popup.css": "src/ui/popup/popup.css",
  "popup.html": "src/ui/popup/popup.html",
  "popup.js": "src/ui/popup/popup.js",
  "setup.html": "src/ui/setup/setup.html",
  "setup.js": "src/ui/setup/setup.js",
});

export function repositoryPath(name) {
  return `../${extensionPaths[name] || name}`;
}
