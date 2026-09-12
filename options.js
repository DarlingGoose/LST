const ext = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);
const statusEl = $("status");

const APPEARANCE_DEFAULTS = {
  subtitleHorizontalPosition: "center",
  subtitleVerticalPosition: 9,
  subtitleMaxWidth: 92,
  translatedFontSize: 36,
  originalFontSize: 30,
  subtitleBackgroundOpacity: 58
};

const RANGE_FORMATTERS = {
  subtitleVerticalPosition: (value) => `${value}%`,
  subtitleMaxWidth: (value) => `${value}%`,
  translatedFontSize: (value) => `${value} px`,
  originalFontSize: (value) => `${value} px`,
  subtitleBackgroundOpacity: (value) => `${value}%`
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

  for (const cache of caches) {
    const item = document.createElement("article");
    item.className = "cache-item";

    const details = document.createElement("div");
    const title = document.createElement("div");
    title.className = "cache-title";
    title.textContent = cache.title || `Netflix episode ${cache.videoId || "unknown"}`;
    title.title = title.textContent;

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

    const remove = document.createElement("button");
    remove.className = "cache-remove";
    remove.type = "button";
    remove.dataset.cacheId = cache.cacheId;
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove cached translations for ${title.textContent}`);

    details.append(title, meta);
    item.append(details, remove);
    list.appendChild(item);
  }
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
  $("showSubtitleControls").checked = s.showSubtitleControls === true;
  $("lookAheadSeconds").value = Math.max(30, Number(s.lookAheadSeconds) || 30);
  $("batchSize").value = s.batchSize ?? 8;
  $("requestTimeoutSeconds").value = s.requestTimeoutSeconds ?? 75;
  applyAppearance(s);
  await loadCacheLibrary();

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
    if (selected && [...select.options].some((option) => option.value === selected)) {
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
    showSubtitleControls: $("showSubtitleControls").checked,
    lookAheadSeconds: clampNumber("lookAheadSeconds", 30),
    batchSize: clampNumber("batchSize", 8),
    requestTimeoutSeconds: clampNumber("requestTimeoutSeconds", 75),
    subtitleHorizontalPosition: $("subtitleHorizontalPosition").value,
    subtitleVerticalPosition: clampNumber("subtitleVerticalPosition", 9),
    subtitleMaxWidth: clampNumber("subtitleMaxWidth", 92),
    translatedFontSize: clampNumber("translatedFontSize", 36),
    originalFontSize: clampNumber("originalFontSize", 30),
    subtitleBackgroundOpacity: clampNumber("subtitleBackgroundOpacity", 58)
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
  const button = event.target.closest("[data-cache-id]");
  if (!button) return;
  button.disabled = true;
  try {
    await runtimeMessage({
      type: "DELETE_TRANSLATION_CACHE",
      cacheId: button.dataset.cacheId
    });
    await loadCacheLibrary();
    setStatus("Cached episode removed.", "success");
  } catch (error) {
    button.disabled = false;
    setStatus(`Could not remove cached episode: ${error.message}`, "error");
  }
});

document.querySelectorAll("input:not([data-transient]), select").forEach((control) => {
  control.addEventListener(control.type === "range" ? "input" : "change", markUnsaved);
});

ext.runtime.onMessage.addListener((message) => {
  if (message?.type === "MODEL_PULL_PROGRESS") renderPullProgress(message);
});

load().catch((error) => setStatus(`Startup error: ${error.message}`, "error"));
