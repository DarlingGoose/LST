const ext = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);
const hasExtensionApi = Boolean(ext?.runtime?.sendMessage && ext?.tabs?.query);
const LEGACY_HIDE_SUBTITLES_KEY = "hideNetflixSubtitles";

// Episode identity — which names are real and which are placeholders — is
// decided by episode-identity.js so the popup shows the same answer the page
// and the background reached.
function episodeIdentity() {
  return globalThis.LSTEpisodeIdentity || null;
}

function displayShowName(value, fallback = "LST") {
  const api = episodeIdentity();
  return api ? api.preferredName(value, fallback).name : value || fallback;
}

// Which service the active tab is comes from the page itself, through the
// adapter the page uses: the popup asks the content script and reads the
// `siteId` it reports. Reading a tab's URL would need host permission for every
// service, and a popup that guessed from a hostname of its own could disagree
// with the page it is describing.
function siteLabelFor(siteId, fallback = "LST") {
  return globalThis.LSTPlaybackSite?.labelFor?.(siteId) || fallback;
}

// The renamed setting is read through, so an install from before the rename
// keeps its answer. `??` and not `||`: a stored `false` is a real answer.
function hidesNativeSubtitles(settings) {
  if (settings?.hideNativeSubtitles !== undefined) return settings.hideNativeSubtitles;
  if (settings?.[LEGACY_HIDE_SUBTITLES_KEY] !== undefined) {
    return settings[LEGACY_HIDE_SUBTITLES_KEY];
  }
  return true;
}

function isNamedEpisode(value) {
  const api = episodeIdentity();
  return api ? api.isSpecificName(value) : Boolean(value);
}

const state = {
  settings: {
    showTranslated: true,
    showOriginal: false,
    hideNativeSubtitles: true,
    showQuickPills: true,
    showTranscriptSidebar: false,
    subtitleTimingOffsetMs: 0,
    model: "",
    provider: "ollama",
    targetLanguage: "English",
    ollamaUrl: "http://localhost:11434"
  },
  // The imported track this episode is using, as the page reports it, so the
  // timing controls know which clock they move.
  imported: null,
  pollTimer: null
};

async function runtimeMessage(message) {
  const response = await ext.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "Request failed.");
  return response;
}

async function tabMessage(tabId, message) {
  const response = await ext.tabs.sendMessage(tabId, message);
  if (!response?.ok) throw new Error(response?.error || "Request failed.");
  return response;
}

// The active tab must be a page LST is actually running on. Asking it for its
// status is the test: a tab with no LST content script cannot answer, which is
// the same as "not a watch page" for the popup's purposes.
async function activePlaybackTab() {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("Open a Netflix or Prime Video watch page first.");
  try {
    const response = await tabMessage(tab.id, { type: "GET_PAGE_STATUS" });
    return { tab, status: response.status };
  } catch {
    throw new Error("Open a Netflix or Prime Video watch page first.");
  }
}

function formatElapsed(startedAt) {
  if (!startedAt) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatTiming(value = state.settings.subtitleTimingOffsetMs) {
  const timing = Number(value) || 0;
  return `${timing > 0 ? "+" : ""}${timing} ms`;
}

// The timing controls point at one clock: an imported file's own, when one is in
// use for this episode, and the global setting otherwise. Which clock that is
// comes from the module the player asks too, so the two cannot point at different
// ones; the popup only has to know which row to show.
function timingTarget() {
  const api = globalThis.LSTSubtitleImport;
  const imported = state.imported || null;
  if (api?.timingTargetFor) {
    return api.timingTargetFor(imported, {
      globalOffsetMs: Number(state.settings.subtitleTimingOffsetMs) || 0,
    });
  }
  return imported
    ? { scope: "imported-file", episodeKey: imported.episodeKey || "", offsetMs: 0, limitMs: 0 }
    : { scope: "global", episodeKey: "", offsetMs: Number(state.settings.subtitleTimingOffsetMs) || 0, limitMs: 2000 };
}

function renderTiming() {
  const target = timingTarget();
  const importedScope = target.scope !== "global";
  $("timingGlobalSteps").hidden = importedScope;
  $("timingFileSteps").hidden = !importedScope;
  const described = importedScope
    ? globalThis.LSTSubtitleImport?.describeFileTiming?.(target.offsetMs)
    : null;
  const label = described?.label || formatTiming(target.offsetMs);
  $("timingValue").textContent = label;
  $("timingSummary").textContent = importedScope ? `${label} · file` : label;
  $("timingHelp").textContent = importedScope
    ? "Adjust the imported file for this episode."
    : "Adjust LST subtitles in 100 ms steps.";
  const note = $("timingNote");
  note.hidden = !importedScope;
  if (!importedScope) return;
  // The global setting still applies while a file is in use, so a viewer who set
  // it for the service's own track is told it is part of the sum.
  const global = Number(state.settings.subtitleTimingOffsetMs) || 0;
  note.textContent =
    `${described?.sentence || ""}` +
    (global
      ? ` The global timing offset (${global > 0 ? "+" : ""}${global} ms) also applies.`
      : "");
}

function resetPopupScroll() {
  // The document itself never scrolls: the popup is a fixed panel whose middle
  // scrolls, so switching tabs or arriving with a result starts that region at
  // the top rather than leaving it where the last one was scrolled to.
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
  const scroller = $("popupScroll") || document.querySelector("main");
  if (scroller) scroller.scrollTop = 0;
}

function activatePopupTab(tabName, focus = false) {
  const controls = tabName === "controls";
  document.body.dataset.activeTab = controls ? "controls" : "status";
  $("statusPanel").hidden = controls;
  $("controlsPanel").hidden = !controls;
  $("statusTab").setAttribute("aria-selected", String(!controls));
  $("controlsTab").setAttribute("aria-selected", String(controls));
  $("statusTab").tabIndex = controls ? -1 : 0;
  $("controlsTab").tabIndex = controls ? 0 : -1;
  if (focus) $(controls ? "controlsTab" : "statusTab").focus();
  resetPopupScroll();
  requestAnimationFrame(resetPopupScroll);
}

function syncSettingsControls() {
  const provider = state.settings.provider || "ollama";
  const providerName = { ollama: "Ollama", deepseek: "DeepSeek", gemini: "Gemini" }[provider] || "Ollama";
  $("providerSubtitle").textContent = provider === "ollama"
    ? "Local translation with Ollama"
    : `Translation with ${providerName}`;
  $("modelHelp").textContent = `Using ${providerName}. Change provider in Settings.`;
  $("statusTranslated").checked = state.settings.showTranslated !== false;
  $("controlTranslated").checked = state.settings.showTranslated !== false;
  $("controlOriginal").checked = state.settings.showOriginal === true;
  $("controlNative").checked = hidesNativeSubtitles(state.settings) === false;
  $("controlQuickPills").checked = state.settings.showQuickPills !== false;
  $("controlTranscript").checked = state.settings.showTranscriptSidebar === true;
  $("toggleTranscript").setAttribute(
    "aria-pressed",
    String(state.settings.showTranscriptSidebar === true),
  );
  $("toggleTranscript").textContent = state.settings.showTranscriptSidebar
    ? "Transcript: On"
    : "Transcript: Off";
  renderTiming();
  $("modelSummary").textContent = state.settings.model || "Not selected";
  $("targetSummary").textContent = state.settings.targetLanguage || "English";
  $("targetLanguage").value = state.settings.targetLanguage || "English";
  if ([...$("modelSelect").options].some((option) => option.value === state.settings.model)) {
    $("modelSelect").value = state.settings.model;
  }
}

// Every open tab is offered the reload; the ones without an LST content script
// reject the message and are ignored. Filtering by URL instead would need host
// permission for each service, and messaging needs none.
async function notifyOpenTabs() {
  try {
    const tabs = await ext.tabs.query({});
    await Promise.all(tabs.map((tab) => tab.id
      ? ext.tabs.sendMessage(tab.id, { type: "RELOAD_SETTINGS" }).catch(() => {})
      : Promise.resolve()));
  } catch {}
}

// The tab showing that episode moves with the correction immediately: the viewer
// nudged until the line landed, so the player has to apply it now rather than at
// the next episode change. Tabs without an LST content script reject the message
// and are ignored.
async function notifyImportChanged() {
  try {
    const tabs = await ext.tabs.query({});
    await Promise.all(tabs.map((tab) => tab.id
      ? ext.tabs.sendMessage(tab.id, { type: "IMPORT_CHANGED" }).catch(() => {})
      : Promise.resolve()));
  } catch {}
}

async function saveQuickSettings(patch, message = "Saved") {  try {
    const response = await runtimeMessage({ type: "SAVE_SETTINGS", settings: patch });
    state.settings = { ...state.settings, ...response.settings };
    syncSettingsControls();
    await notifyOpenTabs();
    $("controlsMessage").textContent = message;
  } catch (error) {
    syncSettingsControls();
    $("controlsMessage").textContent = `Could not save: ${error.message}`;
  }
}

async function refreshModels() {
  const select = $("modelSelect");
  try {
    const response = await runtimeMessage({
      type: "GET_MODELS",
      provider: state.settings.provider,
      ollamaUrl: state.settings.ollamaUrl
    });
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
        option.textContent = model.name;
        select.appendChild(option);
      }
    }
    if (state.settings.model && ![...select.options].some((option) => option.value === state.settings.model)) {
      const option = document.createElement("option");
      option.value = state.settings.model;
      option.textContent = `${state.settings.model} — unavailable`;
      select.prepend(option);
    }
    select.value = state.settings.model || "";
  } catch (error) {
    select.replaceChildren();
    const option = document.createElement("option");
    option.value = state.settings.model || "";
    option.textContent = state.settings.model || "Could not load models";
    select.appendChild(option);
    $("controlsMessage").textContent = error.message;
  }
}

async function loadSettings() {
  const response = await runtimeMessage({ type: "GET_SETTINGS" });
  state.settings = { ...state.settings, ...response.settings };
  syncSettingsControls();
  await refreshModels();
}

function renderStatus(status) {
  const episodeCompleted = Boolean(
    status.captured &&
    status.cueCount > 0 &&
    status.translatedCount >= status.cueCount
  );
  const remainingCueCount = Math.max(
    0,
    Number(status.remainingCueCount ?? status.cueCount) || 0
  );
  const remainingTranslatedCount = Math.max(
    0,
    Number(status.remainingTranslatedCount ?? status.translatedCount) || 0
  );
  const readyFromHere = Boolean(
    status.captured &&
    remainingTranslatedCount >= remainingCueCount
  );
  const percent = Math.max(0, Math.min(100, Number(status.progressPercent || 0)));

  const serviceLabel = siteLabelFor(status.siteId);
  $("showName").textContent = displayShowName(status.showName, serviceLabel);
  const episodeName = status.episodeName || "";
  $("episodeName").textContent = isNamedEpisode(episodeName)
    ? episodeName
    : "Finding episode details…";
  // What the episode is playing from: the service's own track, or a subtitle
  // file the viewer imported. The click target is the import card itself.
  const imported = status.imported || null;
  state.imported = imported;
  $("importSummary").textContent = imported
    ? `${imported.fileName || "Imported file"}${imported.translate ? "" : " (as is)"}`
    : "None";
  // What Jimaku held for this show the last time the viewer asked. It comes from
  // the page rather than from a request, so opening the popup asks nobody
  // anything.
  const described = imported
    ? null
    : globalThis.LSTSubtitleImport?.describeJimakuFinding?.(status.jimaku, { now: Date.now() }) || null;
  $("importDetail").textContent = described ? described.headline : "";
  $("importDetail").dataset.tone = described ? described.tone : "";
  // The timing controls follow the track: this episode's imported file has its own
  // clock, and the panel says so rather than showing the global number as if it
  // were the whole story.
  renderTiming();
  $("cueCount").textContent =
    `${remainingTranslatedCount} / ${remainingCueCount} cues ahead`;
  $("progressBar").style.width = `${percent}%`;
  $("progressPercent").textContent = `${percent.toFixed(percent % 1 ? 1 : 0)}%`;

  if (status.precomputing) {
    $("progressState").textContent = "Working…";
    const batchAge = status.batchStartedAt
      ? `\nCurrent batch: ${formatElapsed(status.batchStartedAt)}`
      : "";
    $("currentText").textContent = (status.currentText || "Preparing next batch…") + batchAge;
  } else if (episodeCompleted) {
    $("progressState").textContent = "Completed";
    $("currentText").textContent = status.lastTranslatedText
      ? `Last translation:\n${status.lastTranslatedText}`
      : "Episode translation is cached and ready.";
  } else {
    $("progressState").textContent = readyFromHere
      ? "Ready from here"
      : status.captured ? "Caching ahead…" : "Waiting…";
    $("currentText").textContent = status.lastTranslatedText
      ? `Last translation:\n${status.lastTranslatedText}`
      : "Waiting for subtitle work…";
  }

  const batchText = status.precomputing && status.totalBatches
    ? `Batch ${status.currentBatch}/${status.totalBatches}`
    : "";
  const failedText = status.failedCount ? `${status.failedCount} failed` : "";
  const elapsedText = status.precomputing && status.jobStartedAt
    ? `${formatElapsed(status.jobStartedAt)} elapsed`
    : "";
  const errorText = status.lastError ? `Last error: ${status.lastError}` : "";
  $("message").textContent = [status.message, batchText, failedText, elapsedText, errorText]
    .filter(Boolean)
    .join(" · ");

  if (status.precomputing) {
    $("statePill").textContent = "Working";
    $("statePill").dataset.state = "working";
  } else if (episodeCompleted) {
    $("statePill").textContent = "Completed";
    $("statePill").dataset.state = "completed";
  } else if (readyFromHere) {
    $("statePill").textContent = "Ready from here";
    $("statePill").dataset.state = "ready";
  } else if (status.lastError) {
    $("statePill").textContent = "Needs attention";
    $("statePill").dataset.state = "error";
  } else if (status.captured) {
    $("statePill").textContent = "Connected";
    $("statePill").dataset.state = "ready";
  } else {
    $("statePill").textContent = "Waiting";
    $("statePill").dataset.state = "";
  }

  if (status.model) {
    state.settings.model = status.model;
    $("modelSummary").textContent = status.model;
  }
  if (status.targetLanguage) {
    state.settings.targetLanguage = status.targetLanguage;
    $("targetSummary").textContent = status.targetLanguage;
  }
  $("precompute").disabled =
    !status.captured || !status.model || status.precomputing || episodeCompleted;
  $("cancel").disabled = !status.precomputing;
}

async function refresh() {
  try {
    const { status } = await activePlaybackTab();
    renderStatus(status);
  } catch (error) {
    $("showName").textContent = "LST";
    $("episodeName").textContent = "Open a watch page";
    $("message").textContent = error.message;
    $("statePill").textContent = "Not connected";
    $("statePill").dataset.state = "error";
    $("precompute").disabled = true;
    $("cancel").disabled = true;
  }
}

$("statusTab").addEventListener("click", () => activatePopupTab("status"));
$("controlsTab").addEventListener("click", () => activatePopupTab("controls"));
document.querySelector(".popup-tabs").addEventListener("keydown", (event) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  activatePopupTab(event.target.id === "statusTab" ? "controls" : "status", true);
});

$("openTimingControls").addEventListener("click", () => {
  activatePopupTab("controls");
  $("timingEarlier").focus({ preventScroll: true });
});
$("openModelControls").addEventListener("click", () => {
  activatePopupTab("controls");
  $("modelSelect").focus({ preventScroll: true });
});

$("statusTranslated").addEventListener("change", async (event) => {
  await saveQuickSettings({ showTranslated: event.target.checked }, "Subtitle visibility saved.");
});
$("controlTranslated").addEventListener("change", async (event) => {
  await saveQuickSettings({ showTranslated: event.target.checked }, "Subtitle visibility saved.");
});
$("controlOriginal").addEventListener("change", async (event) => {
  await saveQuickSettings({ showOriginal: event.target.checked }, "Original-text setting saved.");
});
$("controlNative").addEventListener("change", async (event) => {
  await saveQuickSettings({ hideNativeSubtitles: !event.target.checked }, "Caption setting saved.");
});
$("controlQuickPills").addEventListener("change", async (event) => {
  await saveQuickSettings({ showQuickPills: event.target.checked }, "In-player control setting saved.");
});
$("controlTranscript").addEventListener("change", async (event) => {
  await saveQuickSettings({ showTranscriptSidebar: event.target.checked }, "Transcript setting saved.");
});

async function changeTiming(delta) {
  const target = timingTarget();
  if (target.scope !== "global") {
    // A file the viewer imported carries its own correction, so a nudge lands
    // with the file and the player is told to move with it. Nothing about the
    // file is re-read: the page applies the number and the line moves.
    const step = delta === null ? -target.offsetMs : delta;
    const limit = target.limitMs || 600000;
    const next = Math.max(-limit, Math.min(limit, target.offsetMs + step));
    try {
      const response = await runtimeMessage({
        type: "SET_IMPORTED_TRACK_TIMING",
        episodeKey: target.episodeKey,
        offsetMs: next,
      });
      const timingOffsetMs = Number(response?.track?.timingOffsetMs) || 0;
      if (!response?.track) {
        // The file was removed while the popup was open, so there is nothing for
        // this correction to belong to.
        state.imported = null;
        renderTiming();
        $("controlsMessage").textContent =
          "This episode no longer uses an imported file, so there is no file to time.";
        return;
      }
      state.imported = { ...state.imported, timingOffsetMs };
      renderTiming();
      const described = globalThis.LSTSubtitleImport?.describeFileTiming?.(timingOffsetMs);
      $("controlsMessage").textContent = described
        ? `${described.sentence} It applies to this episode from the player too.`
        : "Timing saved for this imported file.";
      await notifyImportChanged();
    } catch (error) {
      $("controlsMessage").textContent = `Could not save the timing: ${error.message}`;
    }
    return;
  }
  const current = Number(state.settings.subtitleTimingOffsetMs) || 0;
  const next = delta === null ? 0 : Math.max(-2000, Math.min(2000, current + delta));
  await saveQuickSettings({ subtitleTimingOffsetMs: next }, `Timing set to ${formatTiming(next)}.`);
}
$("timingEarlier").addEventListener("click", () => changeTiming(-100));
$("timingReset").addEventListener("click", () => changeTiming(null));
$("timingLater").addEventListener("click", () => changeTiming(100));
$("timingFileSteps").addEventListener("click", (event) => {
  if (event.target.closest("[data-file-timing-reset]")) {
    changeTiming(null);
    return;
  }
  const step = event.target.closest("[data-file-timing-step]");
  if (step) changeTiming(Number(step.dataset.fileTimingStep) || 0);
});

$("modelSelect").addEventListener("change", async (event) => {
  const provider = state.settings.provider || "ollama";
  await saveQuickSettings({
    model: event.target.value,
    [`${provider}Model`]: event.target.value
  }, "Model changed for playback.");
});
$("targetLanguage").addEventListener("change", async () => {
  const targetLanguage = $("targetLanguage").value.trim() || "English";
  await saveQuickSettings({ targetLanguage }, `Target language set to ${targetLanguage}.`);
});

$("precompute").addEventListener("click", async () => {
  try {
    const { tab } = await activePlaybackTab();
    await tabMessage(tab.id, { type: "START_PRECOMPUTE" });
    await refresh();
  } catch (error) {
    $("message").textContent = `Could not start precompute: ${error.message}`;
  }
});

$("cancel").addEventListener("click", async () => {
  try {
    const { tab } = await activePlaybackTab();
    await tabMessage(tab.id, { type: "CANCEL_PRECOMPUTE" });
    $("message").textContent = "Stopping after the current translation request finishes…";
  } catch (error) {
    $("message").textContent = `Could not stop precompute: ${error.message}`;
  }
});

$("subtitleControls").addEventListener("click", () => activatePopupTab("controls", true));
$("toggleTranscript").addEventListener("click", async () => {
  const visible = state.settings.showTranscriptSidebar !== true;
  await saveQuickSettings(
    { showTranscriptSidebar: visible },
    visible ? "Transcript opened in the player." : "Transcript hidden in the player.",
  );
});
$("settings").addEventListener("click", () => ext?.runtime?.openOptionsPage());

// Opening the import card directly, so a viewer who clicked here does not have
// to find it in the settings page.
$("importSubtitles").addEventListener("click", () => {
  try {
    const created = ext.tabs.create({ url: ext.runtime.getURL("options.html#import") });
    Promise.resolve(created).catch(() => ext?.runtime?.openOptionsPage());
  } catch {
    ext?.runtime?.openOptionsPage();
  }
});

activatePopupTab(new URLSearchParams(location.search).get("tab") === "controls" ? "controls" : "status");
if (hasExtensionApi) {
  Promise.all([loadSettings(), refresh()]).catch((error) => {
    $("message").textContent = error.message;
  });
  state.pollTimer = setInterval(refresh, 750);
} else {
  state.settings = {
    ...state.settings,
    model: "translategemma:4b",
    targetLanguage: "English",
    showTranslated: true,
    showOriginal: false,
    hideNativeSubtitles: true,
    showQuickPills: true,
    showTranscriptSidebar: false
  };
  $("modelSelect").replaceChildren(new Option("translategemma:4b", "translategemma:4b"));
  syncSettingsControls();
  renderStatus({
    captured: true,
    cueCount: 382,
    translatedCount: 127,
    remainingCueCount: 382,
    remainingTranslatedCount: 127,
    progressPercent: 33,
    precomputing: true,
    currentText: "Translating subtitles…",
    showName: "The Night Agent",
    episodeName: "Season 1 · Episode 1 — Pilot",
    model: "translategemma:4b",
    targetLanguage: "English",
    message: "Precompute continues in the player tab."
  });
  setTimeout(resetPopupScroll, 0);
}
window.addEventListener("unload", () => {
  if (state.pollTimer) clearInterval(state.pollTimer);
});
