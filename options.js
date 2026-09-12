const ext = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const DEFAULT_MODEL = "translategemma:4b";
const SETTINGS_TABS = ["general", "subtitles", "storage", "advanced"];

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
  document.querySelector(".layout").dataset.activeTab = active;
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
  const cueLabel = sourceCues >= translatedCues && sourceCues > 0
    ? `${translatedCues}/${sourceCues} translated cues`
    : `${translatedCues} translated cues`;
  for (const value of [
    cueLabel,
    formatBytes(cache.bytes),
    cache.model || "Unknown model",
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
    heading.textContent = showName;
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
  const cues = detail.cues || [];
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
  const quote = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const rows = [
    ["Timestamp", "Untranslated text", "Translated text"],
    ...(detail.cues || []).map((cue) => [
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

  $("ollamaUrl").value = s.ollamaUrl || "http://localhost:11434";
  $("targetLanguage").value = s.targetLanguage || "English";
  $("enabled").checked = s.enabled !== false;
  $("hideNetflixSubtitles").checked = s.hideNetflixSubtitles !== false;
  $("showOriginal").checked = s.showOriginal === true;
  $("showTranslated").checked = s.showTranslated !== false;
  $("showStatusMessages").checked = s.showStatusMessages !== false;
  $("autoTranslateAhead").checked = s.autoTranslateAhead !== false;
  $("showDebugPanel").checked = s.showDebugPanel === true;
  $("debugPanelAlwaysOnTop").checked = s.debugPanelAlwaysOnTop === true;
  $("showQuickPills").checked = s.showQuickPills !== false;
  $("lookAheadSeconds").value = Math.max(30, Number(s.lookAheadSeconds) || 30);
  $("batchSize").value = s.batchSize ?? 8;
  $("minimumSubtitleDisplaySeconds").value = s.minimumSubtitleDisplaySeconds ?? 2;
  $("maximumVisibleSubtitles").value = s.maximumVisibleSubtitles ?? 2;
  $("requestTimeoutSeconds").value = s.requestTimeoutSeconds ?? 75;
  applyAppearance(s);
  await loadCacheLibrary();
  $("pullModelName").value = s.model || DEFAULT_MODEL;

  try {
    await refreshModels(s.model || "");
  } catch (error) {
    const select = $("model");
    select.replaceChildren();
    const option = document.createElement("option");
    option.value = s.model || "";
    option.textContent = s.model || "No model selected";
    select.appendChild(option);
    setStatus(`Could not reach Ollama: ${error.message}`, "error");
  }
}

async function refreshModels(selected = $("model").value) {
  setStatus("Loading installed Ollama models…");
  const response = await runtimeMessage({
    type: "GET_MODELS",
    ollamaUrl: $("ollamaUrl").value.trim()
  });

  const select = $("model");
  select.replaceChildren();

  if (!response.models.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No installed models found";
    select.appendChild(option);
  } else {
    for (const model of response.models) {
      const option = document.createElement("option");
      option.value = model.name;
      const meta = [model.parameterSize, model.quantization].filter(Boolean).join(" · ");
      option.textContent = meta ? `${model.name} — ${meta}` : model.name;
      select.appendChild(option);
    }
    if (selected) {
      if (![...select.options].some((option) => option.value === selected)) {
        const option = document.createElement("option");
        option.value = selected;
        option.textContent = `${selected} — not installed`;
        select.prepend(option);
      }
      select.value = selected;
    }
  }

  setStatus(`Found ${response.models.length} installed model${response.models.length === 1 ? "" : "s"}.`, "success");
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
  return {
    ollamaUrl: $("ollamaUrl").value.trim().replace(/\/+$/, ""),
    model: $("model").value,
    targetLanguage: $("targetLanguage").value.trim() || "English",
    enabled: $("enabled").checked,
    hideNetflixSubtitles: $("hideNetflixSubtitles").checked,
    showOriginal: $("showOriginal").checked,
    showTranslated: $("showTranslated").checked,
    showStatusMessages: $("showStatusMessages").checked,
    autoTranslateAhead: $("autoTranslateAhead").checked,
    showDebugPanel: $("showDebugPanel").checked,
    debugPanelAlwaysOnTop: $("debugPanelAlwaysOnTop").checked,
    showQuickPills: $("showQuickPills").checked,
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
  refreshModels().catch((error) => setStatus(`Could not reach Ollama: ${error.message}`, "error"));
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

$("save").addEventListener("click", async () => {
  try {
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
      exportCache(await loadCacheDetails(cacheId));
      setStatus("Translation exported as TSV.", "success");
    }
  } catch (error) {
    setStatus(`Cache action failed: ${error.message}`, "error");
  } finally {
    if (button.isConnected) button.disabled = false;
  }
});

document.querySelectorAll("input:not([data-transient]), select").forEach((control) => {
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
