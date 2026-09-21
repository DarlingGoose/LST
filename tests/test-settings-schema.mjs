import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const context = vm.createContext({});
vm.runInContext(
  await fs.readFile(new URL("../src/shared/settings-schema.js", import.meta.url), "utf8"),
  context,
  { filename: "settings-schema.js" },
);
const schema = context.LSTSettingsSchema;

assert.equal(schema.VERSION, 1);
assert.equal(schema.DEFAULTS.showQuickPills, true);
assert.deepEqual(
  [...schema.PER_SHOW_NAMES],
  ["showTranslated", "hideNativeSubtitles", "showTranscriptSidebar"],
);

// A v0.5-style profile has the Netflix-specific spelling and no pill setting.
// The legacy false is preserved, while a missing pill is safely visible.
const v05 = schema.normalizeStored({
  model: "old-local-model",
  hideNetflixSubtitles: false,
  showTranslated: false,
});
assert.equal(v05.settings.hideNativeSubtitles, false);
assert.equal(v05.sources.hideNativeSubtitles, "global");
assert.equal(v05.settings.showQuickPills, true);
assert.equal(v05.sources.showQuickPills, "default");

// A v0.6-style explicit hidden choice remains a real choice and can be surfaced
// by diagnostics/recovered by the popup instead of being silently overwritten.
const v06 = schema.normalizeStored({
  settingsSchemaVersion: 0,
  hideNativeSubtitles: true,
  hideNetflixSubtitles: false,
  showQuickPills: false,
  controlsMinimizeDelaySeconds: 2,
});
assert.equal(v06.settings.hideNativeSubtitles, true, "the current key wins a rename conflict");
assert.equal(v06.settings.showQuickPills, false);
assert.equal(v06.sources.showQuickPills, "global");
assert.equal(v06.settings.settingsSchemaVersion, schema.VERSION);

// Untrusted storage and message values are normalized at one boundary.
const malformed = schema.normalizeStored({
  enabled: "yes",
  provider: "unknown-cloud",
  controlsMinimizeDelaySeconds: 999,
  maximumVisibleSubtitles: 2.7,
  subtitleTimingOffsetMs: -99999,
  enabledSites: { netflix: false, futureService: true, broken: "yes" },
});
assert.equal(malformed.settings.enabled, true);
assert.equal(malformed.settings.provider, "ollama");
assert.equal(malformed.settings.controlsMinimizeDelaySeconds, 30);
assert.equal(malformed.settings.maximumVisibleSubtitles, 3);
assert.equal(malformed.settings.subtitleTimingOffsetMs, -2000);
assert.deepEqual(JSON.parse(JSON.stringify(malformed.settings.enabledSites)), {
  netflix: false,
  primevideo: true,
  futureService: true,
});

const patch = schema.normalizePatch({
  showQuickPills: false,
  controlsMinimizeDelaySeconds: 0,
  deepseekApiKey: "must-not-be-a-setting",
  unknown: true,
});
assert.equal(patch.showQuickPills, false);
assert.equal(patch.controlsMinimizeDelaySeconds, 1);
assert.equal(patch.settingsSchemaVersion, schema.VERSION);
assert.equal("deepseekApiKey" in patch, false);
assert.equal("unknown" in patch, false);

const effective = schema.resolveEffective(
  { showTranslated: true, hideNativeSubtitles: false },
  { showTranslated: false, hideNativeSubtitles: "invalid", showOriginal: true },
);
assert.equal(effective.settings.showTranslated, false);
assert.equal(effective.sources.showTranslated, "show");
assert.equal(effective.settings.hideNativeSubtitles, false);
assert.equal(effective.sources.hideNativeSubtitles, "global");
assert.equal(effective.settings.showOriginal, false);

const install = schema.installPatch({
  model: "legacy-model",
  hideNetflixSubtitles: false,
});
assert.equal(install.ollamaModel, "legacy-model");
assert.equal("hideNativeSubtitles" in install, false);
assert.equal(install.settingsSchemaVersion, schema.VERSION);

const interfaceDefaults = schema.interfaceDefaults();
assert.equal(interfaceDefaults.showQuickPills, true);
assert.equal(interfaceDefaults.autoMinimizeControls, true);
assert.equal(interfaceDefaults.controlsMinimizeDelaySeconds, 2);
for (const dataKey of ["translationCaches", "importedTracks", "jimakuFindings"]) {
  assert.equal(dataKey in interfaceDefaults, false, `${dataKey} must survive an interface reset`);
}

console.log("Settings schema and migration checks passed.");
