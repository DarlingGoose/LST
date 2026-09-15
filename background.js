const ext = globalThis.browser || globalThis.chrome;
const DIAGNOSTIC_LOG_KEY = "diagnosticLog";
const DIAGNOSTIC_LOG_LIMIT = 750;
let diagnosticWriteQueue = Promise.resolve();

const DEFAULTS = {
  enabled: true,
  ollamaUrl: "http://localhost:11434",
  provider: "ollama",
  ollamaModel: "translategemma:4b",
  deepseekModel: "",
  geminiModel: "",
  model: "translategemma:4b",
  targetLanguage: "English",
  hideNetflixSubtitles: true,
  showOriginal: false,
  showTranslated: true,
  minimumSubtitleDisplaySeconds: 2,
  maximumVisibleSubtitles: 2,
  showStatusMessages: true,
  autoTranslateAhead: true,
  useTranslationContext: false,
  lookAheadSeconds: 30,
  cacheWhilePaused: true,
  batchSize: 8,
  requestTimeoutSeconds: 75,
  customTranslationPrompt: "",
  showDebugPanel: false,
  debugPanelAlwaysOnTop: false,
  showQuickPills: true,
  showTranscriptSidebar: false,
  subtitleHorizontalPosition: "center",
  subtitleVerticalPosition: 9,
  subtitleMaxWidth: 92,
  translatedFontSize: 36,
  originalFontSize: 30,
  subtitleBackgroundOpacity: 58,
  subtitleTimingOffsetMs: 0
};

ext.runtime.onInstalled.addListener(async () => {
  const current = await ext.storage.local.get(Object.keys(DEFAULTS));
  const missing = {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (current[key] === undefined) missing[key] = value;
  }
  if (!current.model) missing.model = DEFAULTS.model;
  if (current.ollamaModel === undefined) missing.ollamaModel = current.model || DEFAULTS.model;
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

function sanitizeDiagnosticValue(value, depth = 0) {
  if (depth > 5) return "[truncated]";
  if (value == null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") return truncate(value, 240);
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeDiagnosticValue(item, depth + 1));
  }
  if (typeof value !== "object") return String(value);

  const sanitized = {};
  for (const [key, item] of Object.entries(value).slice(0, 30)) {
    if (/(cookie|authorization|token|secret|password|api.?key|subtitle.?text|source.?text|translated.?text|url)/i.test(key)) {
      sanitized[key] = "[redacted]";
    } else {
      sanitized[key] = sanitizeDiagnosticValue(item, depth + 1);
    }
  }
  return sanitized;
}

function appendDiagnosticEvents(events) {
  const safeEvents = (events || []).slice(0, 100).map((event) => ({
    timestamp: Number(event?.timestamp) || Date.now(),
    level: ["info", "warning", "error"].includes(event?.level)
      ? event.level
      : "info",
    category: truncate(event?.category || "general", 40),
    event: truncate(event?.event || "unknown", 80),
    videoId: truncate(event?.videoId || "unknown", 40),
    videoTime: Number.isFinite(Number(event?.videoTime))
      ? Number(Number(event.videoTime).toFixed(3))
      : null,
    cue: truncate(event?.cue || "", 80),
    details: sanitizeDiagnosticValue(event?.details || {})
  }));
  if (!safeEvents.length) return diagnosticWriteQueue;

  diagnosticWriteQueue = diagnosticWriteQueue
    .catch(() => {})
    .then(async () => {
      const stored = await ext.storage.local.get(DIAGNOSTIC_LOG_KEY);
      const current = Array.isArray(stored[DIAGNOSTIC_LOG_KEY])
        ? stored[DIAGNOSTIC_LOG_KEY]
        : [];
      await ext.storage.local.set({
        [DIAGNOSTIC_LOG_KEY]: [...current, ...safeEvents].slice(-DIAGNOSTIC_LOG_LIMIT)
      });
    });
  return diagnosticWriteQueue;
}

async function getDiagnosticEvents() {
  await diagnosticWriteQueue.catch(() => {});
  const stored = await ext.storage.local.get(DIAGNOSTIC_LOG_KEY);
  const events = Array.isArray(stored[DIAGNOSTIC_LOG_KEY])
    ? stored[DIAGNOSTIC_LOG_KEY]
    : [];
  return events;
}

async function clearDiagnosticEvents() {
  await diagnosticWriteQueue.catch(() => {});
  await ext.storage.local.remove(DIAGNOSTIC_LOG_KEY);
}

async function fetchJson(url, init = {}, timeoutMs = 15000, provider = "Ollama") {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const elapsedMs = Date.now() - startedAt;

    if (!response.ok) {
      const body = provider === "Ollama" ? await response.text().catch(() => "") : "";
      const error = new Error(
        `${response.status} ${response.statusText}${body ? `: ${body.slice(0, 300)}` : ""}`
      );
      error.diagnostics = {
        url: provider === "Ollama" ? url : provider,
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
        `${provider} request timed out after ${Math.round(timeoutMs / 1000)}s`
      );
      timeoutError.diagnostics = {
        url: provider === "Ollama" ? url : provider,
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

const PROVIDER_KEYS = { deepseek: "deepseekApiKey", gemini: "geminiApiKey" };

function providerName(provider) {
  return { ollama: "Ollama", deepseek: "DeepSeek", gemini: "Gemini" }[provider] || "Ollama";
}

async function providerApiKey(provider) {
  const keyName = PROVIDER_KEYS[provider];
  if (!keyName) return "";
  const stored = await ext.storage.local.get(keyName);
  const key = String(stored[keyName] || "").trim();
  if (!key) throw new Error(`Add a ${providerName(provider)} API key in Settings first.`);
  return key;
}

async function getProviderModels(provider, ollamaUrl) {
  if (provider === "ollama") return getModels(ollamaUrl);
  const key = await providerApiKey(provider);
  if (provider === "deepseek") {
    const { data } = await fetchJson("https://api.deepseek.com/models", {
      headers: { Authorization: `Bearer ${key}` }
    }, 15000, "DeepSeek");
    return (data.data || []).map((model) => ({ name: model.id })).filter((model) => model.name);
  }
  if (provider === "gemini") {
    const models = [];
    let pageToken = "";
    do {
      const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
      url.searchParams.set("pageSize", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const { data } = await fetchJson(url.toString(), {
        headers: { "x-goog-api-key": key }
      }, 15000, "Gemini");
      models.push(...(data.models || [])
        .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
        .map((model) => ({ name: String(model.name || "").replace(/^models\//, "") }))
        .filter((model) => model.name));
      pageToken = data.nextPageToken || "";
    } while (pageToken);
    return models;
  }
  throw new Error("Unknown translation provider.");
}

function broadcastPullProgress(model, payload = {}) {
  const total = Number(payload.total || 0);
  const completed = Number(payload.completed || 0);
  const percent = total ? Math.min(100, Math.round((completed / total) * 100)) : 0;

  try {
    const pending = ext.runtime.sendMessage({
      type: "MODEL_PULL_PROGRESS",
      model,
      status: payload.status || "Downloading…",
      completed,
      total,
      percent
    });
    if (pending?.catch) pending.catch(() => {});
  } catch {}
}

async function pullModel(ollamaUrl, model) {
  const base = normalizeBaseUrl(ollamaUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30 * 60 * 1000);

  try {
    const response = await fetch(`${base}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: true }),
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `${response.status} ${response.statusText}${body ? `: ${body.slice(0, 300)}` : ""}`
      );
    }

    if (!response.body) {
      const result = await response.json();
      if (result.error) throw new Error(result.error);
      broadcastPullProgress(model, { ...result, status: result.status || "success" });
      return result;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let latest = {};

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split("\n");
      buffer = done ? "" : lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const payload = JSON.parse(line);
        if (payload.error) throw new Error(payload.error);
        latest = payload;
        broadcastPullProgress(model, payload);
      }

      if (done) break;
    }

    broadcastPullProgress(model, { ...latest, status: "success", completed: 1, total: 1 });
    return latest;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Model download timed out after 30 minutes.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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

function systemPrompt(targetLanguage, hasContext = false, customPrompt = "") {
  if (String(customPrompt || "").trim()) {
    const custom = String(customPrompt).trim().replace(/\{\{targetLanguage\}\}/gi, targetLanguage);
    if (hasContext) {
      return `${custom} Treat contextSubtitles as reference only for understanding meaning, speakers, names, and continuity. Do not translate or return contextSubtitles unless they also appear in the subtitles translation target list.`;
    }
    return custom;
  }
  const instructions = [
    "You are a subtitle translator.",
    `Translate every requested subtitle into ${targetLanguage}.`,
    "Use natural, concise language suitable for subtitles.",
    "Preserve names, honorifics, punctuation, speaker labels, and intent.",
    "Do not add explanations, notes, analysis, or romanization.",
    "Do not merge, split, omit, or reorder items."
  ];
  if (hasContext) {
    instructions.push(
      "Treat contextSubtitles as reference only for understanding meaning, speakers, names, and continuity.",
      "Do not translate or return contextSubtitles unless they also appear in the subtitles translation target list."
    );
  }
  return instructions.join(" ");
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

async function generateTranslation(prompt, system, opts, structured, itemCount) {
  const timeoutMs = Math.max(15, Number(opts.requestTimeoutSeconds) || 75) * 1000;
  const provider = opts.provider || "ollama";
  if (provider === "ollama") {
    const base = normalizeBaseUrl(opts.ollamaUrl);
    return fetchJson(`${base}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        system,
        prompt,
        stream: false,
        ...(structured ? { format: translationSchema() } : {}),
        think: false,
        keep_alive: "15m",
        options: { temperature: 0, num_predict: structured ? Math.max(256, itemCount * 96) : 192 }
      })
    }, timeoutMs);
  }

  const key = await providerApiKey(provider);
  if (provider === "deepseek") {
    const result = await fetchJson("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: opts.model,
        messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
        stream: false,
        ...(structured ? { response_format: { type: "json_object" } } : {}),
        temperature: 0,
        max_tokens: structured ? Math.max(256, itemCount * 96) : 192
      })
    }, timeoutMs, "DeepSeek");
    return {
      ...result,
      data: {
        response: result.data.choices?.[0]?.message?.content || "",
        done_reason: result.data.choices?.[0]?.finish_reason || "",
        eval_count: result.data.usage?.completion_tokens || 0,
        prompt_eval_count: result.data.usage?.prompt_tokens || 0
      }
    };
  }
  if (provider === "gemini") {
    if (!/^[a-zA-Z0-9._-]+$/.test(opts.model)) {
      throw new Error("Invalid Gemini model name.");
    }
    const result = await fetchJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            ...(structured ? { responseMimeType: "application/json" } : {}),
            maxOutputTokens: structured ? Math.max(256, itemCount * 96) : 192
          }
        })
      }, timeoutMs, "Gemini"
    );
    const candidate = result.data.candidates?.[0];
    return {
      ...result,
      data: {
        response: (candidate?.content?.parts || []).map((part) => part.text || "").join(""),
        done_reason: candidate?.finishReason || result.data.promptFeedback?.blockReason || "",
        eval_count: result.data.usageMetadata?.candidatesTokenCount || 0,
        prompt_eval_count: result.data.usageMetadata?.promptTokenCount || 0
      }
    };
  }
  throw new Error("Unknown translation provider.");
}

async function runStructuredTranslation(items, opts) {
  const input = items.map((item, index) => ({
    id: String(item.id ?? index),
    text: String(item.text ?? "")
  }));
  const contextInput = (opts.contextItems || []).slice(0, 12).map((item) => ({
    position: String(item.position || "nearby"),
    startMs: Number.isFinite(Number(item.startMs)) ? Number(item.startMs) : null,
    text: String(item.text ?? "")
  }));

  const result = await generateTranslation(
    JSON.stringify({
          targetLanguage: opts.targetLanguage,
          subtitles: input,
          ...(contextInput.length ? { contextSubtitles: contextInput } : {})
    }),
    `${systemPrompt(opts.targetLanguage, contextInput.length > 0, opts.customTranslationPrompt)} ` +
      "Return exactly one translation for every input item as JSON with a translations array of {id, text} objects. Preserve each input id.",
    opts, true, input.length
  );

  const data = result.data;
  const rawResponse = String(data.response || "");
  let parsed;

  try {
    parsed = JSON.parse(rawResponse || "{}");
  } catch {
    const error = new Error(`${providerName(opts.provider)} returned invalid structured JSON.`);
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
  const contextInput = (opts.contextItems || []).slice(0, 12).map((entry) => ({
    position: String(entry.position || "nearby"),
    startMs: Number.isFinite(Number(entry.startMs)) ? Number(entry.startMs) : null,
    text: String(entry.text ?? "")
  }));

  const result = await generateTranslation(
    contextInput.length
          ? JSON.stringify({
              subtitleToTranslate: String(item.text ?? ""),
              contextSubtitles: contextInput
            })
          : String(item.text ?? ""),
    `${systemPrompt(opts.targetLanguage, contextInput.length > 0, opts.customTranslationPrompt)} ` +
      "Return only the translated subtitle text. Do not return JSON or a label.",
    opts, false, 1
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

    if (opts.provider !== "ollama" && [401, 403, 404, 429].includes(
      structuredError?.diagnostics?.status
    )) {
      return {
        translations: [],
        failures: items.map((item) => ({
          id: String(item.id ?? "0"),
          text: String(item.text ?? ""),
          error: structuredError.message
        })),
        diagnostics
      };
    }

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

function cacheMetadataKey(cacheId) {
  return `translationCacheMeta:${cacheId}`;
}

function decodeCachePart(value, fallback = "") {
  try {
    return decodeURIComponent(value || "") || fallback;
  } catch {
    return value || fallback;
  }
}

function inferCacheMetadata(cacheId) {
  const [videoId = "unknown", model = "", targetLanguage = ""] = String(cacheId).split(":");
  const decodedModel = decodeCachePart(model, "Unknown model");
  const remoteProvider = decodedModel.match(/^(deepseek|gemini)\/(.+)$/);
  const knownVideo = videoId !== "unknown";
  return {
    videoId,
    showName: "Netflix",
    episodeName: knownVideo ? `Episode ${videoId}` : "Unknown episode",
    title: knownVideo ? `Netflix episode ${videoId}` : "Unknown Netflix episode",
    provider: remoteProvider?.[1] || "ollama",
    model: remoteProvider?.[2] || decodedModel,
    targetLanguage: decodeCachePart(targetLanguage, "Unknown language")
  };
}

function isGenericCacheName(value) {
  return !value || /^(?:Netflix|Unknown Netflix episode|Netflix episode \S+)$/i.test(value);
}

function mergeCacheMetadata(inferred, existing, incoming) {
  const merged = { ...inferred, ...existing, ...incoming };

  for (const field of ["showName", "title"]) {
    if (isGenericCacheName(incoming[field]) && !isGenericCacheName(existing[field])) {
      merged[field] = existing[field];
    }
  }

  if (incoming.episodeName === inferred.episodeName &&
      existing.episodeName && existing.episodeName !== inferred.episodeName) {
    merged.episodeName = existing.episodeName;
  }

  return merged;
}

function fallbackSourceTextFromKey(key) {
  const value = String(key);
  if (value.startsWith("fallback:")) return value.slice("fallback:".length);
  const legacy = value.match(/^-1000:-1000:([\s\S]*)$/);
  return legacy ? legacy[1] : null;
}

function normalizeCachedSourceText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCachedCue(key, translation) {
  const fallbackSourceText = fallbackSourceTextFromKey(key);
  if (fallbackSourceText != null) {
    return {
      startMs: null,
      endMs: null,
      sourceText: fallbackSourceText,
      translatedText: String(translation || ""),
      fallback: true
    };
  }

  const match = String(key).match(/^(-?\d+):(-?\d+):([\s\S]*)$/);
  if (!match) {
    return {
      startMs: null,
      endMs: null,
      sourceText: String(key),
      translatedText: String(translation || ""),
      fallback: true
    };
  }

  return {
    startMs: Number(match[1]),
    endMs: Number(match[2]),
    sourceText: match[3],
    translatedText: String(translation || ""),
    ...(Number(match[1]) < 0 || Number(match[2]) < 0
      ? { fallback: true }
      : {})
  };
}

function storedByteSize(key, value) {
  return new TextEncoder().encode(JSON.stringify({ [key]: value })).byteLength;
}

async function cacheGet(cacheId, keys) {
  const storageKey = cacheStorageKey(cacheId);
  const value = (await ext.storage.local.get(storageKey))[storageKey] || {};
  const found = {};
  for (const key of keys || []) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      found[key] = value[key];
      continue;
    }
    const fallbackText = fallbackSourceTextFromKey(key);
    if (fallbackText == null) continue;
    for (const alias of [
      `fallback:${fallbackText}`,
      `-1000:-1000:${fallbackText}`
    ]) {
      if (Object.prototype.hasOwnProperty.call(value, alias)) {
        found[key] = value[alias];
        break;
      }
    }
  }
  return found;
}

async function reconcileFallbackCache(cacheId, timedCues, metadata = {}) {
  if (!cacheId) throw new Error("A cache ID is required.");
  const storageKey = cacheStorageKey(cacheId);
  const metadataKey = cacheMetadataKey(cacheId);
  const stored = await ext.storage.local.get([storageKey, metadataKey]);
  const entries = { ...(stored[storageKey] || {}) };
  const existingMetadata = stored[metadataKey] || {};
  const timedByText = new Map();

  for (const cue of timedCues || []) {
    const key = String(cue?.key || "");
    const sourceText = normalizeCachedSourceText(cue?.sourceText);
    if (!key || !sourceText || fallbackSourceTextFromKey(key) != null) continue;
    const matches = timedByText.get(sourceText) || [];
    matches.push(key);
    timedByText.set(sourceText, matches);
  }

  let promoted = 0;
  let pruned = 0;
  let ambiguous = 0;
  let unmatched = 0;
  for (const [fallbackKey, translation] of Object.entries(entries)) {
    const fallbackText = fallbackSourceTextFromKey(fallbackKey);
    if (fallbackText == null) continue;
    const matches = timedByText.get(normalizeCachedSourceText(fallbackText)) || [];
    if (matches.length !== 1) {
      if (matches.length > 1) ambiguous += 1;
      else unmatched += 1;
      continue;
    }

    const timedKey = matches[0];
    if (!Object.prototype.hasOwnProperty.call(entries, timedKey)) {
      entries[timedKey] = translation;
      promoted += 1;
    }
    delete entries[fallbackKey];
    pruned += 1;
  }

  if (pruned || Object.keys(metadata || {}).length) {
    const inferred = inferCacheMetadata(cacheId);
    const usefulMetadata = Object.fromEntries(
      Object.entries(metadata || {}).filter(([, value]) => value !== "" && value != null)
    );
    const parsedEntries = Object.entries(entries).map(([key, translation]) =>
      parseCachedCue(key, translation)
    );
    const timedCount = parsedEntries.filter((cue) => !cue.fallback).length;
    const fallbackCount = parsedEntries.length - timedCount;
    await ext.storage.local.set({
      [storageKey]: entries,
      [metadataKey]: {
        ...mergeCacheMetadata(inferred, existingMetadata, usefulMetadata),
        cacheId,
        cueCount: timedCount || fallbackCount,
        fallbackCueCount: fallbackCount,
        updatedAt: new Date().toISOString()
      }
    });
  }

  return { promoted, pruned, ambiguous, unmatched };
}

async function cacheSet(cacheId, entries, metadata = {}) {
  const storageKey = cacheStorageKey(cacheId);
  const metadataKey = cacheMetadataKey(cacheId);
  const stored = await ext.storage.local.get([storageKey, metadataKey]);
  const existing = stored[storageKey] || {};
  const existingMetadata = stored[metadataKey] || {};
  const usefulMetadata = Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== "" && value != null)
  );
  Object.assign(existing, entries || {});
  const inferred = inferCacheMetadata(cacheId);
  const parsedEntries = Object.entries(existing).map(([key, translation]) =>
    parseCachedCue(key, translation)
  );
  const timedCount = parsedEntries.filter((cue) => !cue.fallback).length;
  const fallbackCount = parsedEntries.length - timedCount;
  await ext.storage.local.set({
    [storageKey]: existing,
    [metadataKey]: {
      ...mergeCacheMetadata(inferred, existingMetadata, usefulMetadata),
      cacheId,
      cueCount: timedCount || fallbackCount,
      fallbackCueCount: fallbackCount,
      updatedAt: new Date().toISOString()
    }
  });
}

async function listTranslationCaches() {
  const all = await ext.storage.local.get(null);
  const caches = [];

  for (const [storageKey, entries] of Object.entries(all)) {
    if (!storageKey.startsWith("translationCache:")) continue;
    const cacheId = storageKey.slice("translationCache:".length);
    const metadataKey = cacheMetadataKey(cacheId);
    const metadata = all[metadataKey] || {};
    const inferred = inferCacheMetadata(cacheId);
    const parsedEntries = Object.entries(entries || {}).map(([key, translation]) =>
      parseCachedCue(key, translation)
    );
    const timedCount = parsedEntries.filter((cue) => !cue.fallback).length;
    const fallbackCount = parsedEntries.length - timedCount;
    const showName = !isGenericCacheName(metadata.showName)
      ? metadata.showName
      : !isGenericCacheName(metadata.title)
        ? metadata.title
        : inferred.showName;
    caches.push({
      ...inferred,
      ...metadata,
      showName,
      episodeName: metadata.episodeName || inferred.episodeName,
      cacheId,
      cueCount: timedCount || fallbackCount,
      fallbackCueCount: fallbackCount,
      bytes: storedByteSize(storageKey, entries) +
        (all[metadataKey] ? storedByteSize(metadataKey, all[metadataKey]) : 0)
    });
  }

  caches.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return caches;
}

async function getTranslationCache(cacheId) {
  if (!cacheId) throw new Error("A cache ID is required.");
  const storageKey = cacheStorageKey(cacheId);
  const metadataKey = cacheMetadataKey(cacheId);
  const stored = await ext.storage.local.get([storageKey, metadataKey]);
  const entries = stored[storageKey];
  if (entries === undefined) throw new Error("Cached episode was not found.");

  const inferred = inferCacheMetadata(cacheId);
  const storedMetadata = stored[metadataKey] || {};
  const showName = !isGenericCacheName(storedMetadata.showName)
    ? storedMetadata.showName
    : !isGenericCacheName(storedMetadata.title)
      ? storedMetadata.title
      : inferred.showName;
  const metadata = {
    ...inferred,
    ...storedMetadata,
    showName,
    episodeName: storedMetadata.episodeName || inferred.episodeName,
    cacheId
  };
  const cues = Object.entries(entries || {})
    .map(([key, translation]) => parseCachedCue(key, translation))
    .sort((a, b) => {
      if (a.startMs == null) return b.startMs == null ? 0 : 1;
      if (b.startMs == null) return -1;
      return a.startMs - b.startMs || a.endMs - b.endMs;
    });

  return { metadata, cues };
}

async function deleteTranslationCache(cacheId) {
  if (!cacheId) return false;
  const storageKey = cacheStorageKey(cacheId);
  const exists = (await ext.storage.local.get(storageKey))[storageKey] !== undefined;
  await ext.storage.local.remove([storageKey, cacheMetadataKey(cacheId)]);
  return exists;
}

async function clearTranslationCache() {
  const all = await ext.storage.local.get(null);
  const cacheKeys = Object.keys(all).filter((key) => key.startsWith("translationCache:"));
  const keys = Object.keys(all).filter((key) =>
    key.startsWith("translationCache:") || key.startsWith("translationCacheMeta:")
  );
  if (keys.length) await ext.storage.local.remove(keys);
  return cacheKeys.length;
}

ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "GET_SETTINGS": {
        sendResponse({ ok: true, settings: await getSettings() });
        return;
      }

      case "SAVE_SETTINGS": {
        const patch = { ...(message.settings || {}) };
        if (patch.provider && !["ollama", "deepseek", "gemini"].includes(patch.provider)) {
          throw new Error("Unknown translation provider.");
        }
        for (const keyName of Object.values(PROVIDER_KEYS)) delete patch[keyName];
        await ext.storage.local.set(patch);
        sendResponse({ ok: true, settings: await getSettings() });
        return;
      }

      case "GET_PROVIDER_KEY_STATUS": {
        const keys = await ext.storage.local.get(Object.values(PROVIDER_KEYS));
        sendResponse({ ok: true, configured: {
          deepseek: Boolean(keys.deepseekApiKey),
          gemini: Boolean(keys.geminiApiKey)
        } });
        return;
      }

      case "SET_PROVIDER_KEY": {
        const keyName = PROVIDER_KEYS[message.provider];
        if (!keyName) throw new Error("Unknown translation provider.");
        const key = String(message.key || "").trim();
        if (key) await ext.storage.local.set({ [keyName]: key });
        else await ext.storage.local.remove(keyName);
        sendResponse({ ok: true, configured: Boolean(key) });
        return;
      }

      case "GET_MODELS": {
        const settings = await getSettings();
        const models = await getProviderModels(
          message.provider || settings.provider,
          message.ollamaUrl || settings.ollamaUrl
        );
        sendResponse({ ok: true, models });
        return;
      }

      case "PULL_MODEL": {
        const settings = await getSettings();
        const model = String(message.model || "").trim();
        if (!model) throw new Error("Enter a model name to download.");
        await pullModel(message.ollamaUrl || settings.ollamaUrl, model);
        sendResponse({ ok: true, model });
        return;
      }

      case "OPEN_OPTIONS": {
        await ext.runtime.openOptionsPage();
        sendResponse({ ok: true });
        return;
      }

      case "TRANSLATE_BATCH": {
        const settings = await getSettings();
        const opts = {
          provider: message.provider || settings.provider,
          ollamaUrl: message.ollamaUrl || settings.ollamaUrl,
          model: message.model || settings.model,
          targetLanguage: message.targetLanguage || settings.targetLanguage,
          requestTimeoutSeconds:
            message.requestTimeoutSeconds || settings.requestTimeoutSeconds,
          customTranslationPrompt: settings.customTranslationPrompt || "",
          contextItems: Array.isArray(message.contextItems)
            ? message.contextItems
            : []
        };

        if (!["ollama", "deepseek", "gemini"].includes(opts.provider)) {
          throw new Error("Unknown translation provider.");
        }
        if (!opts.model) throw new Error(`No ${providerName(opts.provider)} model selected.`);
        if (opts.provider !== "ollama") await providerApiKey(opts.provider);

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
            provider: opts.provider,
            targetLanguage: opts.targetLanguage,
            contextCueCount: opts.contextItems.length
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
        await cacheSet(message.cacheId, message.entries || {}, message.metadata || {});
        sendResponse({ ok: true });
        return;
      }

      case "CACHE_RECONCILE_FALLBACK": {
        sendResponse({
          ok: true,
          ...(await reconcileFallbackCache(
            message.cacheId,
            message.timedCues || [],
            message.metadata || {}
          ))
        });
        return;
      }

      case "LIST_TRANSLATION_CACHES": {
        const caches = await listTranslationCaches();
        sendResponse({
          ok: true,
          caches,
          totalBytes: caches.reduce((total, cache) => total + cache.bytes, 0)
        });
        return;
      }

      case "GET_TRANSLATION_CACHE": {
        sendResponse({ ok: true, ...(await getTranslationCache(message.cacheId)) });
        return;
      }

      case "DELETE_TRANSLATION_CACHE": {
        sendResponse({ ok: true, removed: await deleteTranslationCache(message.cacheId) });
        return;
      }

      case "CLEAR_TRANSLATION_CACHE": {
        sendResponse({ ok: true, removed: await clearTranslationCache() });
        return;
      }

      case "APPEND_DEBUG_EVENTS": {
        await appendDiagnosticEvents(message.events || []);
        sendResponse({ ok: true });
        return;
      }

      case "GET_DEBUG_EVENTS": {
        const events = await getDiagnosticEvents();
        sendResponse({
          ok: true,
          events,
          limit: DIAGNOSTIC_LOG_LIMIT,
          bytes: storedByteSize(DIAGNOSTIC_LOG_KEY, events)
        });
        return;
      }

      case "CLEAR_DEBUG_EVENTS": {
        await clearDiagnosticEvents();
        sendResponse({ ok: true });
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
