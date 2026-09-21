// One owner for settings defaults, migration, validation, and global/show
// precedence. Every extension context loads this module before reading settings
// so a migrated profile cannot mean one thing in the player and another in the
// popup or settings page.
(() => {
  if (globalThis.LSTSettingsSchema) return;

  const VERSION = 1;
  const RENAMED_KEYS = Object.freeze({
    hideNativeSubtitles: "hideNetflixSubtitles",
  });
  const PER_SHOW_NAMES = Object.freeze([
    "showTranslated",
    "hideNativeSubtitles",
    "showTranscriptSidebar",
  ]);
  const INTERFACE_NAMES = Object.freeze([
    "hideNativeSubtitles",
    "showNativeWhenTargetLanguage",
    "hudPosition",
    "showOriginal",
    "showTranslated",
    "minimumSubtitleDisplaySeconds",
    "maximumVisibleSubtitles",
    "showStatusMessages",
    "showDebugPanel",
    "debugPanelAlwaysOnTop",
    "showQuickPills",
    "autoMinimizeControls",
    "controlsMinimizeDelaySeconds",
    "showTranscriptSidebar",
    "subtitleHorizontalPosition",
    "subtitleVerticalPosition",
    "subtitleMaxWidth",
    "translatedFontSize",
    "originalFontSize",
    "subtitleBackgroundOpacity",
    "subtitleTimingOffsetMs",
  ]);

  const DEFINITIONS = Object.freeze({
    settingsSchemaVersion: { default: VERSION, type: "integer", min: VERSION, max: VERSION },
    enabled: { default: true, type: "boolean" },
    ollamaUrl: { default: "http://localhost:11434", type: "string" },
    provider: { default: "ollama", type: "enum", values: ["ollama", "deepseek", "gemini"] },
    ollamaModel: { default: "translategemma:4b", type: "string" },
    deepseekModel: { default: "", type: "string" },
    geminiModel: { default: "", type: "string" },
    model: { default: "translategemma:4b", type: "string" },
    targetLanguage: { default: "English", type: "string", nonempty: true },
    translationPaused: { default: false, type: "boolean" },
    hideNativeSubtitles: { default: true, type: "boolean" },
    showNativeWhenTargetLanguage: { default: true, type: "boolean" },
    enabledSites: {
      default: Object.freeze({ netflix: true, primevideo: true }),
      type: "boolean-map",
    },
    hudPosition: {
      default: "",
      type: "enum",
      values: ["", "top-left", "top-right", "bottom-left", "bottom-right"],
    },
    showOriginal: { default: false, type: "boolean" },
    showTranslated: { default: true, type: "boolean" },
    setupCompleted: { default: false, type: "boolean" },
    minimumSubtitleDisplaySeconds: { default: 2, type: "number", min: 0, max: 10 },
    maximumVisibleSubtitles: { default: 2, type: "integer", min: 1, max: 4 },
    showStatusMessages: { default: true, type: "boolean" },
    autoTranslateAhead: { default: true, type: "boolean" },
    useTranslationContext: { default: false, type: "boolean" },
    contextLevel: {
      default: "standard",
      type: "enum",
      values: ["minimal", "standard", "wide"],
    },
    verifyTranslations: { default: true, type: "boolean" },
    lookAheadSeconds: { default: 30, type: "number", min: 30, max: 600 },
    cacheWhilePaused: { default: true, type: "boolean" },
    batchSize: { default: 8, type: "integer", min: 1, max: 50 },
    requestTimeoutSeconds: { default: 75, type: "number", min: 15, max: 300 },
    customTranslationPrompt: { default: "", type: "string" },
    showDebugPanel: { default: false, type: "boolean" },
    debugPanelAlwaysOnTop: { default: false, type: "boolean" },
    showQuickPills: { default: true, type: "boolean" },
    autoMinimizeControls: { default: true, type: "boolean" },
    controlsMinimizeDelaySeconds: { default: 2, type: "integer", min: 1, max: 30 },
    showTranscriptSidebar: { default: false, type: "boolean" },
    subtitleHorizontalPosition: {
      default: "center",
      type: "enum",
      values: ["left", "center", "right"],
    },
    subtitleVerticalPosition: { default: 9, type: "integer", min: 4, max: 82 },
    subtitleMaxWidth: { default: 92, type: "integer", min: 40, max: 96 },
    translatedFontSize: { default: 36, type: "integer", min: 18, max: 64 },
    originalFontSize: { default: 30, type: "integer", min: 14, max: 56 },
    subtitleBackgroundOpacity: { default: 58, type: "integer", min: 0, max: 90 },
    subtitleTimingOffsetMs: { default: 0, type: "integer", min: -2000, max: 2000 },
  });

  const clone = (value) => {
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
    }
    return value;
  };

  function defaults() {
    return Object.fromEntries(
      Object.entries(DEFINITIONS).map(([name, definition]) => [name, clone(definition.default)]),
    );
  }

  function normalizeValue(name, value) {
    const definition = DEFINITIONS[name];
    if (!definition) return undefined;
    const fallback = clone(definition.default);
    if (definition.type === "boolean") return typeof value === "boolean" ? value : fallback;
    if (definition.type === "string") {
      if (typeof value !== "string") return fallback;
      return definition.nonempty && !value.trim() ? fallback : value;
    }
    if (definition.type === "enum") {
      return definition.values.includes(value) ? value : fallback;
    }
    if (definition.type === "boolean-map") {
      const result = clone(definition.default);
      if (!value || typeof value !== "object" || Array.isArray(value)) return result;
      for (const [key, enabled] of Object.entries(value)) {
        if (typeof enabled === "boolean") result[key] = enabled;
      }
      return result;
    }
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    const bounded = Math.min(definition.max, Math.max(definition.min, number));
    return definition.type === "integer" ? Math.round(bounded) : bounded;
  }

  function normalizeStored(stored = {}) {
    const settings = {};
    const sources = {};
    for (const name of Object.keys(DEFINITIONS)) {
      const legacyName = RENAMED_KEYS[name];
      const hasCurrent = stored[name] !== undefined;
      const hasLegacy = !hasCurrent && legacyName && stored[legacyName] !== undefined;
      const raw = hasCurrent ? stored[name] : hasLegacy ? stored[legacyName] : undefined;
      settings[name] = normalizeValue(name, raw);
      sources[name] = hasCurrent || hasLegacy ? "global" : "default";
    }
    settings.settingsSchemaVersion = VERSION;
    return { settings, sources };
  }

  function normalizePatch(patch = {}) {
    const result = {};
    for (const [name, value] of Object.entries(patch)) {
      if (!DEFINITIONS[name] || name === "settingsSchemaVersion") continue;
      result[name] = normalizeValue(name, value);
    }
    if (Object.keys(result).length) result.settingsSchemaVersion = VERSION;
    return result;
  }

  function normalizeShowOverrides(value = {}) {
    const result = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return result;
    for (const name of PER_SHOW_NAMES) {
      if (typeof value[name] === "boolean") result[name] = value[name];
    }
    return result;
  }

  function resolveEffective(globalInput = {}, showInput = {}) {
    const normalized = normalizeStored(globalInput);
    const overrides = normalizeShowOverrides(showInput);
    for (const [name, value] of Object.entries(overrides)) {
      normalized.settings[name] = value;
      normalized.sources[name] = "show";
    }
    return normalized;
  }

  function installPatch(stored = {}) {
    const patch = {};
    for (const name of Object.keys(DEFINITIONS)) {
      if (name === "settingsSchemaVersion") continue;
      const legacyName = RENAMED_KEYS[name];
      if (stored[name] !== undefined || (legacyName && stored[legacyName] !== undefined)) continue;
      patch[name] = name === "ollamaModel" && typeof stored.model === "string" && stored.model
        ? stored.model
        : clone(DEFINITIONS[name].default);
    }
    patch.settingsSchemaVersion = VERSION;
    return patch;
  }

  function legacyKeysForPatch(patch = {}) {
    return Object.entries(RENAMED_KEYS)
      .filter(([name]) => patch[name] !== undefined)
      .map(([, legacyName]) => legacyName);
  }

  function interfaceDefaults() {
    return Object.fromEntries(
      INTERFACE_NAMES.map((name) => [name, clone(DEFINITIONS[name].default)]),
    );
  }

  const DEFAULTS = Object.freeze(defaults());
  const SETTING_NAMES = Object.freeze(Object.keys(DEFINITIONS));
  const GLOBAL_NAMES = Object.freeze(
    SETTING_NAMES.filter((name) => name !== "settingsSchemaVersion"),
  );
  const STORAGE_KEYS = Object.freeze([
    ...SETTING_NAMES,
    ...Object.values(RENAMED_KEYS),
  ]);

  globalThis.LSTSettingsSchema = Object.freeze({
    VERSION,
    DEFINITIONS,
    DEFAULTS,
    SETTING_NAMES,
    GLOBAL_NAMES,
    STORAGE_KEYS,
    RENAMED_KEYS,
    PER_SHOW_NAMES,
    INTERFACE_NAMES,
    defaults,
    normalizeValue,
    normalizeStored,
    normalizePatch,
    normalizeShowOverrides,
    resolveEffective,
    installPatch,
    legacyKeysForPatch,
    interfaceDefaults,
  });
})();
