const ext = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const settingsSchema = globalThis.LSTSettingsSchema;
if (!settingsSchema) throw new Error("settings-schema.js must load before setup.js");
const DEFAULT_MODEL = "translategemma:4b";
const PROVIDER_NAMES = { ollama: "Ollama", deepseek: "DeepSeek", gemini: "Gemini" };
const STEPS = ["welcome", "engine", "language", "ready"];
const STEP_DETAILS = {
  welcome: {
    title: "Welcome to LST",
    description: "Local subtitle translation for the services LST supports, powered by your own machine.",
    next: "Set up translation"
  },
  engine: {
    title: "Choose a translation engine",
    description: "Point LST at Ollama on this computer, or save a key for a remote provider.",
    next: "Save and continue"
  },
  language: {
    title: "Pick a language and layers",
    description: "Choose what LST translates into and which subtitle layers stay visible.",
    next: "Save and continue"
  },
  ready: {
    title: "You are ready to translate",
    description: "Review the setup, then start watching.",
    next: "Save and finish"
  }
};
function hidesNativeSubtitles(settings) {
  return settingsSchema.normalizeStored(settings).settings.hideNativeSubtitles;
}

// The service list, and the home page of each one, come from the adapter, so a
// service added there appears on this page without a second edit here.
function supportedServices() {
  return globalThis.LSTPlaybackSite?.describeSupport?.() || [];
}

function enabledServiceIds() {
  const map = globalThis.__lstSetupEnabledSites || {};
  return supportedServices()
    .filter((service) => map[service.id] !== false)
    .map((service) => service.id);
}

function preferredService() {
  const services = supportedServices();
  const enabled = new Set(enabledServiceIds());
  return services.find((service) => enabled.has(service.id)) || services[0] || null;
}

function collectServiceToggles() {
  const map = {};
  for (const input of document.querySelectorAll("input[data-service-id]")) {
    map[input.dataset.serviceId] = input.checked;
  }
  return map;
}

const providerModels = { ollama: DEFAULT_MODEL, deepseek: "", gemini: "" };
let configuredKeys = { deepseek: false, gemini: false };
let currentStep = "welcome";
let finished = false;

async function runtimeMessage(message) {
  const response = await ext.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "Request failed.");
  return response;
}

function setStatus(message, tone = "") {
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
}

function activateStep(step, focus = false) {
  const active = STEPS.includes(step) ? step : "welcome";
  currentStep = active;
  document.querySelector(".settings-content").dataset.activeStep = active;
  $("setupEyebrow").textContent = `Setup / Step ${STEPS.indexOf(active) + 1} of ${STEPS.length}`;
  $("setupTitle").textContent = STEP_DETAILS[active].title;
  $("setupDescription").textContent = STEP_DETAILS[active].description;
  document.title = `${STEP_DETAILS[active].title} · LST Setup`;
  for (const button of document.querySelectorAll("[data-setup-tab]")) {
    const selected = button.dataset.setupTab === active;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected && focus) button.focus();
  }
  for (const panel of document.querySelectorAll("[data-setup-panel]")) {
    panel.hidden = panel.dataset.setupPanel !== active;
  }
  renderHeaderActions();
  updateSummary();
  history.replaceState(null, "", `#${active}`);
}

function renderHeaderActions() {
  const done = finished && currentStep === "ready";
  $("setupBack").hidden = done || STEPS.indexOf(currentStep) === 0;
  $("setupNext").textContent = done ? "Start watching" : STEP_DETAILS[currentStep].next;
}

// Manual step changes drop any message that belonged to the previous step.
function selectStep(step, focus = false) {
  if (step !== currentStep) setStatus("");
  activateStep(step, focus);
}

function updatePreview() {
  $("subtitlePreview").style.opacity = $("enabled").checked ? "1" : ".28";
  $("previewOriginal").style.display = $("showOriginal").checked ? "block" : "none";
  $("previewTranslated").style.display = $("showTranslated").checked ? "block" : "none";
  const target = $("targetLanguage").value.trim() || "English";
  $("previewHeading").textContent =
    `Sample layers · service source and LST translation · target: ${target}`;
}

function updateSummary() {
  const provider = $("provider").value;
  const remote = provider !== "ollama";
  $("summaryProvider").textContent = PROVIDER_NAMES[provider] || "Ollama";
  $("summaryModel").textContent = $("model").value || "No model selected";
  $("summaryLanguage").textContent = $("targetLanguage").value.trim() || "English";
  $("summaryPrivacy").textContent = remote ? "Remote provider" : "Local endpoint";
  $("summaryPrivacy").className = remote ? "" : "success-text";
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
    showQuickPills: $("showQuickPills").checked,
    autoMinimizeControls: $("autoMinimizeControls").checked,
    controlsMinimizeDelaySeconds: Math.min(
      30,
      Math.max(1, Number($("controlsMinimizeDelaySeconds").value) || 2),
    ),
    hideNativeSubtitles: $("hideNativeSubtitles").checked,
    showNativeWhenTargetLanguage: $("showNativeWhenTargetLanguage").checked,
    enabledSites: collectServiceToggles(),
    showOriginal: $("showOriginal").checked,
    showTranslated: $("showTranslated").checked,
    verifyTranslations: $("verifyTranslations").checked
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

// One row per service the adapter supports: an off switch and a way in. The
// switch the viewer sees is the switch the page's own detection honours.
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

function renderServices(settings) {
  const list = $("serviceList");
  if (!list) return;
  const map = settings?.enabledSites || {};
  globalThis.__lstSetupEnabledSites = map;
  list.replaceChildren();

  for (const service of supportedServices()) {
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
    // A service absent from the map is enabled: it is not one the viewer ever
    // turned off.
    input.checked = map[service.id] !== false;
    input.addEventListener("change", () => {
      globalThis.__lstSetupEnabledSites = collectServiceToggles();
      renderServiceLinks();
    });
    const ui = document.createElement("span");
    ui.className = "switch-ui";
    control.append(input, ui);

    row.append(copy, control);
    list.appendChild(row);
  }
}

// A way into each enabled service, so the guide does not hand a Prime Video
// viewer to Netflix.
function renderServiceLinks() {
  const container = $("serviceLinks");
  if (!container) return;
  const enabled = new Set(enabledServiceIds());
  container.replaceChildren();
  for (const service of supportedServices()) {
    if (!enabled.has(service.id) || !service.homeUrl) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.id = `open-${service.id}`;
    button.dataset.serviceId = service.id;
    button.textContent = `Open ${service.label}`;
    button.addEventListener("click", () => openService(service));
    container.appendChild(button);
  }
}

async function saveSettings({ markComplete = false, quiet = false } = {}) {
  const provider = $("provider").value;
  if (provider !== "ollama" && !configuredKeys[provider]) {
    throw new Error(`Save a ${PROVIDER_NAMES[provider]} API key first.`);
  }
  if (!$("model").value) throw new Error("Choose a translation model first.");
  const settings = collectSettings();
  if (markComplete) settings.setupCompleted = true;
  await runtimeMessage({ type: "SAVE_SETTINGS", settings });
  await pushSettingsToOpenTabs();
  if (!quiet) setStatus("Saved and applied to open player tabs.", "success");
}

function renderProvider() {
  const provider = $("provider").value;
  const remote = provider !== "ollama";
  $("ollamaFields").hidden = remote;
  $("remoteFields").hidden = !remote;
  $("modelDownload").hidden = remote;
  $("modelLabel").textContent = remote ? "Provider model" : "Installed model";
  $("providerHelp").textContent = remote
    ? `Subtitle text is sent to ${PROVIDER_NAMES[provider]}. Requests may use your API quota or incur charges.`
    : "Subtitles are sent to your Ollama endpoint.";
  $("providerApiKey").value = "";
  if (remote) {
    $("providerKeyStatus").textContent = configuredKeys[provider]
      ? "Key saved on this device. Enter a new key to replace it."
      : "No key saved. Enter a key and choose Save key before refreshing models.";
  }
}

async function refreshModels(selected = $("model").value, { quiet = false } = {}) {
  const provider = $("provider").value;
  if (!quiet) setStatus(`Loading ${PROVIDER_NAMES[provider]} models…`);
  const response = await runtimeMessage({
    type: "GET_MODELS",
    provider,
    ollamaUrl: $("ollamaUrl").value.trim()
  });
  if (provider !== $("provider").value) return;

  const select = $("model");
  select.replaceChildren();
  for (const model of response.models) {
    const option = document.createElement("option");
    option.value = model.name;
    const meta = [model.parameterSize, model.quantization].filter(Boolean).join(" · ");
    option.textContent = meta ? `${model.name} — ${meta}` : model.name;
    select.appendChild(option);
  }
  if (!response.models.length) select.appendChild(new Option("No models found", ""));
  if (selected) {
    if (![...select.options].some((option) => option.value === selected)) {
      select.prepend(new Option(`${selected} — unavailable`, selected));
    }
    select.value = selected;
  }

  $("connectionState").textContent = "Connected";
  $("modelCount").textContent = `${response.models.length} available`;
  providerModels[provider] = select.value;
  $("modelSummary").textContent = select.value || "No model selected";
  if (!quiet) {
    setStatus(
      `Found ${response.models.length} ${PROVIDER_NAMES[provider]} model${response.models.length === 1 ? "" : "s"}.`,
      "success"
    );
  }
}

function modelsUnavailable(error) {
  const provider = $("provider").value;
  $("connectionState").textContent = "Unavailable";
  $("modelCount").textContent = "—";
  const select = $("model");
  const selected = providerModels[provider] || "";
  select.replaceChildren(new Option(selected || "Refresh models to choose", selected));
  $("modelSummary").textContent = select.value || "No model selected";
  setStatus(`Could not load ${PROVIDER_NAMES[provider]} models: ${error.message}`, "error");
}

function renderPullProgress(message) {
  const percent = Math.max(0, Math.min(100, Number(message.percent || 0)));
  const progress = $("pullProgress");
  progress.style.display = "block";
  progress.setAttribute("aria-hidden", "false");
  $("pullProgressBar").style.width = `${percent}%`;
  $("pullProgressText").textContent = percent
    ? `${message.status || "Downloading…"} · ${percent}%`
    : message.status || "Preparing download…";
}

async function goNext() {
  if (finished && currentStep === "ready") {
    openPreferredService();
    return;
  }

  if (currentStep === "ready") {
    const button = $("setupNext");
    button.disabled = true;
    try {
      await saveSettings({ markComplete: true, quiet: true });
    } catch (error) {
      setStatus(`Could not finish setup: ${error.message}`, "error");
      button.disabled = false;
      return;
    }
    button.disabled = false;
    finished = true;
    $("readyPill").textContent = "Setup complete";
    renderHeaderActions();
    updateSummary();
    setStatus("Setup complete. Open a watch page and turn on a subtitle track.", "success");
    return;
  }

  const index = STEPS.indexOf(currentStep);
  if (index > 0) {
    try {
      await saveSettings();
    } catch (error) {
      setStatus(`Could not save: ${error.message}`, "error");
      return;
    }
  } else {
    setStatus("");
  }
  activateStep(STEPS[index + 1]);
}

function goBack() {
  const index = STEPS.indexOf(currentStep);
  if (index > 0) activateStep(STEPS[index - 1]);
}

// Firefox resolves these with promises; Chromium may not, so both paths are handled.
function reportFailure(promise, message) {
  try {
    promise?.catch?.((error) => setStatus(`${message}: ${error.message}`, "error"));
  } catch (error) {
    setStatus(`${message}: ${error.message}`, "error");
  }
}

function openService(service) {
  if (!service?.homeUrl) return;
  try {
    reportFailure(
      ext.tabs.create({ url: service.homeUrl }),
      `Could not open ${service.label}`,
    );
  } catch (error) {
    setStatus(`Could not open ${service.label}: ${error.message}`, "error");
  }
}

function openPreferredService() {
  const service = preferredService();
  if (service) openService(service);
}

async function load() {
  const response = await runtimeMessage({ type: "GET_SETTINGS" });
  const settings = response.settings;

  $("ollamaUrl").value = settings.ollamaUrl || "http://localhost:11434";
  $("provider").value = PROVIDER_NAMES[settings.provider] ? settings.provider : "ollama";
  providerModels.ollama = settings.ollamaModel || (settings.provider === "ollama" ? settings.model : "") || DEFAULT_MODEL;
  providerModels.deepseek = settings.deepseekModel || (settings.provider === "deepseek" ? settings.model : "") || "";
  providerModels.gemini = settings.geminiModel || (settings.provider === "gemini" ? settings.model : "") || "";
  configuredKeys = (await runtimeMessage({ type: "GET_PROVIDER_KEY_STATUS" })).configured;
  renderProvider();

  $("targetLanguage").value = settings.targetLanguage || "English";
  $("enabled").checked = settings.enabled !== false;
  $("showQuickPills").checked = settings.showQuickPills !== false;
  $("autoMinimizeControls").checked = settings.autoMinimizeControls !== false;
  $("controlsMinimizeDelaySeconds").value = Math.min(
    30,
    Math.max(1, Number(settings.controlsMinimizeDelaySeconds) || 2),
  );
  $("hideNativeSubtitles").checked = hidesNativeSubtitles(settings) !== false;
  $("showNativeWhenTargetLanguage").checked =
    settings.showNativeWhenTargetLanguage !== false;
  $("showOriginal").checked = settings.showOriginal === true;
  $("showTranslated").checked = settings.showTranslated !== false;
  $("verifyTranslations").checked = settings.verifyTranslations !== false;
  $("pullModelName").value = providerModels.ollama;
  renderServices(settings);
  renderServiceLinks();
  updatePreview();
  updateSummary();

  if (settings.setupCompleted === true) {
    $("readyPill").textContent = "Setup complete";
    setStatus("Setup was already completed. Adjust anything and save again.");
  }

  try {
    await refreshModels(providerModels[$("provider").value], { quiet: true });
  } catch (error) {
    modelsUnavailable(error);
  }
}

$("setupNext").addEventListener("click", () => {
  goNext().catch((error) => setStatus(`Setup failed: ${error.message}`, "error"));
});

$("setupBack").addEventListener("click", goBack);

$("refreshModels").addEventListener("click", () => {
  refreshModels(providerModels[$("provider").value]).catch(modelsUnavailable);
});

$("provider").addEventListener("change", () => {
  renderProvider();
  const selected = providerModels[$("provider").value];
  $("model").replaceChildren(new Option(selected || "Refresh models to choose", selected));
  $("modelSummary").textContent = selected || "No model selected";
  updateSummary();
  const provider = $("provider").value;
  refreshModels(selected).catch((error) => {
    if (provider !== $("provider").value) return;
    modelsUnavailable(error);
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

$("model").addEventListener("change", () => {
  providerModels[$("provider").value] = $("model").value;
  $("modelSummary").textContent = $("model").value || "No model selected";
  updateSummary();
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
    await runtimeMessage({ type: "PULL_MODEL", model, ollamaUrl: $("ollamaUrl").value.trim() });
    renderPullProgress({ status: `${model} downloaded`, percent: 100 });
    await refreshModels(model);
    setStatus(`${model} is installed and selected.`, "success");
  } catch (error) {
    $("pullProgressText").textContent = `Download failed: ${error.message}`;
    setStatus(`Could not download ${model}.`, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Download";
  }
});

$("copyOllamaCommand").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("ollamaCommand").textContent);
    setStatus("Ollama command copied.", "success");
  } catch (error) {
    setStatus(`Could not copy the command: ${error.message}`, "error");
  }
});

$("openSettings").addEventListener("click", () => {
  try {
    reportFailure(ext.runtime.openOptionsPage(), "Could not open settings");
  } catch (error) {
    setStatus(`Could not open settings: ${error.message}`, "error");
  }
});



$("targetLanguage").addEventListener("change", () => {
  updatePreview();
  updateSummary();
});

for (const id of [
  "enabled",
  "showQuickPills",
  "hideNativeSubtitles",
  "showNativeWhenTargetLanguage",
  "showOriginal",
  "showTranslated",
]) {
  $(id).addEventListener("change", updatePreview);
}

document.querySelector(".settings-tabs").addEventListener("click", (event) => {
  const step = event.target.closest("[data-setup-tab]")?.dataset.setupTab;
  if (step) selectStep(step);
});

document.querySelector(".settings-tabs").addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const current = STEPS.indexOf(event.target.dataset.setupTab);
  if (current < 0) return;
  event.preventDefault();
  const next = event.key === "Home"
    ? 0
    : event.key === "End"
      ? STEPS.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + STEPS.length) % STEPS.length;
  selectStep(STEPS[next], true);
});

ext.runtime.onMessage.addListener((message) => {
  if (message?.type === "MODEL_PULL_PROGRESS") renderPullProgress(message);
});

activateStep(location.hash.slice(1));
load().catch((error) => setStatus(`Startup error: ${error.message}`, "error"));
