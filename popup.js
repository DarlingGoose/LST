const ext = globalThis.browser || globalThis.chrome;

const modelEl = document.getElementById("model");
const targetEl = document.getElementById("target");
const trackEl = document.getElementById("track");
const playbackEl = document.getElementById("playback");
const progressBarEl = document.getElementById("progressBar");
const progressTextEl = document.getElementById("progressText");
const currentTextEl = document.getElementById("currentText");
const messageEl = document.getElementById("message");
const precomputeButton = document.getElementById("precompute");
const cancelButton = document.getElementById("cancel");
const settingsButton = document.getElementById("settings");
const statePillEl = document.getElementById("statePill");

let pollTimer = null;

async function tabMessage(tabId, message) {
  const response = await ext.tabs.sendMessage(tabId, message);
  if (!response?.ok) {
    throw new Error(response?.error || "Request failed.");
  }
  return response;
}

async function activeNetflixTab() {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.includes("netflix.com/")) {
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

function renderStatus(status) {
  const completed = Boolean(
    status.captured &&
    status.cueCount > 0 &&
    status.translatedCount >= status.cueCount
  );

  modelEl.textContent = status.model || "not selected";
  targetEl.textContent = status.targetLanguage || "English";
  trackEl.textContent = status.captured
    ? `${status.cueCount} cues`
    : "waiting for full track";
  playbackEl.textContent = status.playbackMode || "waiting";

  const percent = Number(status.progressPercent || 0);
  progressBarEl.style.width = `${Math.max(0, Math.min(100, percent))}%`;

  const batchText = status.precomputing && status.totalBatches
    ? ` · batch ${status.currentBatch}/${status.totalBatches}`
    : "";
  const failedText = status.failedCount
    ? ` · ${status.failedCount} failed`
    : "";
  const elapsedText = status.precomputing && status.jobStartedAt
    ? ` · ${formatElapsed(status.jobStartedAt)} elapsed`
    : "";

  progressTextEl.textContent =
    `${status.translatedCount || 0}/${status.cueCount || 0} · ` +
    `${percent.toFixed(1)}%${batchText}${failedText}${elapsedText}`;

  if (status.precomputing) {
    const batchAge = status.batchStartedAt
      ? `\nCurrent batch running: ${formatElapsed(status.batchStartedAt)}`
      : "";
    currentTextEl.textContent =
      (status.currentText || "Preparing next batch…") + batchAge;
  } else if (status.lastTranslatedText) {
    currentTextEl.textContent =
      `Last translation:\n${status.lastTranslatedText}`;
  } else {
    currentTextEl.textContent = "Waiting for subtitle work…";
  }

  const error = status.lastError ? `\nLast error: ${status.lastError}` : "";
  messageEl.textContent = `${status.message || ""}${error}`;

  if (status.precomputing) {
    statePillEl.textContent = "Working";
    statePillEl.dataset.state = "working";
  } else if (completed) {
    statePillEl.textContent = "Completed";
    statePillEl.dataset.state = "completed";
  } else if (status.lastError) {
    statePillEl.textContent = "Needs attention";
    statePillEl.dataset.state = "error";
  } else if (status.captured) {
    statePillEl.textContent = "Ready";
    statePillEl.dataset.state = "ready";
  } else {
    statePillEl.textContent = "Waiting";
    statePillEl.dataset.state = "";
  }

  precomputeButton.disabled =
    !status.captured || !status.model || status.precomputing || completed;
  cancelButton.disabled = !status.precomputing;
}

async function refresh() {
  try {
    const tab = await activeNetflixTab();
    const response = await tabMessage(tab.id, { type: "GET_PAGE_STATUS" });
    renderStatus(response.status);
  } catch (error) {
    messageEl.textContent = error.message;
    statePillEl.textContent = "Not connected";
    statePillEl.dataset.state = "error";
    precomputeButton.disabled = true;
    cancelButton.disabled = true;
  }
}

precomputeButton.addEventListener("click", async () => {
  try {
    const tab = await activeNetflixTab();
    await tabMessage(tab.id, { type: "START_PRECOMPUTE" });
    await refresh();
  } catch (error) {
    messageEl.textContent = `Could not start precompute:\n${error.message}`;
  }
});

cancelButton.addEventListener("click", async () => {
  try {
    const tab = await activeNetflixTab();
    await tabMessage(tab.id, { type: "CANCEL_PRECOMPUTE" });
    messageEl.textContent = "Stopping after the current Ollama request finishes…";
  } catch (error) {
    messageEl.textContent = `Could not stop precompute:\n${error.message}`;
  }
});

settingsButton.addEventListener("click", () => ext.runtime.openOptionsPage());

refresh();
pollTimer = setInterval(refresh, 750);

window.addEventListener("unload", () => {
  if (pollTimer) clearInterval(pollTimer);
});
