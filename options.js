const ext = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const DEFAULT_MODEL = "translategemma:4b";
const PROVIDER_NAMES = { ollama: "Ollama", deepseek: "DeepSeek", gemini: "Gemini" };
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
    description: "Preview the exact hierarchy viewers will see on Netflix."
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
  episode.textContent = cache.episodeName || cache.title ||
    `Episode ${cache.videoId || "unknown"}`;
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
  const showNames = new Set(caches.map((cache) => cache.showName || "Netflix"));
  const episodeLabel = `${caches.length} ready`;
  const byteLabel = `${formatBytes(totalBytes)} used`;
  $("cacheShowCount").textContent = `${showNames.size} cached`;
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

  const groups = new Map();
  for (const cache of caches) {
    const showName = cache.showName || "Netflix";
    if (!groups.has(showName)) groups.set(showName, []);
    groups.get(showName).push(cache);
  }

  for (const [showName, episodes] of groups) {
    const group = document.createElement("section");
    group.className = "cache-show";
    const heading = document.createElement("h3");
    heading.className = "cache-show-title";
    const headingName = document.createElement("span");
    headingName.textContent = showName;
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

  $("extensionVersion").textContent = ext.runtime.getManifest().version;

  $("ollamaUrl").value = s.ollamaUrl || "http://localhost:11434";
  $("provider").value = PROVIDER_NAMES[s.provider] ? s.provider : "ollama";
  providerModels.ollama = s.ollamaModel || (s.provider === "ollama" ? s.model : "") || DEFAULT_MODEL;
  providerModels.deepseek = s.deepseekModel || (s.provider === "deepseek" ? s.model : "") || "";
  providerModels.gemini = s.geminiModel || (s.provider === "gemini" ? s.model : "") || "";
  configuredKeys = (await runtimeMessage({ type: "GET_PROVIDER_KEY_STATUS" })).configured;
  renderProvider();
  $("targetLanguage").value = s.targetLanguage || "English";
  $("enabled").checked = s.enabled !== false;
  $("hideNetflixSubtitles").checked = s.hideNetflixSubtitles !== false;
  $("showOriginal").checked = s.showOriginal === true;
  $("showTranslated").checked = s.showTranslated !== false;
  $("showStatusMessages").checked = s.showStatusMessages !== false;
  $("autoTranslateAhead").checked = s.autoTranslateAhead !== false;
  $("useTranslationContext").checked = s.useTranslationContext === true;
  $("showDebugPanel").checked = s.showDebugPanel === true;
  $("debugPanelAlwaysOnTop").checked = s.debugPanelAlwaysOnTop === true;
  $("showQuickPills").checked = s.showQuickPills !== false;
  $("showTranscriptSidebar").checked = s.showTranscriptSidebar === true;
  $("lookAheadSeconds").value = Math.max(30, Number(s.lookAheadSeconds) || 30);
  $("batchSize").value = s.batchSize ?? 8;
  $("minimumSubtitleDisplaySeconds").value = s.minimumSubtitleDisplaySeconds ?? 2;
  $("maximumVisibleSubtitles").value = s.maximumVisibleSubtitles ?? 2;
  $("requestTimeoutSeconds").value = s.requestTimeoutSeconds ?? 75;
  $("modelSummary").textContent = providerModels[$("provider").value] || "No model selected";
  applyAppearance(s);
  await loadCacheLibrary();
  await loadDiagnosticLog();
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
    provider: $("provider").value,
    ollamaModel: providerModels.ollama,
    deepseekModel: providerModels.deepseek,
    geminiModel: providerModels.gemini,
    ollamaUrl: $("ollamaUrl").value.trim().replace(/\/+$/, ""),
    model: providerModels[$("provider").value],
    targetLanguage: $("targetLanguage").value.trim() || "English",
    enabled: $("enabled").checked,
    hideNetflixSubtitles: $("hideNetflixSubtitles").checked,
    showOriginal: $("showOriginal").checked,
    showTranslated: $("showTranslated").checked,
    showStatusMessages: $("showStatusMessages").checked,
    autoTranslateAhead: $("autoTranslateAhead").checked,
    useTranslationContext: $("useTranslationContext").checked,
    showDebugPanel: $("showDebugPanel").checked,
    debugPanelAlwaysOnTop: $("debugPanelAlwaysOnTop").checked,
    showQuickPills: $("showQuickPills").checked,
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

async function pushSettingsToNetflixTabs() {
  try {
    const tabs = await ext.tabs.query({ url: "https://www.netflix.com/*" });
    await Promise.all(tabs.map((tab) =>
      tab.id
        ? ext.tabs.sendMessage(tab.id, { type: "RELOAD_SETTINGS" }).catch(() => {})
        : Promise.resolve()
    ));
  } catch {}
}

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
  setStatus("Appearance reset — save to apply it on Netflix.");
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

$("save").addEventListener("click", async () => {
  try {
    const provider = $("provider").value;
    if (provider !== "ollama" && !configuredKeys[provider]) {
      throw new Error(`Save a ${PROVIDER_NAMES[provider]} API key first.`);
    }
    if (!$("model").value) throw new Error("Choose a translation model first.");
    await runtimeMessage({ type: "SAVE_SETTINGS", settings: collectSettings() });
    await pushSettingsToNetflixTabs();
    setStatus("Saved and applied to open Netflix tabs.", "success");
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

activateSettingsTab(location.hash.slice(1));
load().catch((error) => setStatus(`Startup error: ${error.message}`, "error"));
