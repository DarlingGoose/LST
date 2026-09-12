const ext = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);
const statusEl = $("status");

async function runtimeMessage(message) {
  const response = await ext.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error || "Request failed.");
  }
  return response;
}

async function load() {
  const response = await runtimeMessage({ type: "GET_SETTINGS" });
  const s = response.settings;

  $("ollamaUrl").value = s.ollamaUrl || "http://localhost:11434";
  $("targetLanguage").value = s.targetLanguage || "English";
  $("enabled").checked = s.enabled !== false;
  $("showOriginal").checked = s.showOriginal !== false;
  $("autoTranslateAhead").checked = s.autoTranslateAhead !== false;
  $("showDebugPanel").checked = s.showDebugPanel !== false;
  $("debugPanelAlwaysOnTop").checked = s.debugPanelAlwaysOnTop !== false;
  $("aheadCount").value = s.aheadCount ?? 12;
  $("batchSize").value = s.batchSize ?? 8;
  $("requestTimeoutSeconds").value = s.requestTimeoutSeconds ?? 75;

  await refreshModels(s.model || "");
}

async function refreshModels(selected = $("model").value) {
  statusEl.textContent = "Loading installed Ollama models…";
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

    if (selected && [...select.options].some((o) => o.value === selected)) {
      select.value = selected;
    }
  }

  statusEl.textContent = `Found ${response.models.length} installed model(s).`;
}

$("refreshModels").addEventListener("click", () => {
  refreshModels().catch((error) => {
    statusEl.textContent = `Could not reach Ollama:\n${error.message}`;
  });
});

$("save").addEventListener("click", async () => {
  try {
    const settings = {
      ollamaUrl: $("ollamaUrl").value.trim().replace(/\/+$/, ""),
      model: $("model").value,
      targetLanguage: $("targetLanguage").value.trim() || "English",
      enabled: $("enabled").checked,
      showOriginal: $("showOriginal").checked,
      autoTranslateAhead: $("autoTranslateAhead").checked,
      showDebugPanel: $("showDebugPanel").checked,
      debugPanelAlwaysOnTop: $("debugPanelAlwaysOnTop").checked,
      aheadCount: Math.max(0, Number($("aheadCount").value) || 0),
      batchSize: Math.min(50, Math.max(1, Number($("batchSize").value) || 8)),
      requestTimeoutSeconds: Math.min(300, Math.max(15, Number($("requestTimeoutSeconds").value) || 75))
    };

    await runtimeMessage({ type: "SAVE_SETTINGS", settings });

    try {
      const tabs = await ext.tabs.query({ url: "https://www.netflix.com/*" });
      await Promise.all(
        tabs.map((tab) =>
          tab.id
            ? ext.tabs.sendMessage(tab.id, { type: "RELOAD_SETTINGS" }).catch(() => {})
            : Promise.resolve()
        )
      );
    } catch {}

    statusEl.textContent = "Saved. Settings were pushed to open Netflix tabs.";
  } catch (error) {
    statusEl.textContent = `Save failed:\n${error.message}`;
  }
});

$("clearCache").addEventListener("click", async () => {
  try {
    const response = await runtimeMessage({ type: "CLEAR_TRANSLATION_CACHE" });
    statusEl.textContent = `Removed ${response.removed} cached episode/model translation set(s).`;
  } catch (error) {
    statusEl.textContent = `Could not clear cache:\n${error.message}`;
  }
});

load().catch((error) => {
  statusEl.textContent = `Startup error:\n${error.message}`;
});
