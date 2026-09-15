const ext = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);
const hasExtensionApi = Boolean(ext?.runtime?.sendMessage && ext?.tabs?.query);

const state = {
  settings: {
    showTranslated: true,
    showOriginal: false,
    hideNetflixSubtitles: true,
    showQuickPills: true,
    showTranscriptSidebar: false,
    subtitleTimingOffsetMs: 0,
    model: "",
    provider: "ollama",
    targetLanguage: "English",
    ollamaUrl: "http://localhost:11434"
  },
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

async function activeNetflixTab() {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https:\/\/www\.netflix\.com\/watch\/\d+(?:[/?#]|$)/.test(tab.url || "")) {
    throw new Error("Open a Netflix watch page first.");
  }
  return tab;
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

function resetPopupScroll() {
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
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
  $("controlNetflix").checked = state.settings.hideNetflixSubtitles === false;
  $("controlQuickPills").checked = state.settings.showQuickPills !== false;
  $("controlTranscript").checked = state.settings.showTranscriptSidebar === true;
  $("toggleTranscript").setAttribute(
    "aria-pressed",
    String(state.settings.showTranscriptSidebar === true),
  );
  $("toggleTranscript").textContent = state.settings.showTranscriptSidebar
    ? "Transcript: On"
    : "Transcript: Off";
  $("timingValue").textContent = formatTiming();
  $("timingSummary").textContent = formatTiming();
  $("modelSummary").textContent = state.settings.model || "Not selected";
  $("targetSummary").textContent = state.settings.targetLanguage || "English";
  $("targetLanguage").value = state.settings.targetLanguage || "English";
  if ([...$("modelSelect").options].some((option) => option.value === state.settings.model)) {
    $("modelSelect").value = state.settings.model;
  }
}

async function notifyNetflixTabs() {
  try {
    const tabs = await ext.tabs.query({ url: "https://www.netflix.com/*" });
    await Promise.all(tabs.map((tab) => tab.id
      ? ext.tabs.sendMessage(tab.id, { type: "RELOAD_SETTINGS" }).catch(() => {})
      : Promise.resolve()));
  } catch {}
}

async function saveQuickSettings(patch, message = "Saved") {
  try {
    const response = await runtimeMessage({ type: "SAVE_SETTINGS", settings: patch });
    state.settings = { ...state.settings, ...response.settings };
    syncSettingsControls();
    await notifyNetflixTabs();
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

  $("showName").textContent = status.showName || "Netflix";
  const genericEpisodeName = /^(?:Episode|Video) \d{6,}$/.test(
    status.episodeName || "",
  );
  $("episodeName").textContent = genericEpisodeName
    ? "Finding episode details…"
    : status.episodeName || "Finding episode details…";
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
    const tab = await activeNetflixTab();
    const response = await tabMessage(tab.id, { type: "GET_PAGE_STATUS" });
    renderStatus(response.status);
  } catch (error) {
    $("showName").textContent = "Netflix";
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
$("controlNetflix").addEventListener("change", async (event) => {
  await saveQuickSettings({ hideNetflixSubtitles: !event.target.checked }, "Netflix-caption setting saved.");
});
$("controlQuickPills").addEventListener("change", async (event) => {
  await saveQuickSettings({ showQuickPills: event.target.checked }, "In-player control setting saved.");
});
$("controlTranscript").addEventListener("change", async (event) => {
  await saveQuickSettings({ showTranscriptSidebar: event.target.checked }, "Transcript setting saved.");
});

async function changeTiming(delta) {
  const current = Number(state.settings.subtitleTimingOffsetMs) || 0;
  const next = delta === null ? 0 : Math.max(-2000, Math.min(2000, current + delta));
  await saveQuickSettings({ subtitleTimingOffsetMs: next }, `Timing set to ${formatTiming(next)}.`);
}
$("timingEarlier").addEventListener("click", () => changeTiming(-100));
$("timingReset").addEventListener("click", () => changeTiming(null));
$("timingLater").addEventListener("click", () => changeTiming(100));

$("modelSelect").addEventListener("change", async (event) => {
  const provider = state.settings.provider || "ollama";
  await saveQuickSettings({
    model: event.target.value,
    [`${provider}Model`]: event.target.value
  }, "Model changed for Netflix playback.");
});
$("targetLanguage").addEventListener("change", async () => {
  const targetLanguage = $("targetLanguage").value.trim() || "English";
  await saveQuickSettings({ targetLanguage }, `Target language set to ${targetLanguage}.`);
});

$("precompute").addEventListener("click", async () => {
  try {
    const tab = await activeNetflixTab();
    await tabMessage(tab.id, { type: "START_PRECOMPUTE" });
    await refresh();
  } catch (error) {
    $("message").textContent = `Could not start precompute: ${error.message}`;
  }
});

$("cancel").addEventListener("click", async () => {
  try {
    const tab = await activeNetflixTab();
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
    visible ? "Transcript opened on Netflix." : "Transcript hidden on Netflix.",
  );
});
$("settings").addEventListener("click", () => ext?.runtime?.openOptionsPage());

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
    hideNetflixSubtitles: true,
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
    message: "Precompute continues in the Netflix tab."
  });
  setTimeout(resetPopupScroll, 0);
}
window.addEventListener("unload", () => {
  if (state.pollTimer) clearInterval(state.pollTimer);
});
