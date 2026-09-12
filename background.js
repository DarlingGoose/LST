const ext = globalThis.browser || globalThis.chrome;

const DEFAULTS = {
  enabled: true,
  ollamaUrl: "http://localhost:11434",
  model: "",
  targetLanguage: "English",
  showOriginal: true,
  autoTranslateAhead: true,
  aheadCount: 12,
  batchSize: 8,
  requestTimeoutSeconds: 75,
  showDebugPanel: true,
  debugPanelAlwaysOnTop: true
};

ext.runtime.onInstalled.addListener(async () => {
  const current = await ext.storage.local.get(Object.keys(DEFAULTS));
  const missing = {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (current[key] === undefined) missing[key] = value;
  }
  if (Object.keys(missing).length) {
    await ext.storage.local.set(missing);
  }
});

function normalizeBaseUrl(url) {
  return (url || DEFAULTS.ollamaUrl).replace(/\/+$/, "");
}

async function getSettings() {
  return ext.storage.local.get(DEFAULTS);
}

function truncate(value, max = 900) {
  value = String(value ?? "");
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

async function fetchJson(url, init = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const elapsedMs = Date.now() - startedAt;

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const error = new Error(
        `${response.status} ${response.statusText}${body ? `: ${body.slice(0, 300)}` : ""}`
      );
      error.diagnostics = {
        url,
        status: response.status,
        elapsedMs,
        bodySnippet: truncate(body)
      };
      throw error;
    }

    return {
      data: await response.json(),
      elapsedMs,
      status: response.status
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(
        `Ollama request timed out after ${Math.round(timeoutMs / 1000)}s`
      );
      timeoutError.diagnostics = {
        url,
        timedOut: true,
        elapsedMs: Date.now() - startedAt
      };
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function getModels(ollamaUrl) {
  const base = normalizeBaseUrl(ollamaUrl);
  const { data } = await fetchJson(`${base}/api/tags`, {}, 15000);
  return (data.models || []).map((m) => ({
    name: m.name || m.model,
    model: m.model || m.name,
    size: m.size || 0,
    family: m.details?.family || "",
    parameterSize: m.details?.parameter_size || "",
    quantization: m.details?.quantization_level || ""
  }));
}

function translationSchema() {
  return {
    type: "object",
    properties: {
      translations: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            text: { type: "string" }
          },
          required: ["id", "text"]
        }
      }
    },
    required: ["translations"]
  };
}

function systemPrompt(targetLanguage) {
  return [
    "You are a subtitle translator.",
    `Translate every subtitle into ${targetLanguage}.`,
    "Use natural, concise language suitable for subtitles.",
    "Preserve names, honorifics, punctuation, speaker labels, and intent.",
    "Do not add explanations, notes, analysis, or romanization.",
    "Do not merge, split, omit, or reorder items."
  ].join(" ");
}

function cleanPlainTranslation(value) {
  value = String(value || "").trim();
  value = value.replace(/^```(?:text|json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }

  return value
    .replace(/^(translation|english|translated text)\s*:\s*/i, "")
    .trim();
}

async function runStructuredTranslation(items, opts) {
  const input = items.map((item, index) => ({
    id: String(item.id ?? index),
    text: String(item.text ?? "")
  }));

  const timeoutMs = Math.max(15, Number(opts.requestTimeoutSeconds) || 75) * 1000;
  const base = normalizeBaseUrl(opts.ollamaUrl);

  const result = await fetchJson(
    `${base}/api/generate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        system:
          `${systemPrompt(opts.targetLanguage)} ` +
          "Return exactly one translation for every input item using the required JSON schema.",
        prompt: JSON.stringify({
          targetLanguage: opts.targetLanguage,
          subtitles: input
        }),
        stream: false,
        format: translationSchema(),
        think: false,
        keep_alive: "15m",
        options: {
          temperature: 0,
          num_predict: Math.max(256, input.length * 96)
        }
      })
    },
    timeoutMs
  );

  const data = result.data;
  const rawResponse = String(data.response || "");
  let parsed;

  try {
    parsed = JSON.parse(rawResponse || "{}");
  } catch {
    const error = new Error("Ollama returned invalid structured JSON.");
    error.diagnostics = {
      mode: "structured",
      elapsedMs: result.elapsedMs,
      rawResponse: truncate(rawResponse),
      doneReason: data.done_reason || "",
      evalCount: data.eval_count || 0,
      promptEvalCount: data.prompt_eval_count || 0
    };
    throw error;
  }

  const rows = Array.isArray(parsed.translations) ? parsed.translations : [];
  const exactMap = new Map(
    rows
      .filter((row) => row && row.id != null)
      .map((row) => [String(row.id), String(row.text ?? "").trim()])
  );

  const exactWorks =
    rows.length === input.length &&
    input.every((entry) => exactMap.has(entry.id) && exactMap.get(entry.id));

  if (exactWorks) {
    return {
      translations: input.map((entry) => ({
        id: entry.id,
        text: exactMap.get(entry.id)
      })),
      diagnostics: {
        mode: "structured",
        idRecovery: "exact",
        elapsedMs: result.elapsedMs,
        returnedIds: rows.map((row) => String(row?.id ?? "")),
        rawResponse: truncate(rawResponse),
        doneReason: data.done_reason || "",
        evalCount: data.eval_count || 0,
        promptEvalCount: data.prompt_eval_count || 0
      }
    };
  }

  // Qwen and other local models sometimes faithfully return N translations but
  // rewrite/shorten the opaque cue IDs. If count and order are correct, recover
  // positionally rather than throwing away otherwise-valid translations.
  if (
    rows.length === input.length &&
    rows.every((row) => String(row?.text ?? "").trim())
  ) {
    return {
      translations: input.map((entry, index) => ({
        id: entry.id,
        text: String(rows[index].text).trim()
      })),
      diagnostics: {
        mode: "structured",
        idRecovery: "positional",
        elapsedMs: result.elapsedMs,
        requestedIds: input.map((entry) => entry.id),
        returnedIds: rows.map((row) => String(row?.id ?? "")),
        rawResponse: truncate(rawResponse),
        doneReason: data.done_reason || "",
        evalCount: data.eval_count || 0,
        promptEvalCount: data.prompt_eval_count || 0
      }
    };
  }

  const error = new Error(
    `Structured result mismatch: requested ${input.length}, received ${rows.length}`
  );
  error.diagnostics = {
    mode: "structured",
    idRecovery: "failed",
    elapsedMs: result.elapsedMs,
    requestedIds: input.slice(0, 8).map((entry) => entry.id),
    returnedIds: rows.slice(0, 8).map((row) => String(row?.id ?? "")),
    returnedTexts: rows.slice(0, 4).map((row) => truncate(row?.text, 140)),
    rawResponse: truncate(rawResponse),
    doneReason: data.done_reason || "",
    evalCount: data.eval_count || 0,
    promptEvalCount: data.prompt_eval_count || 0
  };
  throw error;
}

async function runPlainSingleTranslation(item, opts) {
  const timeoutMs = Math.max(15, Number(opts.requestTimeoutSeconds) || 75) * 1000;
  const base = normalizeBaseUrl(opts.ollamaUrl);

  const result = await fetchJson(
    `${base}/api/generate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        system:
          `${systemPrompt(opts.targetLanguage)} ` +
          "Return only the translated subtitle text. Do not return JSON or a label.",
        prompt: String(item.text ?? ""),
        stream: false,
        think: false,
        keep_alive: "15m",
        options: {
          temperature: 0,
          num_predict: 192
        }
      })
    },
    timeoutMs
  );

  const data = result.data;
  const translated = cleanPlainTranslation(data.response);

  if (!translated) {
    const error = new Error("Plain-text fallback returned an empty translation.");
    error.diagnostics = {
      mode: "plain-fallback",
      elapsedMs: result.elapsedMs,
      rawResponse: truncate(data.response),
      doneReason: data.done_reason || "",
      evalCount: data.eval_count || 0
    };
    throw error;
  }

  return {
    translation: {
      id: String(item.id ?? "0"),
      text: translated
    },
    diagnostics: {
      mode: "plain-fallback",
      elapsedMs: result.elapsedMs,
      rawResponse: truncate(data.response),
      doneReason: data.done_reason || "",
      evalCount: data.eval_count || 0,
      promptEvalCount: data.prompt_eval_count || 0
    }
  };
}

function errorDiagnostics(error, itemCount) {
  return {
    itemCount,
    error: error?.message || String(error),
    ...(error?.diagnostics || {})
  };
}

async function translateBatchResilient(items, opts, depth = 0) {
  if (!items.length) {
    return { translations: [], failures: [], diagnostics: [] };
  }

  try {
    const result = await runStructuredTranslation(items, opts);
    return {
      translations: result.translations,
      failures: [],
      diagnostics: [{
        stage: "structured-success",
        depth,
        itemCount: items.length,
        ...result.diagnostics
      }]
    };
  } catch (structuredError) {
    const diagnostics = [{
      stage: "structured-failure",
      depth,
      ...errorDiagnostics(structuredError, items.length)
    }];

    if (items.length === 1) {
      try {
        const fallback = await runPlainSingleTranslation(items[0], opts);
        diagnostics.push({
          stage: "plain-fallback-success",
          depth,
          itemCount: 1,
          ...fallback.diagnostics
        });
        return {
          translations: [fallback.translation],
          failures: [],
          diagnostics
        };
      } catch (fallbackError) {
        diagnostics.push({
          stage: "plain-fallback-failure",
          depth,
          ...errorDiagnostics(fallbackError, 1)
        });
        return {
          translations: [],
          failures: [{
            id: String(items[0].id ?? "0"),
            text: String(items[0].text ?? ""),
            error: fallbackError?.message || String(fallbackError),
            structuredError: structuredError?.message || String(structuredError)
          }],
          diagnostics
        };
      }
    }

    const mid = Math.ceil(items.length / 2);
    const left = await translateBatchResilient(items.slice(0, mid), opts, depth + 1);
    const right = await translateBatchResilient(items.slice(mid), opts, depth + 1);

    return {
      translations: [...left.translations, ...right.translations],
      failures: [...left.failures, ...right.failures],
      diagnostics: [...diagnostics, ...left.diagnostics, ...right.diagnostics]
    };
  }
}

function cacheStorageKey(cacheId) {
  return `translationCache:${cacheId}`;
}

async function cacheGet(cacheId, keys) {
  const storageKey = cacheStorageKey(cacheId);
  const value = (await ext.storage.local.get(storageKey))[storageKey] || {};
  const found = {};
  for (const key of keys || []) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      found[key] = value[key];
    }
  }
  return found;
}

async function cacheSet(cacheId, entries) {
  const storageKey = cacheStorageKey(cacheId);
  const existing = (await ext.storage.local.get(storageKey))[storageKey] || {};
  Object.assign(existing, entries || {});
  await ext.storage.local.set({ [storageKey]: existing });
}

async function clearTranslationCache() {
  const all = await ext.storage.local.get(null);
  const keys = Object.keys(all).filter((key) => key.startsWith("translationCache:"));
  if (keys.length) await ext.storage.local.remove(keys);
  return keys.length;
}

ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "GET_SETTINGS": {
        sendResponse({ ok: true, settings: await getSettings() });
        return;
      }

      case "SAVE_SETTINGS": {
        await ext.storage.local.set(message.settings || {});
        sendResponse({ ok: true, settings: await getSettings() });
        return;
      }

      case "GET_MODELS": {
        const settings = await getSettings();
        const models = await getModels(message.ollamaUrl || settings.ollamaUrl);
        sendResponse({ ok: true, models });
        return;
      }

      case "TRANSLATE_BATCH": {
        const settings = await getSettings();
        const opts = {
          ollamaUrl: message.ollamaUrl || settings.ollamaUrl,
          model: message.model || settings.model,
          targetLanguage: message.targetLanguage || settings.targetLanguage,
          requestTimeoutSeconds:
            message.requestTimeoutSeconds || settings.requestTimeoutSeconds
        };

        if (!opts.model) throw new Error("No Ollama model selected.");

        const startedAt = Date.now();
        const result = await translateBatchResilient(message.items || [], opts);

        sendResponse({
          ok: true,
          ...result,
          summary: {
            requested: (message.items || []).length,
            translated: result.translations.length,
            failed: result.failures.length,
            elapsedMs: Date.now() - startedAt,
            model: opts.model,
            targetLanguage: opts.targetLanguage
          }
        });
        return;
      }

      case "CACHE_GET": {
        sendResponse({
          ok: true,
          entries: await cacheGet(message.cacheId, message.keys || [])
        });
        return;
      }

      case "CACHE_SET": {
        await cacheSet(message.cacheId, message.entries || {});
        sendResponse({ ok: true });
        return;
      }

      case "CLEAR_TRANSLATION_CACHE": {
        sendResponse({ ok: true, removed: await clearTranslationCache() });
        return;
      }

      default:
        sendResponse({ ok: false, error: "Unknown message type." });
    }
  })().catch((error) => {
    console.error("[LST]", error);
    sendResponse({
      ok: false,
      error: error?.message || String(error),
      diagnostics: error?.diagnostics || null
    });
  });

  return true;
});
