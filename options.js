const ext = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const DEFAULT_MODEL = "translategemma:4b";
const PROVIDER_NAMES = { ollama: "Ollama", deepseek: "DeepSeek", gemini: "Gemini" };
const ORIGINAL_TRANSLATION_PROMPT = [
  "You are a subtitle translator.",
  "Translate every requested subtitle into {{targetLanguage}}.",
  "Use natural, concise language suitable for subtitles.",
  "Preserve names, honorifics, punctuation, speaker labels, and intent.",
  "Do not add explanations, notes, analysis, or romanization.",
  "Do not merge, split, omit, or reorder items."
].join(" ");
const providerModels = { ollama: DEFAULT_MODEL, deepseek: "", gemini: "" };
let configuredKeys = { deepseek: false, gemini: false };
const SETTINGS_TABS = ["general", "subtitles", "storage", "advanced"];
const TAB_DETAILS = {
  general: {
    title: "Translation control center",
    description: "Connection, model, and playback behavior at a glance."
  },
  subtitles: {
    title: "Subtitle studio",
    description: "Preview the exact hierarchy viewers will see in the player."
  },
  storage: {
    title: "Translation library",
    description: "Browse cached shows, inspect episodes, and export complete translations."
  },
  advanced: {
    title: "Advanced and diagnostics",
    description: "Troubleshooting controls with privacy boundaries kept explicit."
  }
};
let diagnosticLogEvents = [];

// Where the LST control button and its status may sit inside a player, and the
// legacy spelling of the setting that hides the service's own captions.
const HUD_POSITIONS = ["top-left", "top-right", "bottom-left", "bottom-right"];
const LEGACY_HIDE_SUBTITLES_KEY = "hideNetflixSubtitles";

// The renamed setting is read through, so an install from before the rename
// keeps its answer. `??` and not `||`: a stored `false` is a real answer.
function hidesNativeSubtitles(settings) {
  if (settings?.hideNativeSubtitles !== undefined) return settings.hideNativeSubtitles;
  if (settings?.[LEGACY_HIDE_SUBTITLES_KEY] !== undefined) {
    return settings[LEGACY_HIDE_SUBTITLES_KEY];
  }
  return true;
}

// Which service a cache belongs to. The key is namespaced per service, so a
// Prime Video episode is grouped under Prime Video rather than under whatever
// name a fallback happens to carry.
function cacheShowName(cache) {
  const api = globalThis.LSTPlaybackSite;
  return cache?.showName || api?.labelFor?.(cache?.siteId) || "Unknown service";
}

// Which show a cache belongs to, as an identity rather than a spelling. Two
// episodes whose pages worded the show's name differently — one watched in the
// season the other was not — are one show, because the key episode-identity.js
// makes from a name is the same key it files what LST learned about a show
// under. A cache whose show was never named has no key, and belongs to its
// service rather than to a show it cannot name.
function cacheShowKey(cache) {
  const api = globalThis.LSTEpisodeIdentity;
  const siteId = cache?.siteId || "";
  const key = api?.encodeShowKey
    ? api.encodeShowKey({ showName: cache?.showName || "", siteId })
    : "";
  return key || `service:${siteId || "unknown"}`;
}

// What to call a show in the list: the most specific name any of its episodes
// stated, in the order the caches arrived (newest first), and the service's own
// name when no episode ever stated one. Only the naming module decides what is
// specific, so a placeholder can never be shown as the name of a show.
function cacheGroupName(episodes) {
  const api = globalThis.LSTEpisodeIdentity;
  for (const cache of episodes) {
    const named = api?.showNameFromTitle
      ? api.showNameFromTitle(cache?.showName || "")
      : (cache?.showName || "");
    if (!named) continue;
    if (!api?.isSpecificName || api.isSpecificName(named)) return named;
  }
  return cacheShowName(episodes[0]);
}

const APPEARANCE_DEFAULTS = {
  subtitleHorizontalPosition: "center",
  subtitleVerticalPosition: 9,
  subtitleMaxWidth: 92,
  translatedFontSize: 36,
  originalFontSize: 30,
  subtitleBackgroundOpacity: 58,
  subtitleTimingOffsetMs: 0
};

const RANGE_FORMATTERS = {
  subtitleVerticalPosition: (value) => `${value}%`,
  subtitleMaxWidth: (value) => `${value}%`,
  translatedFontSize: (value) => `${value} px`,
  originalFontSize: (value) => `${value} px`,
  subtitleBackgroundOpacity: (value) => `${value}%`,
  subtitleTimingOffsetMs: (value) => `${Number(value) > 0 ? "+" : ""}${value} ms`
};

async function runtimeMessage(message) {
  const response = await ext.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "Request failed.");
  return response;
}

function setStatus(message, tone = "") {
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
}

function activateSettingsTab(tab, focus = false) {
  const active = SETTINGS_TABS.includes(tab) ? tab : "general";
  document.querySelector(".settings-content").dataset.activeTab = active;
  $("pageEyebrow").textContent = `Settings / ${active}`;
  $("pageTitle").textContent = TAB_DETAILS[active].title;
  $("pageDescription").textContent = TAB_DETAILS[active].description;
  document.title = `${TAB_DETAILS[active].title} · LST Settings`;
  for (const button of document.querySelectorAll("[data-settings-tab]")) {
    const selected = button.dataset.settingsTab === active;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected && focus) button.focus();
  }
  for (const panel of document.querySelectorAll("[data-settings-panel]")) {
    panel.hidden = panel.dataset.settingsPanel !== active;
  }
  history.replaceState(null, "", `#${active}`);
}

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function formatCacheDate(value) {
  if (!value) return "Older cache";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Older cache";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function diagnosticLogJson() {
  return JSON.stringify(diagnosticLogEvents, null, 2);
}

function renderDiagnosticLog() {
  const container = $("diagnosticLog");
  const level = $("diagnosticLevel").value;
  const category = $("diagnosticCategory").value;
  const filtered = diagnosticLogEvents
    .filter((event) => !level || event.level === level)
    .filter((event) => !category || event.category === category)
    .toReversed();

  container.replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "diagnostic-log-empty";
    empty.textContent = diagnosticLogEvents.length
      ? "No events match these filters."
      : "No subtitle events have been recorded yet.";
    container.appendChild(empty);
    return;
  }

  for (const event of filtered) {
    const row = document.createElement("div");
    row.className = "diagnostic-event";
    row.dataset.level = event.level;
    const time = document.createElement("span");
    time.className = "diagnostic-event-time";
    time.textContent = new Date(event.timestamp).toLocaleString();
    const severity = document.createElement("span");
    severity.className = "diagnostic-event-level";
    severity.textContent = event.level;
    const name = document.createElement("span");
    name.className = "diagnostic-event-name";
    name.textContent = `${event.category} · ${event.event}`;
    const context = document.createElement("span");
    context.className = "diagnostic-event-context";
    const location = [
      `video ${event.videoId || "unknown"}`,
      event.videoTime == null ? "" : `at ${Number(event.videoTime).toFixed(3)}s`,
      event.cue ? `cue ${event.cue}` : "",
    ].filter(Boolean).join(" · ");
    const details = Object.keys(event.details || {}).length
      ? JSON.stringify(event.details)
      : "";
    context.textContent = [location, details].filter(Boolean).join("\n");
    row.append(time, severity, name, context);
    container.appendChild(row);
  }
}

async function loadDiagnosticLog() {
  $("diagnosticLogSummary").textContent = "Loading local diagnostic events…";
  const response = await runtimeMessage({ type: "GET_DEBUG_EVENTS" });
  diagnosticLogEvents = response.events || [];
  const categorySelect = $("diagnosticCategory");
  const selectedCategory = categorySelect.value;
  const categories = [...new Set(diagnosticLogEvents.map((event) => event.category))]
    .filter(Boolean)
    .sort();
  categorySelect.replaceChildren(new Option("All categories", ""));
  for (const value of categories) categorySelect.appendChild(new Option(value, value));
  if (categories.includes(selectedCategory)) categorySelect.value = selectedCategory;
  $("diagnosticLogSummary").textContent =
    `${diagnosticLogEvents.length} of ${response.limit} events · ${formatBytes(response.bytes)}`;
  renderDiagnosticLog();
}

function formatTimestamp(milliseconds) {
  if (!Number.isFinite(Number(milliseconds)) || Number(milliseconds) < 0) return "—";
  const total = Number(milliseconds);
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = Math.floor(total % 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:` +
    `${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function cueTimestamp(cue) {
  if (cue.startMs == null) return "—";
  return `${formatTimestamp(cue.startMs)} → ${formatTimestamp(cue.endMs)}`;
}

function preferredCacheCues(detail) {
  const allCues = detail?.cues || [];
  const timedCues = allCues.filter(
    (cue) =>
      !cue.fallback &&
      Number.isFinite(Number(cue.startMs)) &&
      Number(cue.startMs) >= 0,
  );
  return {
    cues: timedCues.length ? timedCues : allCues,
    omittedFallbackCount: timedCues.length
      ? allCues.length - timedCues.length
      : 0,
  };
}

function createCacheItem(cache) {
  const item = document.createElement("article");
  item.className = "cache-item";
  item.dataset.cacheId = cache.cacheId;

  const details = document.createElement("div");
  const episode = document.createElement("div");
  episode.className = "cache-title";
  // Episode identity belongs to episode-identity.js, so the cache list names a
  // video the same way the popup and the page do.
  episode.textContent = cache.episodeName || cache.title ||
    globalThis.LSTEpisodeIdentity?.fallbackEpisodeName(cache.videoId) || "";
  episode.title = episode.textContent;

  const meta = document.createElement("div");
  meta.className = "cache-meta";
  const translatedCues = Number(cache.cueCount) || 0;
  const sourceCues = Number(cache.sourceCueCount) || 0;
  const complete = sourceCues > 0 && translatedCues >= sourceCues;
  const cueLabel = sourceCues >= translatedCues && sourceCues > 0
    ? `${translatedCues}/${sourceCues} translated cues`
    : `${translatedCues} translated cues`;
  const cacheState = document.createElement("span");
  cacheState.className = "cache-complete";
  cacheState.textContent = complete ? "Completed" : "Cached";
  meta.appendChild(cacheState);
  for (const value of [
    cueLabel,
    formatBytes(cache.bytes),
    `${PROVIDER_NAMES[cache.provider] || "Ollama"} · ${cache.model || "Unknown model"}`,
    cache.targetLanguage || "Unknown language",
    formatCacheDate(cache.updatedAt)
  ]) {
    const part = document.createElement("span");
    part.textContent = value;
    meta.appendChild(part);
  }
  details.append(episode, meta);

  const actions = document.createElement("div");
  actions.className = "cache-item-actions";
  for (const [action, label, className] of [
    ["preview", "Preview", "quiet"],
    ["export", "Export TSV", "quiet"],
    ["remove", "Remove", "cache-remove"]
  ]) {
    const button = document.createElement("button");
    button.className = className;
    button.type = "button";
    button.dataset.cacheAction = action;
    button.textContent = label;
    button.setAttribute("aria-label", `${label} ${episode.textContent}`);
    if (action === "preview") button.setAttribute("aria-expanded", "false");
    actions.appendChild(button);
  }

  const preview = document.createElement("div");
  preview.className = "cache-preview";
  preview.hidden = true;
  item.append(details, actions, preview);
  return item;
}

function renderCacheLibrary(caches, totalBytes) {
  const list = $("cacheList");
  list.replaceChildren();
  const groups = new Map();
  for (const cache of caches) {
    const key = cacheShowKey(cache);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(cache);
  }
  const episodeLabel = `${caches.length} ready`;
  const byteLabel = `${formatBytes(totalBytes)} used`;
  $("cacheShowCount").textContent = `${groups.size} cached`;
  $("cacheEpisodeCount").textContent = episodeLabel;
  $("cacheByteCount").textContent = byteLabel;
  $("cacheStorageSummary").textContent = caches.length
    ? `${caches.length} episode${caches.length === 1 ? "" : "s"} · ${formatBytes(totalBytes)}`
    : "No episodes";
  const storageBadge = $("storageBadge");
  storageBadge.textContent = String(caches.length);
  storageBadge.hidden = caches.length === 0;
  $("cacheSummary").textContent = caches.length
    ? `${caches.length} cached episode${caches.length === 1 ? "" : "s"} · ${formatBytes(totalBytes)}`
    : "No translated episodes are cached yet.";

  if (!caches.length) {
    const empty = document.createElement("div");
    empty.className = "cache-empty";
    empty.textContent = "Precompute an episode from the LST popup and it will appear here.";
    list.appendChild(empty);
    return;
  }

  for (const episodes of groups.values()) {
    const group = document.createElement("section");
    group.className = "cache-show";
    const heading = document.createElement("h3");
    heading.className = "cache-show-title";
    const headingName = document.createElement("span");
    headingName.textContent = cacheGroupName(episodes);
    const headingCount = document.createElement("span");
    headingCount.className = "cache-show-count";
    headingCount.textContent = `${episodes.length} episode${episodes.length === 1 ? "" : "s"}`;
    heading.append(headingName, headingCount);
    const episodeList = document.createElement("div");
    episodeList.className = "cache-episodes";
    for (const cache of episodes) episodeList.appendChild(createCacheItem(cache));
    group.append(heading, episodeList);
    list.appendChild(group);
  }
}

async function loadCacheDetails(cacheId) {
  return runtimeMessage({ type: "GET_TRANSLATION_CACHE", cacheId });
}

function renderCachePreview(container, detail) {
  container.replaceChildren();
  const { cues } = preferredCacheCues(detail);
  if (!cues.length) {
    container.textContent = "No translated cues are stored in this cache.";
    return;
  }

  const tableWrap = document.createElement("div");
  tableWrap.className = "cache-preview-table-wrap";
  const table = document.createElement("table");
  table.className = "cache-preview-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Timestamp", "Original", "Translation"]) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    headRow.appendChild(cell);
  }
  head.appendChild(headRow);

  const body = document.createElement("tbody");
  for (const cue of cues) {
    const row = document.createElement("tr");
    for (const value of [cueTimestamp(cue), cue.sourceText, cue.translatedText]) {
      const cell = document.createElement("td");
      cell.textContent = value || "—";
      row.appendChild(cell);
    }
    body.appendChild(row);
  }
  table.append(head, body);
  tableWrap.appendChild(table);
  container.appendChild(tableWrap);
}

function exportCache(detail) {
  const metadata = detail.metadata || {};
  const { cues, omittedFallbackCount } = preferredCacheCues(detail);
  const quote = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const rows = [
    ["Timestamp", "Untranslated text", "Translated text"],
    ...cues.map((cue) => [
      cueTimestamp(cue),
      cue.sourceText,
      cue.translatedText
    ])
  ];
  const contents = rows.map((row) => row.map(quote).join("\t")).join("\n");
  const filename = [metadata.showName, metadata.episodeName, metadata.targetLanguage]
    .filter(Boolean)
    .join(" - ")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim() || "lst-translation";
  const url = URL.createObjectURL(new Blob(
    ["\uFEFF", contents],
    { type: "text/tab-separated-values;charset=utf-8" }
  ));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${filename}.tsv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return omittedFallbackCount;
}

async function loadCacheLibrary() {
  $("cacheSummary").textContent = "Loading cached episodes…";
  const response = await runtimeMessage({ type: "LIST_TRANSLATION_CACHES" });
  renderCacheLibrary(response.caches || [], response.totalBytes || 0);
}

function clampNumber(id, fallback) {
  const input = $(id);
  const min = Number(input.min);
  const max = Number(input.max);
  const value = Number(input.value);
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : fallback));
}

function updatePreview() {
  for (const [id, format] of Object.entries(RANGE_FORMATTERS)) {
    $(`${id}Output`).textContent = format($(id).value);
  }

  const preview = $("subtitlePreview");
  const original = $("previewOriginal");
  const translated = $("previewTranslated");
  const alignment = $("subtitleHorizontalPosition").value;
  const opacity = clampNumber("subtitleBackgroundOpacity", 58) / 100;

  preview.style.bottom = `${clampNumber("subtitleVerticalPosition", 9)}%`;
  preview.style.width = `${clampNumber("subtitleMaxWidth", 92)}%`;
  preview.style.textAlign = alignment;
  preview.style.left = alignment === "right" ? "auto" : "4%";
  preview.style.right = alignment === "right" ? "4%" : "auto";
  preview.style.transform = "none";
  preview.style.opacity = $("enabled").checked ? "1" : ".28";

  original.style.display = $("showOriginal").checked ? "block" : "none";
  translated.style.display = $("showTranslated").checked ? "block" : "none";
  original.style.fontSize = `${Math.max(11, clampNumber("originalFontSize", 30) * .72)}px`;
  translated.style.fontSize = `${Math.max(13, clampNumber("translatedFontSize", 36) * .72)}px`;

  for (const line of [original, translated]) {
    line.style.background = `rgba(0, 0, 0, ${opacity})`;
    line.style.marginLeft = alignment === "left" ? "0" : "auto";
    line.style.marginRight = alignment === "right" ? "0" : "auto";
  }
}

function markUnsaved() {
  setStatus("Unsaved changes");
  updatePreview();
}

function applyAppearance(values) {
  for (const [id, fallback] of Object.entries(APPEARANCE_DEFAULTS)) {
    $(id).value = values[id] ?? fallback;
  }
  updatePreview();
}

async function load() {
  const response = await runtimeMessage({ type: "GET_SETTINGS" });
  const s = response.settings;

  const runningVersion = ext.runtime.getManifest().version;
  $("runningVersion").textContent = `Running v${runningVersion}`;
  $("extensionVersion").textContent = runningVersion;

  $("ollamaUrl").value = s.ollamaUrl || "http://localhost:11434";
  $("provider").value = PROVIDER_NAMES[s.provider] ? s.provider : "ollama";
  providerModels.ollama = s.ollamaModel || (s.provider === "ollama" ? s.model : "") || DEFAULT_MODEL;
  providerModels.deepseek = s.deepseekModel || (s.provider === "deepseek" ? s.model : "") || "";
  providerModels.gemini = s.geminiModel || (s.provider === "gemini" ? s.model : "") || "";
  configuredKeys = (await runtimeMessage({ type: "GET_PROVIDER_KEY_STATUS" })).configured;
  renderProvider();
  $("targetLanguage").value = s.targetLanguage || "English";
  $("enabled").checked = s.enabled !== false;
  $("hideNativeSubtitles").checked = hidesNativeSubtitles(s) !== false;
  $("showNativeWhenTargetLanguage").checked = s.showNativeWhenTargetLanguage !== false;
  $("hudPosition").value = HUD_POSITIONS.includes(s.hudPosition) ? s.hudPosition : "";
  renderServices(s);
  $("showOriginal").checked = s.showOriginal === true;
  $("showTranslated").checked = s.showTranslated !== false;
  $("showStatusMessages").checked = s.showStatusMessages !== false;
  $("autoTranslateAhead").checked = s.autoTranslateAhead !== false;
  $("useTranslationContext").checked = s.useTranslationContext === true;
  renderContextLevel(s.contextLevel);
  $("verifyTranslations").checked = s.verifyTranslations !== false;
  $("showDebugPanel").checked = s.showDebugPanel === true;
  $("debugPanelAlwaysOnTop").checked = s.debugPanelAlwaysOnTop === true;
  $("showQuickPills").checked = s.showQuickPills !== false;
  $("autoMinimizeControls").checked = s.autoMinimizeControls !== false;
  $("controlsMinimizeDelaySeconds").value = Math.min(
    30,
    Math.max(1, Number(s.controlsMinimizeDelaySeconds) || 2),
  );
  $("showTranscriptSidebar").checked = s.showTranscriptSidebar === true;
  $("lookAheadSeconds").value = Math.max(30, Number(s.lookAheadSeconds) || 30);
  $("batchSize").value = s.batchSize ?? 8;
  $("minimumSubtitleDisplaySeconds").value = s.minimumSubtitleDisplaySeconds ?? 2;
  $("maximumVisibleSubtitles").value = s.maximumVisibleSubtitles ?? 2;
  $("requestTimeoutSeconds").value = s.requestTimeoutSeconds ?? 75;
  $("customTranslationPrompt").value = s.customTranslationPrompt || ORIGINAL_TRANSLATION_PROMPT;
  $("modelSummary").textContent = providerModels[$("provider").value] || "No model selected";
  applyAppearance(s);
  await loadCacheLibrary();
  await loadDiagnosticLog();
  await refreshImportSection();
  $("pullModelName").value = providerModels.ollama;

  try {
    await refreshModels(providerModels[$("provider").value]);
  } catch (error) {
    $("connectionState").textContent = "Unavailable";
    const select = $("model");
    select.replaceChildren();
    const option = document.createElement("option");
    option.value = providerModels[$("provider").value] || "";
    option.textContent = option.value || "No model selected";
    select.appendChild(option);
    setStatus(`Could not load ${PROVIDER_NAMES[$("provider").value]} models: ${error.message}`, "error");
  }
}

function renderUpdateAvailability(result = {}) {
  const status = typeof result === "string" ? result : result.status;
  const version = typeof result === "object" ? result.version : "";
  const output = $("updateAvailability");
  output.classList.toggle("success-text", status === "no_update");
  if (status === "update_available") {
    output.textContent = version
      ? `Version ${version} is available; your browser will install it automatically.`
      : "A newer version is available; your browser will install it automatically.";
  } else if (status === "no_update") {
    output.textContent = "You are running the newest version available to this browser.";
  } else if (status === "throttled") {
    output.textContent = "Checked recently; your browser will check again automatically.";
  } else {
    output.textContent = "Update status is unavailable; your browser still checks automatically.";
  }
}

async function checkForUpdates() {
  const button = $("checkForUpdates");
  button.disabled = true;
  $("updateAvailability").textContent = "Checking with your browser…";
  try {
    if (typeof ext.runtime.requestUpdateCheck !== "function") {
      throw new Error("This browser does not expose manual extension update checks.");
    }
    renderUpdateAvailability(await ext.runtime.requestUpdateCheck());
  } catch (error) {
    $("updateAvailability").textContent =
      `${error.message} Your browser still checks for extension updates automatically.`;
  } finally {
    button.disabled = false;
  }
}

function renderProvider() {
  const provider = $("provider").value;
  const remote = provider !== "ollama";
  $("ollamaFields").hidden = remote;
  $("remoteFields").hidden = !remote;
  $("modelDownload").hidden = remote;
  $("providerSummary").textContent = PROVIDER_NAMES[provider];
  $("privacySummary").textContent = remote ? "Remote provider" : "Local endpoint";
  $("environmentEndpoint").textContent = remote ? PROVIDER_NAMES[provider] : "Local Ollama";
  $("modelLabel").textContent = remote ? "Provider model" : "Installed model";
  $("providerHelp").textContent = remote
    ? `Subtitle text is sent to ${PROVIDER_NAMES[provider]}. Requests may use your API quota or incur charges.`
    : "Subtitles are sent to your Ollama endpoint.";
  $("providerApiKey").value = "";
  if (remote) $("providerKeyStatus").textContent = configuredKeys[provider]
    ? "Key saved on this device. Enter a new key to replace it."
    : "No key saved. Enter a key and choose Save key before refreshing models.";
}

async function refreshModels(selected = $("model").value) {
  const provider = $("provider").value;
  setStatus(`Loading ${PROVIDER_NAMES[provider]} models…`);
  const response = await runtimeMessage({
    type: "GET_MODELS",
    provider,
    ollamaUrl: $("ollamaUrl").value.trim()
  });
  if (provider !== $("provider").value) return;

  const select = $("model");
  select.replaceChildren();

  if (!response.models.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No models found";
    select.appendChild(option);
  } else {
    for (const model of response.models) {
      const option = document.createElement("option");
      option.value = model.name;
      const meta = [model.parameterSize, model.quantization].filter(Boolean).join(" · ");
      option.textContent = meta ? `${model.name} — ${meta}` : model.name;
      select.appendChild(option);
    }
  }
  if (selected) {
    if (![...select.options].some((option) => option.value === selected)) {
      const option = document.createElement("option");
      option.value = selected;
      option.textContent = `${selected} — unavailable`;
      select.prepend(option);
    }
    select.value = selected;
  }

  $("connectionState").textContent = "Connected";
  providerModels[provider] = select.value;
  $("modelSummary").textContent = select.value || "No model selected";
  setStatus(`Found ${response.models.length} ${PROVIDER_NAMES[provider]} model${response.models.length === 1 ? "" : "s"}.`, "success");
}

function renderPullProgress(message) {
  const progress = $("pullProgress");
  const bar = $("pullProgressBar");
  const text = $("pullProgressText");
  const percent = Math.max(0, Math.min(100, Number(message.percent || 0)));

  progress.style.display = "block";
  progress.setAttribute("aria-hidden", "false");
  bar.style.width = `${percent}%`;
  text.textContent = percent
    ? `${message.status || "Downloading…"} · ${percent}%`
    : message.status || "Preparing download…";
}

function collectSettings() {
  providerModels[$("provider").value] = $("model").value;
  return {
    customTranslationPrompt:
      $("customTranslationPrompt").value.trim() === ORIGINAL_TRANSLATION_PROMPT
        ? ""
        : $("customTranslationPrompt").value.trim(),
    provider: $("provider").value,
    ollamaModel: providerModels.ollama,
    deepseekModel: providerModels.deepseek,
    geminiModel: providerModels.gemini,
    ollamaUrl: $("ollamaUrl").value.trim().replace(/\/+$/, ""),
    model: providerModels[$("provider").value],
    targetLanguage: $("targetLanguage").value.trim() || "English",
    enabled: $("enabled").checked,
    hideNativeSubtitles: $("hideNativeSubtitles").checked,
    showNativeWhenTargetLanguage: $("showNativeWhenTargetLanguage").checked,
    enabledSites: collectEnabledSites(),
    hudPosition: $("hudPosition").value,
    showOriginal: $("showOriginal").checked,
    showTranslated: $("showTranslated").checked,
    showStatusMessages: $("showStatusMessages").checked,
    autoTranslateAhead: $("autoTranslateAhead").checked,
    useTranslationContext: $("useTranslationContext").checked,
    contextLevel:
      globalThis.LSTTranslationContext?.resolveBudget($("contextLevel").value).id ||
      "standard",
    verifyTranslations: $("verifyTranslations").checked,
    showDebugPanel: $("showDebugPanel").checked,
    debugPanelAlwaysOnTop: $("debugPanelAlwaysOnTop").checked,
    showQuickPills: $("showQuickPills").checked,
    autoMinimizeControls: $("autoMinimizeControls").checked,
    controlsMinimizeDelaySeconds: Math.min(
      30,
      Math.max(1, clampNumber("controlsMinimizeDelaySeconds", 2)),
    ),
    showTranscriptSidebar: $("showTranscriptSidebar").checked,
    lookAheadSeconds: clampNumber("lookAheadSeconds", 30),
    batchSize: clampNumber("batchSize", 8),
    minimumSubtitleDisplaySeconds: clampNumber("minimumSubtitleDisplaySeconds", 2),
    maximumVisibleSubtitles: Math.round(clampNumber("maximumVisibleSubtitles", 2)),
    requestTimeoutSeconds: clampNumber("requestTimeoutSeconds", 75),
    subtitleHorizontalPosition: $("subtitleHorizontalPosition").value,
    subtitleVerticalPosition: clampNumber("subtitleVerticalPosition", 9),
    subtitleMaxWidth: clampNumber("subtitleMaxWidth", 92),
    translatedFontSize: clampNumber("translatedFontSize", 36),
    originalFontSize: clampNumber("originalFontSize", 30),
    subtitleBackgroundOpacity: clampNumber("subtitleBackgroundOpacity", 58),
    subtitleTimingOffsetMs: clampNumber("subtitleTimingOffsetMs", 0)
  };
}

// Every open tab is offered the reload; the ones without an LST content script
// reject the message and are ignored. Filtering by URL instead would need host
// permission for each service, and messaging needs none. The adapter's host list
// is therefore not consulted here at all: a service it gains is reached by this
// push the moment its content script exists.
async function pushSettingsToOpenTabs() {
  try {
    const tabs = await ext.tabs.query({});
    await Promise.all(tabs.map((tab) => tab.id
      ? ext.tabs.sendMessage(tab.id, { type: "RELOAD_SETTINGS" }).catch(() => {})
      : Promise.resolve()));
  } catch {}
}

// A service row is built from describeSupport(), so adding a service adds a row
// rather than a new layout, and the switch the viewer sees is the switch the
// adapter's detection honours.
// How each way of finding a subtitle track is described, keyed by the adapter's
// own word for it. A service whose capture the adapter has not established says
// so rather than promising a precompute it cannot deliver.
const CAPTURE_LABELS = Object.freeze({
  "url-heuristic": "full-track capture available",
  "playback-resources": "full-track capture available",
  unknown: "realtime captions only; full-track capture unverified",
});

function serviceHelp(service) {
  const capture = CAPTURE_LABELS[service.timedTextCapture] || "realtime captions only";
  return `${service.hosts.join("  ·  ")} — ${capture}.`;
}

function collectEnabledSites() {
  const map = {};
  for (const input of document.querySelectorAll("input[data-service-id]")) {
    map[input.dataset.serviceId] = input.checked;
  }
  return map;
}

// Context amount -------------------------------------------------------------
//
// How much surrounding context a request carries is the viewer's choice, and
// every amount on this page — the names in the select and the sentence under it
// — is read from translation-context.js, so the page cannot state a limit the
// module does not implement. An amount this build no longer offers, or none at
// all, resolves to the level the module would actually use.
function renderContextLevel(stored) {
  const select = $("contextLevel");
  const summary = $("contextLevelSummary");
  const api = globalThis.LSTTranslationContext || null;

  if (api) {
    if (!select.options.length) {
      for (const level of api.contextLevelOptions()) {
        const option = document.createElement("option");
        option.value = level.id;
        option.textContent = level.label;
        select.appendChild(option);
      }
    }
    select.value = api.resolveBudget(stored ?? select.value).id;
  }

  const on = $("useTranslationContext").checked;
  // Nothing to choose while context is off, and a control that looks settable
  // but sends nothing is worse than one that says it is waiting.
  select.disabled = !api || !on;
  summary.textContent = !api
    ? "translation-context.js did not load, so the amount of context cannot be read. Requests carry no reference lines."
    : on
      ? `${api.describeLevelSummary(select.value)} Context is reference-only, and existing cached translations are unchanged.`
      : "Surrounding context is off, so each request carries only the lines it is translating.";
}

function renderServices(settings) {
  const list = $("serviceList");
  if (!list) return;
  const services = globalThis.LSTPlaybackSite?.describeSupport?.() || [];
  list.replaceChildren();

  for (const service of services) {
    const row = document.createElement("div");
    row.className = "switch-row";

    const copy = document.createElement("div");
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = service.label;
    const help = document.createElement("p");
    help.className = "help";
    help.textContent = serviceHelp(service);
    copy.append(label, help);

    const control = document.createElement("label");
    control.className = "switch";
    control.setAttribute("aria-label", `Run LST on ${service.label}`);
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = `service-${service.id}`;
    input.dataset.serviceId = service.id;
    // The map's default is "enabled": a service absent from it is not one the
    // viewer ever turned off.
    input.checked = settings?.enabledSites?.[service.id] !== false;
    input.addEventListener("change", markUnsaved);
    const ui = document.createElement("span");
    ui.className = "switch-ui";
    control.append(input, ui);

    row.append(copy, control);
    list.appendChild(row);
  }
}

// Imported subtitles -------------------------------------------------------
//
// Attaching a subtitle file to an episode is an explicit act, and the file can
// arrive two ways: fetched from a Jimaku entry (two network steps, both behind
// an optional permission asked for at the moment of the first search), or chosen
// from the files already on this device, which involves no network at all. The
// episode is the same in both cases — the one the page says is playing.

let importState = {
  target: null,
  entry: null,
  files: [],
  lastEntries: [],
  translateMode: "auto",
};

function importApi() {
  const api = globalThis.LSTSubtitleImport;
  if (!api) throw new Error("Subtitle import is unavailable in this build.");
  return api;
}

function setImportStatus(message, tone = "") {
  const element = $("importStatus");
  if (!element) return;
  element.textContent = message;
  element.dataset.tone = tone;
}

// What the viewer asked LST to do with the file, over and above what the file's
// own language suggests.
function importTranslateChoice() {
  if (importState.translateMode === "yes") return true;
  if (importState.translateMode === "no") return false;
  return undefined;
}

// The file is read here rather than in the background: the picker belongs to
// this page, and nothing has to be granted for it to work. The bytes are handed
// to the module, which decides what encoding they are in.
function readFileBytes(file) {
  if (typeof file?.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("The file could not be read."));
    reader.readAsArrayBuffer(file);
  });
}

// One sentence for a finished import, whichever source it came from, including
// the case where the file names an episode other than the one playing. That is
// worth saying out loud and never worth refusing: the viewer picked the file.
function importResultMessage(track) {
  const api = importApi();
  const decision = track.translate
    ? "LST will translate it"
    : track.translate === false
      ? `LST will show it as it is (${track.language || "the file's language"})`
      : "LST will decide from the file's language";
  const size = track.cueCount
    ? `${track.cueCount} cues`
    : api.SUBTITLE_FORMATS[track.format]?.label || track.format;
  const match = track.episodeMatch;
  const note =
    match?.reason === "episode-mismatch"
      ? ` Note: the file names episode ${match.fileEpisode}, and this one is ${match.targetEpisode}.`
      : "";
  return `Imported ${track.fileName} for this episode · ${size} · ${decision}.${note}`;
}

// Which hosts an origin list names, for the sentences below. The module owns
// the host names; this page never spells one out.
function importHostNames(origins) {
  return origins.map((origin) => {
    try {
      return new URL(origin).hostname;
    } catch {
      return origin;
    }
  });
}

// Browsers allow an optional host only if the manifest a copy of the extension
// was *loaded* with declared it, and Firefox keeps that manifest for the life of
// the load — a copy loaded before LST declared the two hosts answers the request
// with the browser's own words ("... since it was not declared in the manifest"),
// which name neither the cause nor the fix. So the page reads the manifest it is
// really running under and says what will actually help.
function declaredImportHosts() {
  try {
    const manifest = ext.runtime?.getManifest?.() || {};
    const named =
      "optional_host_permissions" in manifest || "optional_permissions" in manifest;
    // A manifest that never mentions optional hosts cannot be judged: the
    // request below will fail in its own words if the declaration is missing.
    if (!named) return null;
    // Both keys mean the same thing to the browser, and a build may legitimately
    // declare the hosts under the older one.
    return [
      ...(manifest.optional_host_permissions || []),
      ...(manifest.optional_permissions || []),
    ];
  } catch {
    // A manifest that cannot be read is not an accusation either: let the
    // request below speak for itself.
    return null;
  }
}

function declaresImportHosts(origins) {
  const declared = declaredImportHosts();
  if (!declared) return true;
  // The manifest test keeps this list identical to the module's host list, so
  // "is it declared" is a question an exact match can answer.
  return origins.every((origin) => declared.includes(origin));
}

function undeclaredImportMessage() {
  const host = importHostNames([importApi().JIMAKU_ORIGIN])[0];
  return [
    `LST is running from a copy loaded before it declared access to ${host}.`,
    "Reload the extension in your browser (about:debugging → This Firefox → LST → Reload)",
    "or restart the browser, then try again.",
  ].join(" ");
}

function importAccessMessage(error) {
  const message = error?.message || "";
  // The browser's wording for an undeclared host is the one failure a viewer can
  // fix, and the one worth translating into instructions.
  if (!message || /was not declared in the manifest/.test(message)) {
    return undeclaredImportMessage();
  }
  return `LST could not ask for access to Jimaku: ${message}`;
}

// The permission is requested first, inside the click that asked for it: a
// prompt the viewer did not just ask for would be a prompt they cannot place.
// It has to stay the first await of every handler that asks — Firefox marks
// `permissions.request` as requiring user input, and an await before this call
// ends the handler's turn, which the browser then refuses. A test holds both
// halves of that in place.
async function ensureImportAccess() {
  const api = importApi();
  const origins = [...api.HOST_ORIGINS];
  const permissions = ext.permissions;
  if (!permissions?.request) {
    throw new Error("This browser cannot grant access to Jimaku.");
  }
  if (!declaresImportHosts(origins)) {
    throw new Error(undeclaredImportMessage());
  }
  let granted = false;
  try {
    granted = await permissions.request({ origins });
  } catch (error) {
    throw new Error(importAccessMessage(error));
  }
  if (!granted) {
    throw new Error(
      `LST needs permission to reach ${importHostNames(origins).join(" and ")} to import subtitles. Allow it, then try again.`,
    );
  }
}

// Which episode an import would attach to. The page that is playing is the only
// place that knows, so the answer comes from its content script — LST never
// reads a tab's URL, which is what keeps this free of host permissions.
function showKeyFor(showName, siteId) {
  const identity = globalThis.LSTEpisodeIdentity;
  if (identity?.encodeShowKey) return identity.encodeShowKey({ showName, siteId });
  return "";
}

async function importTarget() {
  // The tab the viewer is looking at wins; anything else that is playing is only
  // a fallback, so "importing for" names the episode they meant.
  const tabs = [];
  try {
    tabs.push(...(await ext.tabs.query({ active: true, currentWindow: true })));
  } catch {}
  try {
    const known = new Set(tabs.map((tab) => tab?.id));
    tabs.push(...(await ext.tabs.query({})).filter((tab) => !known.has(tab?.id)));
  } catch {}
  for (const tab of tabs) {
    if (!tab?.id) continue;
    try {
      const response = await ext.tabs.sendMessage(tab.id, { type: "GET_PAGE_STATUS" });
      if (!response?.ok || !response.status) continue;
      const status = response.status;
      if (!status.videoId || status.videoId === "unknown") continue;
      if (!status.enabled) continue;
      return {
        tabId: tab.id,
        videoId: status.videoId,
        siteId: status.siteId,
        showName: status.showName || "",
        episodeName: status.episodeName || "",
        // The number the page itself states, when it states one. File names are
        // matched against it; without it the listing is offered unranked.
        episodeNumber: Number.isInteger(status.episodeNumber) ? status.episodeNumber : null,
        episodeKey: importApi().episodeKeyFor(status.videoId, status.siteId),
        // What Jimaku would be asked about: the show, not this episode of it.
        showKey: showKeyFor(status.showName, status.siteId),
        jimaku: status.jimaku || null,
        imported: status.imported || null,
      };
    } catch {
      // A tab without an LST content script refuses the message; that is how a
      // tab is skipped, and why no URL filter is needed.
    }
  }
  return null;
}

function renderImportTarget() {
  const element = $("importTarget");
  if (!element) return;
  const target = importState.target;
  if (!target) {
    element.dataset.tone = "warn";
    element.textContent =
      "Open a Netflix or Prime Video watch page, then start playing the episode you want subtitles for.";
    return;
  }
  const service = globalThis.LSTPlaybackSite?.labelFor?.(target.siteId) || "this service";
  const episode = target.episodeName || `episode ${target.videoId}`;
  element.dataset.tone = "";
  element.textContent = target.imported
    ? `This episode already uses ${target.imported.fileName} (${target.imported.translate ? "translated" : "shown as it is"}). Choose another file to replace it.`
    : `Importing for ${target.showName || episode} · ${episode} · ${service}.`;
}

function importEntryRow(entry) {
  const row = document.createElement("article");
  row.className = "import-row";

  const copy = document.createElement("div");
  copy.className = "import-row-copy";
  const title = document.createElement("strong");
  title.textContent = entry.displayName;
  copy.appendChild(title);
  const details = [];
  if (entry.englishName && entry.englishName !== entry.displayName) {
    details.push(entry.englishName);
  }
  if (entry.name && entry.name !== entry.displayName) details.push(entry.name);
  if (entry.japaneseName) details.push(entry.japaneseName);
  if (entry.movie) details.push("movie");
  if (entry.notes) details.push(entry.notes);
  if (details.length) {
    const help = document.createElement("p");
    help.className = "help";
    help.textContent = details.join("  ·  ");
    copy.appendChild(help);
  }

  const actions = document.createElement("div");
  actions.className = "import-row-actions";
  const link = document.createElement("a");
  link.className = "secondary";
  link.href = entry.pageUrl;
  link.target = "_blank";
  link.rel = "noreferrer noopener";
  link.textContent = "Open on Jimaku";
  const choose = document.createElement("button");
  choose.className = "secondary";
  choose.type = "button";
  choose.dataset.importEntry = String(entry.entryId);
  choose.textContent = "List files";
  actions.append(link, choose);

  row.append(copy, actions);
  return row;
}

function importFileRow(file) {
  const row = document.createElement("article");
  row.className = "import-row";
  if (!file.supported) row.dataset.unsupported = "true";

  const copy = document.createElement("div");
  copy.className = "import-row-copy";
  const title = document.createElement("strong");
  title.textContent = file.name;
  copy.appendChild(title);
  const facts = [
    file.formatLabel,
    file.episode === null ? "no episode number in the name" : `episode ${file.episode}`,
    file.language || "language not stated",
    file.size ? `${Math.round(file.size / 1024)} KB` : "",
    file.supported ? "" : "cannot be read yet",
  ].filter(Boolean);
  const help = document.createElement("p");
  help.className = "help";
  help.textContent = facts.join("  ·  ");
  copy.appendChild(help);

  const actions = document.createElement("div");
  actions.className = "import-row-actions";
  if (file.supported && file.urlAllowed) {
    const button = document.createElement("button");
    button.className = "secondary";
    button.type = "button";
    button.dataset.importFile = file.url;
    button.textContent = "Use for this episode";
    actions.appendChild(button);
  } else {
    const note = document.createElement("span");
    note.className = "help";
    note.textContent = file.supported
      ? "Not served by Jimaku"
      : `${file.formatLabel} cannot be read yet`;
    actions.appendChild(note);
  }

  row.append(copy, actions);
  return row;
}

function renderImportFiles() {
  const list = $("importFiles");
  if (!list) return;
  list.replaceChildren();
  const files = importState.files;
  if (!files.length) return;

  const recommended = importApi().chooseFileForEpisode(files, importState.target?.episodeNumber, {
    targetLanguage: $("targetLanguage")?.value || "English",
  });
  const recommendedUrl = recommended.file?.url || "";

  for (const file of files) {
    const row = importFileRow(file);
    if (file.url === recommendedUrl) {
      row.dataset.recommended = "true";
      const badge = document.createElement("span");
      badge.className = "state-pill info";
      badge.textContent = "Recommended";
      row.querySelector(".import-row-actions")?.appendChild(badge);
    }
    list.appendChild(row);
  }

  const summary = document.createElement("p");
  summary.className = "help";
  summary.textContent =
    `${files.length} file${files.length === 1 ? "" : "s"} · ` +
    (recommended.file
      ? `recommended: ${recommended.file.name} (${recommended.reason.replaceAll("-", " ")})`
      : `no file for this episode (${recommended.reason.replaceAll("-", " ")})`);
  list.appendChild(summary);
}

function importedTrackRow(track) {
  const row = document.createElement("article");
  row.className = "import-row";

  const copy = document.createElement("div");
  copy.className = "import-row-copy";
  const title = document.createElement("strong");
  title.textContent = track.fileName || "Imported subtitles";
  copy.appendChild(title);
  const decoded = globalThis.LSTEpisodeIdentity?.decodeEpisodeKey?.(track.episodeKey);
  const service = globalThis.LSTPlaybackSite?.labelFor?.(decoded?.siteId) || "Unknown service";
  const facts = [
    track.entryName || (track.entryId ? `entry ${track.entryId}` : ""),
    track.source === "local-file" ? "from a file on this device" : "",
    `${service} episode ${decoded?.videoId || track.episodeKey}`,
    track.cueCount ? `${track.cueCount} cues` : "",
    track.language || "language not stated",
    track.translate === false ? "shown without translating" : "translated",
    // A file made for another release of the episode is shown away from where its
    // own timeline says, and the correction lives with the file, so this is the
    // one place a viewer can see it while not watching.
    track.timingOffsetMs
      ? `shown ${importApi().describeFileTiming(track.timingOffsetMs).label}`
      : "",
    track.importedAt ? `imported ${String(track.importedAt).slice(0, 10)}` : "",
  ].filter(Boolean);
  const help = document.createElement("p");
  help.className = "help";
  help.textContent = facts.join("  ·  ");
  copy.appendChild(help);

  const actions = document.createElement("div");
  actions.className = "import-row-actions";
  const remove = document.createElement("button");
  remove.className = "danger";
  remove.type = "button";
  remove.dataset.removeImport = track.episodeKey;
  remove.textContent = "Remove";
  actions.appendChild(remove);

  row.append(copy, actions);
  return row;
}

async function loadImportedTracks() {
  const list = $("importedList");
  const summary = $("importedSummary");
  if (!list) return;
  try {
    const response = await runtimeMessage({ type: "LIST_IMPORTED_TRACKS" });
    const tracks = response.tracks || [];
    list.replaceChildren();
    if (!tracks.length) {
      if (summary) summary.textContent = "No episode uses an imported subtitle file yet.";
      return;
    }
    if (summary) {
      summary.textContent =
        `${tracks.length} episode${tracks.length === 1 ? "" : "s"} · ` +
        `${formatBytes(response.bytes || 0)} of subtitle files stored on this device`;
    }
    for (const track of tracks) list.appendChild(importedTrackRow(track));
  } catch (error) {
    if (summary) summary.textContent = `Could not read imported subtitles: ${error.message}`;
  }
}

async function refreshImportSection() {
  importState.target = await importTarget();
  if (importState.target) {
    const showName = importApi().queryFromShowName(importState.target.showName);
    if (!$("importQuery").value.trim() && showName) $("importQuery").value = showName;
  }
  renderImportTarget();
  await renderImportKnown();
  await loadImportedTracks();
  try {
    const status = await runtimeMessage({ type: "GET_IMPORT_KEY_STATUS" });
    $("importKeyStatus").textContent = status.configured
      ? "A Jimaku API key is saved in this browser profile."
      : "No key saved. Listing an entry's files needs one; searching does not.";
  } catch {
    // The status line is a convenience; a failure here is not worth a message.
  }
}

async function searchImportEntries() {
  const query = $("importQuery").value.trim();
  if (!query) {
    setImportStatus("Enter a show name to search for.", "error");
    return;
  }
  $("importResults").replaceChildren();
  $("importFiles").replaceChildren();
  importState.entry = null;
  importState.files = [];
  setImportStatus("Searching Jimaku…");
  const response = await runtimeMessage({
    type: "IMPORT_SEARCH",
    query,
    showKey: importState.target?.showKey || "",
    showName: importState.target?.showName || "",
    siteId: importState.target?.siteId || "",
  });
  // The player shows the same answer, so the viewer does not have to come back
  // here to find out what Jimaku held.
  await applyJimakuToPlaybackTabs(response.finding);
  await renderImportKnown(response.finding);
  if (!response.entries.length) {
    setImportStatus(`No Jimaku entry matched “${query}”.`, "warn");
    return;
  }
  importState.lastEntries = response.entries;
  setImportStatus(
    `${response.entries.length} entr${response.entries.length === 1 ? "y" : "ies"} found. ` +
      "Choose the one that matches the show you are watching.",
  );
  for (const entry of response.entries) {
    $("importResults").appendChild(importEntryRow(entry));
  }
}

async function listImportFiles(entryId) {
  const entry = importState.lastEntries?.find((item) => item.entryId === entryId) || null;
  importState.entry = entry;
  $("importFiles").replaceChildren();
  setImportStatus("Listing the entry's files…");
  const response = await runtimeMessage({
    type: "IMPORT_LIST_FILES",
    entryId,
    episode: importState.target?.episodeNumber,
    showKey: importState.target?.showKey || "",
    entryName: entry ? entry.displayName || entry.name || "" : "",
  });
  await applyJimakuToPlaybackTabs(response.finding);
  await renderImportKnown(response.finding);
  importState.files = response.files || [];
  if (!importState.files.length) {
    setImportStatus(
      "That entry has no files listed yet. You can still choose a subtitle file you already have.",
      "warn",
    );
    return;
  }
  renderImportFiles();
  setImportStatus(`Choose the file to use for ${importState.target?.episodeName || "this episode"}.`);
}

// The episode can change while this page is open, so it is resolved again at the
// moment of the import. A file must never be filed under whichever episode
// happened to be playing when the viewer opened their settings.
async function resolveImportTarget() {
  const current = await importTarget();
  if (current) {
    importState.target = current;
    renderImportTarget();
  }
  return importState.target;
}

async function importSelectedFile(fileUrl) {
  const file = importState.files.find((item) => item.url === fileUrl);
  if (!file) return;
  const target = await resolveImportTarget();
  if (!target) {
    setImportStatus("Open a playback page first.", "error");
    return;
  }
  setImportStatus(`Downloading ${file.name}…`);
  const response = await runtimeMessage({
    type: "IMPORT_TRACK",
    episodeKey: target.episodeKey,
    entry: importState.entry,
    file,
    episode: target.episodeNumber,
    translate: importTranslateChoice(),
  });
  setImportStatus(importResultMessage(response.track), "success");
  await applyImportToPlaybackTabs();
  await refreshImportSection();
}

// A file the viewer already downloaded. The text is read in this page and only
// the text is handed over, so this path asks for no permission, makes no
// request, and works with the two hosts still ungranted.
async function importLocalFile(file) {
  const target = await resolveImportTarget();
  if (!target) {
    setImportStatus("Open a Netflix or Prime Video watch page first.", "error");
    return;
  }
  const api = importApi();
  if (Number(file.size) > api.MAX_TRACK_BYTES) {
    setImportStatus(
      `${file.name} is larger than the ${formatBytes(api.MAX_TRACK_BYTES)} LST will store for one episode.`,
      "error",
    );
    return;
  }
  setImportStatus(`Reading ${file.name}…`);
  let text;
  try {
    const decoded = api.decodeSubtitleBytes(new Uint8Array(await readFileBytes(file)));
    if (!decoded.text) {
      setImportStatus(
        decoded.reason === api.DECODE_REASON.empty
          ? `${file.name} is empty.`
          : `${file.name} could not be read as text.`,
        "error",
      );
      return;
    }
    text = decoded.text;
  } catch (error) {
    setImportStatus(`Could not read ${file.name}: ${error.message}`, "error");
    return;
  }
  const response = await runtimeMessage({
    type: "IMPORT_TRACK_TEXT",
    episodeKey: target.episodeKey,
    fileName: file.name,
    size: file.size,
    text,
    episode: target.episodeNumber,
    translate: importTranslateChoice(),
  });
  setImportStatus(importResultMessage(response.track), "success");
  await applyImportToPlaybackTabs();
  await refreshImportSection();
}

// The same fan-out as an import, for the note a search or a listing leaves: the
// player shows what Jimaku holds so the viewer does not have to come back here.
async function applyJimakuToPlaybackTabs(finding) {
  if (!finding) return;
  try {
    const tabs = await ext.tabs.query({});
    await Promise.all(tabs.map((tab) => tab.id
      ? ext.tabs.sendMessage(tab.id, { type: "JIMAKU_CHANGED", finding }).catch(() => {})
      : Promise.resolve()));
  } catch {}
}

async function applyJimakuClearedToPlaybackTabs(showKey) {
  if (!showKey) return;
  try {
    const tabs = await ext.tabs.query({});
    await Promise.all(tabs.map((tab) => tab.id
      ? ext.tabs.sendMessage(tab.id, { type: "JIMAKU_CHANGED", cleared: true, showKey }).catch(() => {})
      : Promise.resolve()));
  } catch {}
}

// What LST learned about this show the last time Jimaku was asked. It is shown
// here because it is also what the player announces on arrival, and a viewer who
// sees the sentence in their player should be able to find where it comes from.
async function renderImportKnown(finding = null) {
  const known = $("importKnown");
  const element = $("importKnownText");
  if (!known || !element) return;
  let note = finding;
  if (!note) {
    const showKey = importState.target?.showKey || "";
    if (!showKey) {
      known.hidden = true;
      return;
    }
    try {
      const response = await runtimeMessage({ type: "GET_JIMAKU_FINDING", showKey });
      note = response?.finding || null;
    } catch {
      known.hidden = true;
      return;
    }
  }
  const described = importApi().describeJimakuFinding(note, { now: Date.now() });
  known.hidden = !described;
  if (described) {
    known.dataset.tone = described.tone;
    element.textContent = `LST remembers: ${described.headline}. ${described.detail}`;
  }
}

// The player picks the change up immediately: the file the viewer just chose
// starts playing without a reload or a seek.
async function applyImportToPlaybackTabs() {  try {
    const tabs = await ext.tabs.query({});
    await Promise.all(tabs.map((tab) => tab.id
      ? ext.tabs.sendMessage(tab.id, { type: "IMPORT_CHANGED" }).catch(() => {})
      : Promise.resolve()));
  } catch {}
}

$("importSearch").addEventListener("click", async () => {
  try {
    await ensureImportAccess();
    await searchImportEntries();
  } catch (error) {
    setImportStatus(error.message, "error");
  }
});

$("importQuery").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  $("importSearch").click();
});

$("importResults").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-import-entry]");
  if (!button) return;
  try {
    await ensureImportAccess();
    await listImportFiles(Number(button.dataset.importEntry));
  } catch (error) {
    setImportStatus(error.message, "error");
  }
});

$("importFiles").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-import-file]");
  if (!button) return;
  try {
    await ensureImportAccess();
    await importSelectedFile(button.dataset.importFile);
  } catch (error) {
    setImportStatus(error.message, "error");
  }
});

$("importTranslate").addEventListener("change", () => {
  importState.translateMode = $("importTranslate").value;
});

// A file the viewer already has needs no permission and no search, so nothing
// stands between the choice and the import.
async function handleLocalSubtitleFile(file) {
  try {
    await importLocalFile(file);
  } catch (error) {
    setImportStatus(error.message, "error");
  } finally {
    // Emptied either way: a picker still holding the last file reports nothing
    // when the same file is chosen again.
    const picker = $("importFile");
    if (picker) picker.value = "";
  }
}

$("importFile").addEventListener("change", () => {
  const file = $("importFile").files?.[0];
  if (file) handleLocalSubtitleFile(file);
});

// Dropping a file is the same gesture as choosing one, and takes the same path.
for (const type of ["dragenter", "dragover"]) {
  $("importLocal").addEventListener(type, (event) => {
    event.preventDefault();
    $("importLocal").dataset.dragging = "true";
  });
}
for (const type of ["dragleave", "dragend"]) {
  $("importLocal").addEventListener(type, () => {
    $("importLocal").dataset.dragging = "false";
  });
}
$("importLocal").addEventListener("drop", (event) => {
  event.preventDefault();
  $("importLocal").dataset.dragging = "false";
  const file = event.dataTransfer?.files?.[0];
  if (file) handleLocalSubtitleFile(file);
});

// A file dropped anywhere else on this page would otherwise open in the tab,
// taking the viewer away from their settings. Only a file drag is intercepted,
// so dropping text into a field still works.
for (const type of ["dragover", "drop"]) {
  document.addEventListener(type, (event) => {
    if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
  });
}

$("importedList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-remove-import]");
  if (!button) return;
  try {
    await runtimeMessage({
      type: "DELETE_IMPORTED_TRACK",
      episodeKey: button.dataset.removeImport,
    });
    setImportStatus("The imported file was removed from this episode.");
    await applyImportToPlaybackTabs();
    await refreshImportSection();
  } catch (error) {
    setImportStatus(error.message, "error");
  }
});

$("saveImportKey").addEventListener("click", async () => {
  const key = $("importKey").value.trim();
  if (!key) {
    setImportStatus("Enter the key first, or use Remove key.", "error");
    return;
  }
  try {
    await runtimeMessage({ type: "SET_IMPORT_KEY", key });
    $("importKey").value = "";
    setImportStatus("The Jimaku API key was saved in this browser profile.");
    await refreshImportSection();
  } catch (error) {
    setImportStatus(error.message, "error");
  }
});

$("removeImportKey").addEventListener("click", async () => {
  try {
    await runtimeMessage({ type: "SET_IMPORT_KEY", key: "" });
    setImportStatus("The saved Jimaku API key was removed.");
    await refreshImportSection();
  } catch (error) {
    setImportStatus(error.message, "error");
  }
});

// What Jimaku held for a show is LST's note, not the viewer's history, so it can
// be dropped here — and the player is told to drop it too, rather than going on
// showing a sentence about a note that no longer exists.
$("forgetImportKnown").addEventListener("click", async () => {
  const showKey = importState.target?.showKey || "";
  if (!showKey) return;
  try {
    await runtimeMessage({ type: "DELETE_JIMAKU_FINDING", showKey });
    await applyJimakuClearedToPlaybackTabs(showKey);
    setImportStatus("LST will not mention what Jimaku held for this show again until it is asked.");
    await refreshImportSection();
  } catch (error) {
    setImportStatus(error.message, "error");
  }
});

$("refreshModels").addEventListener("click", () => {
  refreshModels(providerModels[$("provider").value]).catch((error) =>
    setStatus(`Could not load models: ${error.message}`, "error"));
});

$("provider").addEventListener("change", () => {
  renderProvider();
  const selected = providerModels[$("provider").value];
  $("model").replaceChildren(new Option(selected || "Refresh models to choose", selected || ""));
  $("modelSummary").textContent = selected || "No model selected";
  const provider = $("provider").value;
  refreshModels(selected).catch((error) => {
    if (provider !== $("provider").value) return;
    $("connectionState").textContent = "Unavailable";
    setStatus(`Could not load models: ${error.message}`, "error");
  });
});

$("saveProviderKey").addEventListener("click", async () => {
  const provider = $("provider").value;
  const key = $("providerApiKey").value.trim();
  if (!key) {
    setStatus("Enter an API key first.", "error");
    return;
  }
  try {
    await runtimeMessage({ type: "SET_PROVIDER_KEY", provider, key });
    configuredKeys[provider] = true;
    renderProvider();
    setStatus(`${PROVIDER_NAMES[provider]} key saved on this device.`, "success");
  } catch (error) {
    setStatus(`Could not save key: ${error.message}`, "error");
    return;
  }
  refreshModels(providerModels[provider]).catch((error) =>
    setStatus(`Key saved, but models could not be loaded: ${error.message}`, "error"));
});

$("removeProviderKey").addEventListener("click", async () => {
  const provider = $("provider").value;
  try {
    await runtimeMessage({ type: "SET_PROVIDER_KEY", provider, key: "" });
    configuredKeys[provider] = false;
    renderProvider();
    setStatus(`${PROVIDER_NAMES[provider]} key removed.`, "success");
  } catch (error) {
    setStatus(`Could not remove key: ${error.message}`, "error");
  }
});

$("pullModel").addEventListener("click", async () => {
  const model = $("pullModelName").value.trim();
  if (!model) {
    $("pullProgressText").textContent = "Enter a model name first.";
    $("pullModelName").focus();
    return;
  }

  const button = $("pullModel");
  button.disabled = true;
  button.textContent = "Downloading…";
  renderPullProgress({ status: `Starting ${model}…`, percent: 0 });

  try {
    await runtimeMessage({
      type: "PULL_MODEL",
      model,
      ollamaUrl: $("ollamaUrl").value.trim()
    });
    renderPullProgress({ status: `${model} downloaded`, percent: 100 });
    await refreshModels(model);
    setStatus(`${model} is installed and selected. Save settings to use it.`);
  } catch (error) {
    $("pullProgressText").textContent = `Download failed: ${error.message}`;
    setStatus(`Could not download ${model}.`, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Download";
  }
});

$("resetAppearance").addEventListener("click", () => {
  applyAppearance(APPEARANCE_DEFAULTS);
  setStatus("Appearance reset — save to apply it in open players.");
});

$("resetTranslationPrompt").addEventListener("click", () => {
  $("customTranslationPrompt").value = ORIGINAL_TRANSLATION_PROMPT;
  markUnsaved();
  setStatus("Original translation prompt restored. Save changes to apply it.", "success");
});

$("openSetup").addEventListener("click", () => {
  try {
    ext.tabs.create({ url: ext.runtime.getURL("setup.html") })
      ?.catch?.((error) => setStatus(`Could not open the setup guide: ${error.message}`, "error"));
  } catch (error) {
    setStatus(`Could not open the setup guide: ${error.message}`, "error");
  }
});

$("model").addEventListener("change", () => {
  providerModels[$("provider").value] = $("model").value;
  $("modelSummary").textContent = $("model").value || "No model selected";
});

$("copyOllamaCommand").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("ollamaCommand").textContent);
    setStatus("Ollama command copied.", "success");
  } catch (error) {
    setStatus(`Could not copy the command: ${error.message}`, "error");
  }
});

$("refreshDiagnosticLog").addEventListener("click", () => {
  loadDiagnosticLog().catch((error) =>
    setStatus(`Could not load diagnostic log: ${error.message}`, "error"));
});

for (const id of ["diagnosticLevel", "diagnosticCategory"]) {
  $(id).addEventListener("change", renderDiagnosticLog);
}

$("copyDiagnosticLog").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(diagnosticLogJson());
    setStatus("Diagnostic log copied as JSON.", "success");
  } catch (error) {
    setStatus(`Could not copy diagnostic log: ${error.message}`, "error");
  }
});

$("exportDiagnosticLog").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([diagnosticLogJson()], {
    type: "application/json;charset=utf-8",
  }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `lst-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  setStatus("Diagnostic log exported.", "success");
});

$("clearDiagnosticLog").addEventListener("click", async () => {
  if (!confirm("Clear all locally stored diagnostic events?")) return;
  try {
    await runtimeMessage({ type: "CLEAR_DEBUG_EVENTS" });
    await loadDiagnosticLog();
    setStatus("Diagnostic log cleared.", "success");
  } catch (error) {
    setStatus(`Could not clear diagnostic log: ${error.message}`, "error");
  }
});

$("checkForUpdates").addEventListener("click", checkForUpdates);

$("save").addEventListener("click", async () => {
  try {
    const provider = $("provider").value;
    if (provider !== "ollama" && !configuredKeys[provider]) {
      throw new Error(`Save a ${PROVIDER_NAMES[provider]} API key first.`);
    }
    if (!$("model").value) throw new Error("Choose a translation model first.");
    await runtimeMessage({ type: "SAVE_SETTINGS", settings: collectSettings() });
    await pushSettingsToOpenTabs();
    setStatus("Saved and applied to open player tabs.", "success");
  } catch (error) {
    setStatus(`Save failed: ${error.message}`, "error");
  }
});

$("clearCache").addEventListener("click", async () => {
  if (!confirm("Remove all cached episode translations? This cannot be undone.")) return;
  try {
    const response = await runtimeMessage({ type: "CLEAR_TRANSLATION_CACHE" });
    await loadCacheLibrary();
    setStatus(`Removed ${response.removed} cached episode${response.removed === 1 ? "" : "s"}.`, "success");
  } catch (error) {
    setStatus(`Could not clear cache: ${error.message}`, "error");
  }
});

$("refreshCache").addEventListener("click", () => {
  loadCacheLibrary().catch((error) => setStatus(`Could not load cached episodes: ${error.message}`, "error"));
});

$("cacheList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-cache-action]");
  if (!button) return;
  const item = button.closest("[data-cache-id]");
  const cacheId = item?.dataset.cacheId;
  if (!cacheId) return;
  const action = button.dataset.cacheAction;
  button.disabled = true;

  try {
    if (action === "remove") {
      await runtimeMessage({ type: "DELETE_TRANSLATION_CACHE", cacheId });
      await loadCacheLibrary();
      setStatus("Cached episode removed.", "success");
    } else if (action === "preview") {
      const preview = item.querySelector(".cache-preview");
      if (!preview.hidden) {
        preview.hidden = true;
        button.textContent = "Preview";
        button.setAttribute("aria-expanded", "false");
      } else {
        preview.hidden = false;
        preview.textContent = "Loading translation…";
        button.textContent = "Hide preview";
        button.setAttribute("aria-expanded", "true");
        renderCachePreview(preview, await loadCacheDetails(cacheId));
      }
    } else if (action === "export") {
      const omittedFallbackCount = exportCache(await loadCacheDetails(cacheId));
      setStatus(
        omittedFallbackCount
          ? `Translation exported as TSV · ${omittedFallbackCount} fallback ` +
            `entr${omittedFallbackCount === 1 ? "y" : "ies"} omitted.`
          : "Translation exported as TSV.",
        "success",
      );
    }
  } catch (error) {
    setStatus(`Cache action failed: ${error.message}`, "error");
  } finally {
    if (button.isConnected) button.disabled = false;
  }
});

$("useTranslationContext").addEventListener("change", () => renderContextLevel());
$("contextLevel").addEventListener("change", () => renderContextLevel());

document.querySelectorAll("input:not([data-transient]), select:not([data-transient])").forEach((control) => {
  control.addEventListener(control.type === "range" ? "input" : "change", markUnsaved);
});

document.querySelector(".settings-tabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-settings-tab]")?.dataset.settingsTab;
  if (tab) activateSettingsTab(tab);
});

document.querySelector(".settings-tabs").addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const current = SETTINGS_TABS.indexOf(event.target.dataset.settingsTab);
  if (current < 0) return;
  event.preventDefault();
  const next = event.key === "Home"
    ? 0
    : event.key === "End"
      ? SETTINGS_TABS.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + SETTINGS_TABS.length) % SETTINGS_TABS.length;
  activateSettingsTab(SETTINGS_TABS[next], true);
});

ext.runtime.onMessage.addListener((message) => {
  if (message?.type === "MODEL_PULL_PROGRESS") renderPullProgress(message);
});

// Browsers already check extension stores on their own. Reflect an update they
// have discovered instead of adding another polling request or external host.
ext.runtime.onUpdateAvailable?.addListener((details) => {
  renderUpdateAvailability({ status: "update_available", version: details?.version });
});

activateSettingsTab(location.hash.slice(1));
// The popup's "Import subtitles" button opens this page at the import card, so
// a viewer who clicked there does not have to find it.
async function openAtHash() {
  if (location.hash !== "#import") return;
  activateSettingsTab("subtitles");
  $("importCard")?.scrollIntoView({ block: "start" });
  $("importQuery")?.focus();
}

load()
  .then(openAtHash)
  .catch((error) => setStatus(`Startup error: ${error.message}`, "error"));
