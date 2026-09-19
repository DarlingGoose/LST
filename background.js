// Firefox loads these through the manifest's background scripts. Chromium's
// service worker takes a single script, so they are imported here, in the order
// the manifest lists them. None is fatal to load: a missing guard skips
// verification, a missing response helper falls back to asking the model for one
// line at a time, and a missing context module sends requests without context
// rather than inventing a rule for choosing it.
try {
  if (typeof importScripts === "function") {
    importScripts(
      "playback-site.js",
      "episode-identity.js",
      "subtitle-import.js",
      "translation-context.js",
      "translation-guard.js",
      "structured-response.js"
    );
  }
} catch (error) {
  console.warn("[LST] Background helpers unavailable:", error);
}

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
  hideNativeSubtitles: true,
  enabledSites: { netflix: true, primevideo: true },
  hudPosition: "",
  showOriginal: false,
  showTranslated: true,
  setupCompleted: false,
  minimumSubtitleDisplaySeconds: 2,
  maximumVisibleSubtitles: 2,
  showStatusMessages: true,
  autoTranslateAhead: true,
  useTranslationContext: false,
  verifyTranslations: true,
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

// A settings key that was renamed keeps its stored value. Reads fall back to the
// legacy spelling with `??` semantics — a stored `false` is a real answer and
// must not be discarded — writes go to the new key only, and the legacy key is
// removed best-effort after a successful write. Cleanup can never fail a save,
// because the new key already holds the value and the fallback read keeps
// working either way.
const RENAMED_SETTING_KEYS = Object.freeze({
  hideNativeSubtitles: "hideNetflixSubtitles"
});
const SETTING_KEYS = Object.freeze([
  ...Object.keys(DEFAULTS),
  ...Object.values(RENAMED_SETTING_KEYS)
]);

function migrateSettings(stored) {
  const settings = {};
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    settings[key] = stored[key] === undefined ? fallback : stored[key];
  }
  for (const [key, legacyKey] of Object.entries(RENAMED_SETTING_KEYS)) {
    if (stored[key] !== undefined) continue;
    if (stored[legacyKey] === undefined) continue;
    settings[key] = stored[legacyKey];
  }
  return settings;
}

ext.runtime.onInstalled.addListener(async (details) => {
  const current = await ext.storage.local.get(SETTING_KEYS);
  const missing = {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (current[key] !== undefined) continue;
    // A legacy value is the user's answer. Writing the default over it would
    // shadow it, so the rename only fills in keys nothing has ever stored.
    const legacyKey = RENAMED_SETTING_KEYS[key];
    if (legacyKey && current[legacyKey] !== undefined) continue;
    missing[key] = value;
  }
  if (!current.model) missing.model = DEFAULTS.model;
  if (current.ollamaModel === undefined) missing.ollamaModel = current.model || DEFAULTS.model;
  if (Object.keys(missing).length) {
    await ext.storage.local.set(missing);
  }

  // First install only: walk the user through provider, language, and layers.
  // Updates, browser restarts, and manual reloads stay silent.
  if (details?.reason !== "install") return;
  try {
    await ext.tabs.create({ url: ext.runtime.getURL("setup.html") });
  } catch (error) {
    console.warn("[LST] Could not open the setup page:", error);
  }
});

function normalizeBaseUrl(url) {
  return (url || DEFAULTS.ollamaUrl).replace(/\/+$/, "");
}

async function getSettings() {
  return migrateSettings(await ext.storage.local.get(SETTING_KEYS));
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

/**
 * Ask the model for the whole batch in one structured request.
 *
 * Never throws because a line or an id came back wrong: a partial answer is
 * returned with the unanswered ids named, so the caller can re-ask for exactly
 * those lines instead of paying for the whole batch again. It throws only when
 * there is nothing to align at all.
 */
async function runStructuredTranslation(items, opts) {
  const responder = globalThis.LSTStructuredResponse;
  if (!responder) throw new Error("Structured response helper did not load.");
  const input = items.map((item, index) => ({
    id: String(item.id ?? index),
    text: String(item.text ?? "")
  }));
  const contextInput = contextPromptItems(opts);

  // The model is handed short ordinals instead of LST's cue keys. A cue key is
  // "<startMs>:<endMs>:<source text>", which local models shorten or translate;
  // an id that comes back changed does not cost the batch any more.
  const ordinals = responder.toOrdinals(input.map((entry) => entry.id));

  const result = await generateTranslation(
    JSON.stringify({
          targetLanguage: opts.targetLanguage,
          subtitles: ordinals.ids.map((id, index) => ({ id, text: input[index].text })),
          ...(contextInput.length ? { contextSubtitles: contextInput } : {})
    }),
    `${systemPrompt(opts.targetLanguage, contextInput.length > 0, opts.customTranslationPrompt)} ` +
      "Return exactly one translation for every input item as JSON with a translations array of {id, text} objects. Copy each input id exactly.",
    opts, true, input.length
  );

  const data = result.data;
  const rawResponse = String(data.response || "");
  const extraction = responder.extractJson(rawResponse);
  const diagnostics = {
    mode: "structured",
    elapsedMs: result.elapsedMs,
    extraction: extraction.strategy,
    rawResponse: truncate(rawResponse),
    doneReason: data.done_reason || "",
    evalCount: data.eval_count || 0,
    promptEvalCount: data.prompt_eval_count || 0
  };

  if (extraction.value === undefined) {
    const error = new Error(`${providerName(opts.provider)} returned invalid structured JSON.`);
    error.diagnostics = {
      ...diagnostics,
      idRecovery: "failed",
      requestedIds: ordinals.ids,
      truncated: extraction.truncated
    };
    throw error;
  }

  const { rows, shape } = responder.readRows(extraction.value);
  const alignment = responder.alignRows(ordinals.ids, rows);
  const originalId = (ordinal) => ordinals.byOrdinal.get(ordinal);

  return {
    translations: alignment.translations.map((entry) => ({
      id: originalId(entry.id),
      text: entry.text
    })),
    missingIds: alignment.missing.map(originalId),
    diagnostics: {
      ...diagnostics,
      idRecovery: alignment.idRecovery,
      responseShape: shape,
      requestedIds: ordinals.ids,
      returnedIds: rows.slice(0, 12).map((row) => truncate(row.id, 40)),
      unexpectedIds: alignment.unexpected.slice(0, 8),
      duplicateIds: alignment.duplicates.slice(0, 8),
      returnedTexts: rows.slice(0, 4).map((row) => truncate(row.text, 140))
    }
  };
}

async function runPlainSingleTranslation(item, opts) {
  const contextInput = contextPromptItems(opts);

  const result = await generateTranslation(
    contextInput.length
          ? JSON.stringify({
              subtitleToTranslate: String(item.text ?? ""),
              contextSubtitles: contextInput
            })
          : String(item.text ?? ""),
    `${systemPrompt(opts.targetLanguage, contextInput.length > 0, opts.customTranslationPrompt)} ` +
      (opts.guardHint ? `${String(opts.guardHint).trim()} ` : "") +
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

// At most this many outstanding lines are re-asked individually per batch, so a
// model that is wrong in a systematic way cannot multiply latency during
// playback. Lines beyond the budget are reported as failures and stay
// uncached, which means the next playback tick asks for them again.
const MAX_ESCALATED_LINES_PER_BATCH = 3;

// A batch that produced nothing at all is usually a size or token problem, so
// it is allowed one split into halves. The split is bounded because every extra
// round trip is latency the viewer waits through.
const MAX_BATCH_SPLIT_DEPTH = 1;

function verificationEnabled(opts) {
  return opts.verifyTranslations !== false;
}

function skippedVerificationSummary(status, count) {
  return { status, checked: 0, accepted: count, rejected: 0, reason: "" };
}

/**
 * Decide whether each returned translation is plausibly written in the target
 * language before it can be cached. Rejected lines are returned separately so
 * the caller can retry just those, instead of discarding the whole batch.
 */
function verifyTranslationResults(items, translations, opts) {
  const guard = globalThis.LSTTranslationGuard;

  // Either the check is switched off, or the guard script did not load. Both
  // keep translating: verification must never be the reason playback stops.
  if (!verificationEnabled(opts)) {
    return {
      accepted: translations,
      rejected: [],
      summary: skippedVerificationSummary("off", translations.length)
    };
  }
  if (!guard) {
    return {
      accepted: translations,
      rejected: [],
      summary: skippedVerificationSummary("unavailable", translations.length)
    };
  }

  const itemsById = new Map(
    items.map((item, index) => [String(item.id ?? index), item])
  );
  const accepted = [];
  const rejected = [];
  const verdicts = [];

  for (const translation of translations || []) {
    const id = String(translation?.id ?? "");
    const source = itemsById.get(id);
    const verdict = guard.verify({
      source: source?.text ?? "",
      translation: translation?.text ?? "",
      targetLanguage: opts.targetLanguage
    });
    verdicts.push(verdict);

    if (verdict.verdict === "reject") {
      rejected.push({
        id,
        text: String(translation?.text ?? ""),
        sourceText: String(source?.text ?? ""),
        verdict
      });
    } else {
      accepted.push(translation);
    }
  }

  return { accepted, rejected, summary: guard.summarize(verdicts) };
}

/**
 * Drop cached entries that are not written in the target language. The cache ID
 * carries the target language, and the cue key carries the source text, so a
 * poisoned entry from before verification existed can be recognized here. The
 * cue then looks uncached and is re-translated, and the fresh result overwrites
 * the stale entry.
 */
function dropUnverifiedCacheEntries(cacheId, entries) {
  const guard = globalThis.LSTTranslationGuard;
  if (!guard) return entries;

  const { targetLanguage } = inferCacheMetadata(cacheId);
  const usable = {};

  for (const [key, translation] of Object.entries(entries || {})) {
    const { sourceText } = parseCachedCue(key, translation);
    const verdict = guard.verify({
      source: sourceText,
      translation,
      targetLanguage
    });
    if (verdict.verdict === "reject") continue;
    usable[key] = translation;
  }

  return usable;
}

/**
 * Re-ask outstanding lines one at a time, handing the model the reason the line
 * is still outstanding, then report whatever still fails so nothing unverified
 * or unanswered reaches the cache.
 *
 * Both kinds of outstanding line take this path: one the guard refused, and one
 * the model never answered at all. They differ only in what the model is told.
 */
async function escalateUnresolved(entries, opts, diagnostics, depth) {
  const guard = globalThis.LSTTranslationGuard;
  const translations = [];
  const failures = [];
  let attempts = 0;

  for (const entry of entries) {
    const unanswered = entry.reason === "not-returned";
    const message = unanswered
      ? "That line was missing from the previous response."
      : guard
        ? guard.describeRejection(entry.verdict)
        : `Verification failed for ${opts.targetLanguage}.`;
    const attempting = attempts < MAX_ESCALATED_LINES_PER_BATCH;
    // The re-ask of an unanswered line is a fresh translation like any other,
    // so it is still verified before it can be cached when verification is on.
    const check = guard && verificationEnabled(opts) ? guard : null;
    const stage = unanswered ? "unanswered" : "verification";
    let recovered = false;

    if (attempting) {
      attempts += 1;
      try {
        const retry = await runPlainSingleTranslation(
          { id: entry.id, text: entry.sourceText },
          {
            ...opts,
            guardHint:
              `${message} Translate this line into ${opts.targetLanguage}.`
          }
        );
        const verdict = check
          ? check.verify({
              source: entry.sourceText,
              translation: retry.translation.text,
              targetLanguage: opts.targetLanguage
            })
          : { verdict: "accept", reason: "guard-unavailable" };

        diagnostics.push({
          stage:
            verdict.verdict === "reject"
              ? `${stage}-retry-rejected`
              : `${stage}-retry-success`,
          depth,
          itemCount: 1,
          elapsedMs: retry.diagnostics?.elapsedMs,
          mode: "plain-fallback",
          verification: check
            ? verdict.verdict === "reject"
              ? { status: "checked", checked: 1, accepted: 0, rejected: 1, reason: verdict.reason }
              : { status: "checked", checked: 1, accepted: 1, rejected: 0, reason: "" }
            : skippedVerificationSummary(
                verificationEnabled(opts) ? "unavailable" : "off",
                verdict.verdict === "reject" ? 0 : 1
              )
        });

        if (verdict.verdict !== "reject") {
          translations.push(retry.translation);
          recovered = true;
        }
      } catch (retryError) {
        diagnostics.push({
          stage: `${stage}-retry-failure`,
          depth,
          ...errorDiagnostics(retryError, 1)
        });
      }
    }

    if (recovered) continue;

    failures.push({
      id: entry.id,
      text: entry.sourceText,
      error: message,
      ...(entry.verdict?.reason ? { verification: entry.verdict.reason } : {}),
      ...(entry.structuredError ? { structuredError: entry.structuredError } : {}),
      ...(unanswered ? { unanswered: true } : {})
    });
    diagnostics.push({
      stage: unanswered ? "unanswered-line" : "verification-rejected",
      depth,
      itemCount: 1,
      retryState: attempting ? "retried-once" : "retry-budget-exhausted",
      reason: unanswered ? "not-returned" : entry.verdict?.reason || "",
      observedScripts: (entry.verdict?.observedScripts || []).join(", "),
      expectedScripts: (entry.verdict?.expectedScripts || []).join(", ")
    });
  }

  return { translations, failures };
}

// An unanswered line is shaped like a rejected one so a single path can handle
// every line the batch still owes the caller.
function unansweredFromIds(items, ids) {
  const sourceById = new Map(
    items.map((item, index) => [String(item.id ?? index), String(item.text ?? "")])
  );
  return (ids || []).map((id) => ({
    id: String(id),
    sourceText: sourceById.get(String(id)) ?? "",
    verdict: null,
    reason: "not-returned"
  }));
}

async function translateBatchResilient(items, opts, depth = 0) {
  if (!items.length) {
    return { translations: [], failures: [], diagnostics: [] };
  }

  const diagnostics = [];
  let accepted = [];
  let rejected = [];
  let missingIds = [];
  let structuredError = null;

  try {
    const result = await runStructuredTranslation(items, opts);
    const check = verifyTranslationResults(items, result.translations, opts);
    accepted = check.accepted;
    rejected = check.rejected;
    missingIds = result.missingIds;
    diagnostics.push({
      stage: "structured-success",
      depth,
      itemCount: items.length,
      alignment: {
        matched: result.translations.length,
        unanswered: missingIds.length
      },
      ...result.diagnostics,
      verification: check.summary
    });
  } catch (error) {
    structuredError = error;
    diagnostics.push({
      stage: "structured-failure",
      depth,
      ...errorDiagnostics(error, items.length)
    });

    // A rejected credential or an exhausted quota will not change on a retry.
    if (opts.provider !== "ollama" && [401, 403, 404, 429].includes(
      error?.diagnostics?.status
    )) {
      return {
        translations: [],
        failures: items.map((item, index) => ({
          id: String(item.id ?? index),
          text: String(item.text ?? ""),
          error: error.message
        })),
        diagnostics
      };
    }

    // Nothing came back at all. Splitting once helps when the batch itself is
    // the problem; past that, the outstanding lines escalate individually.
    if (items.length > 1 && depth < MAX_BATCH_SPLIT_DEPTH) {
      const mid = Math.ceil(items.length / 2);
      const left = await translateBatchResilient(items.slice(0, mid), opts, depth + 1);
      const right = await translateBatchResilient(items.slice(mid), opts, depth + 1);
      return {
        translations: [...left.translations, ...right.translations],
        failures: [...left.failures, ...right.failures],
        diagnostics: [...diagnostics, ...left.diagnostics, ...right.diagnostics]
      };
    }

    missingIds = items.map((item, index) => String(item.id ?? index));
  }

  const outstanding = [...rejected, ...unansweredFromIds(items, missingIds)].map(
    (entry) => ({
      ...entry,
      ...(structuredError ? { structuredError: structuredError.message } : {})
    })
  );

  if (!outstanding.length) {
    return { translations: accepted, failures: [], diagnostics };
  }

  const recovered = await escalateUnresolved(outstanding, opts, diagnostics, depth);

  return {
    translations: [...accepted, ...recovered.translations],
    failures: recovered.failures,
    diagnostics
  };
}

function cacheStorageKey(cacheId) {
  return `translationCache:${cacheId}`;
}

function cacheMetadataKey(cacheId) {
  return `translationCacheMeta:${cacheId}`;
}

// Episode identity — which names are real, which are placeholders, and what a
// cache id says about itself — is decided by episode-identity.js so the
// background, the content script, and the extension's own pages all answer
// those questions the same way. The manifest loads it first; the fallbacks
// below only exist so a broken load order degrades into a stated reason
// instead of an exception.
const episodeIdentity = globalThis.LSTEpisodeIdentity || null;
const UNCLASSIFIED_IDENTITY = Object.freeze({
  decision: "unmerged",
  reason: "episode-identity-unavailable",
  source: "incoming",
});

function inferCacheMetadata(cacheId) {
  if (episodeIdentity) return episodeIdentity.inferCacheMetadata(cacheId);
  // episode-identity.js is loaded before this file by the manifest and by
  // importScripts. If it is missing anyway, read the id directly so callers
  // still get the language a stored translation was written in, and record that
  // the naming rules were unavailable rather than inventing a name.
  const raw = String(cacheId ?? "");
  const namespace = raw.match(/^([a-z0-9]+)~/);
  const decode = (value) => {
    try {
      return decodeURIComponent(value || "");
    } catch {
      return value || "";
    }
  };
  // The service is part of the key. An un-namespaced key belongs to Netflix,
  // which wrote every cache before Prime Video support existed.
  const siteId = namespace ? namespace[1] : "netflix";
  const siteLabel = siteId === "netflix" ? "Netflix" : siteId === "primevideo" ? "Prime Video" : siteId;
  const body = namespace ? raw.slice(namespace[0].length) : raw;
  const firstSeparator = body.indexOf(":");
  const lastSeparator = body.lastIndexOf(":");
  const separated = firstSeparator >= 0 && lastSeparator !== firstSeparator;
  const videoId = separated ? body.slice(0, firstSeparator) : "";
  const knownVideo = Boolean(videoId) && videoId !== "unknown";
  return {
    videoId: knownVideo ? videoId : "unknown",
    siteId,
    showName: siteLabel,
    episodeName: knownVideo ? `Episode ${videoId}` : "Episode details unavailable",
    title: knownVideo ? `${siteLabel} episode ${videoId}` : `Unknown ${siteLabel} episode`,
    provider: "ollama",
    model: (separated && decode(body.slice(firstSeparator + 1, lastSeparator))) ||
      "Unknown model",
    targetLanguage: (separated && decode(body.slice(lastSeparator + 1))) ||
      "Unknown language",
    reason: "episode-identity-unavailable"
  };
}

function preferredCacheName(...values) {
  if (!episodeIdentity) return values.find(Boolean) || "";
  return episodeIdentity.preferredName(...values).name;
}

function mergeCacheMetadata(inferred, existing, incoming) {
  if (!episodeIdentity) {
    return {
      metadata: { ...inferred, ...existing, ...incoming },
      decisions: [{ field: "*", ...UNCLASSIFIED_IDENTITY }]
    };
  }
  return episodeIdentity.mergeCacheMetadata({ inferred, existing, incoming });
}

// Which surrounding lines travel with a translation request is decided by
// translation-context.js, and the background is the last place that can still
// check it: items here arrived in a message, so they are validated rather than
// trusted. The module is loaded before this file by the manifest and by
// importScripts. If it is missing, the request goes out without context and says
// so, rather than falling back to any rule of its own — an index-distance window
// and a silently invented "nearby" label are what this replaced.
const translationContext = globalThis.LSTTranslationContext || null;
const CONTEXT_UNAVAILABLE_REPORT = Object.freeze({
  reason: "translation-context-unavailable",
  refused: 0
});

function sanitizeContextItems(items) {
  if (translationContext) return translationContext.sanitizeContextItems(items);
  // These two strings repeat the module's own vocabulary because a missing
  // module cannot be asked for them. The test suite holds both spellings to the
  // module's constants.
  const sent = Array.isArray(items) ? items.length : 0;
  return {
    reason: CONTEXT_UNAVAILABLE_REPORT.reason,
    items: [],
    refused: sent,
    decisions: sent
      ? [
          {
            decision: "context-items-unavailable",
            reason: CONTEXT_UNAVAILABLE_REPORT.reason,
            index: -1,
            sent
          }
        ]
      : []
  };
}

// The prompt is built from items that already passed the boundary above, so this
// only shapes them for the model. It never supplies a position the boundary did
// not verify, and never shortens the list a second time behind its back.
function contextPromptItems(opts) {
  // A start that is missing stays missing: Number(null) is 0, and telling a model
  // a reference line began at the start of the episode is worse than telling it
  // nothing.
  const startOf = (value) =>
    value === null || value === undefined || value === "" ? null : Number(value);
  return (Array.isArray(opts.contextItems) ? opts.contextItems : []).map((item) => {
    const startMs = startOf(item.startMs);
    return {
      position: item.position,
      startMs: Number.isFinite(startMs) ? startMs : null,
      text: String(item.text ?? "")
    };
  });
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
    const merged = mergeCacheMetadata(inferred, existingMetadata, usefulMetadata);
    await ext.storage.local.set({
      [storageKey]: entries,
      [metadataKey]: {
        ...merged.metadata,
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
  const merged = mergeCacheMetadata(inferred, existingMetadata, usefulMetadata);
  await ext.storage.local.set({
    [storageKey]: existing,
    [metadataKey]: {
      ...merged.metadata,
      cacheId,
      cueCount: timedCount || fallbackCount,
      fallbackCueCount: fallbackCount,
      updatedAt: new Date().toISOString()
    }
  });
  return merged.decisions;
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
    const showName = preferredCacheName(
      metadata.showName,
      metadata.title,
      inferred.showName
    );
    caches.push({
      ...inferred,
      ...metadata,
      showName,
      episodeName: preferredCacheName(metadata.episodeName, inferred.episodeName),
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
  const showName = preferredCacheName(
    storedMetadata.showName,
    storedMetadata.title,
    inferred.showName
  );
  const metadata = {
    ...inferred,
    ...storedMetadata,
    showName,
    episodeName: preferredCacheName(storedMetadata.episodeName, inferred.episodeName),
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

// Subtitle import ------------------------------------------------------------
//
// A viewer watching a title the service does not subtitle can attach a file
// from Jimaku instead. Two requests happen, and only when the viewer asks for
// them: a search against the anonymous Jimaku search proxy that
// subtitlebot.com serves (no account, no key), and a download of one subtitle
// file from the URL Jimaku's own entry page publishes. Listing the files of an
// entry is the one step that needs the viewer's own Jimaku API key, because
// Jimaku asks for one.
//
// Neither host is a required permission: `optional_host_permissions` in the
// manifest lists them and the options page asks for them at the moment of the
// first import. Every URL that is fetched here comes from `subtitle-import.js`,
// which resolves a listed file against the origin it was listed on and refuses
// one that names another host, so a listing can never send this worker
// somewhere the extension is not allowed to go.
//
// The file's text is stored verbatim, keyed by episode, and is handed to the
// content script when the page asks for it. It is never sent to a translation
// provider unless the viewer's own settings decide that it should be.

const subtitleImport = globalThis.LSTSubtitleImport || null;
const IMPORT_TIMEOUT_MS = 20000;
const IMPORT_DOWNLOAD_TIMEOUT_MS = 45000;

function importApi() {
  if (!subtitleImport) {
    throw new Error(
      "Subtitle import is unavailable in this build. Reload the extension and try again.",
    );
  }
  return subtitleImport;
}

// The storage keys, limits and origins have one owner: the import module. This
// file reads them instead of spelling them again, so the pages, the player and
// the worker cannot end up disagreeing about where an imported subtitle lives.
function importTracksStorageKey() {
  return importApi().IMPORTED_TRACKS_KEY;
}

function importKeyStorage() {
  return importApi().JIMAKU_KEY_STORAGE;
}

function findingStorageKey() {
  return importApi().JIMAKU_FINDINGS_KEY;
}

// What Jimaku held for a show when LST last asked. Read on arrival at an episode
// so the player can say what exists without contacting anyone: a note is only
// ever as fresh as the last search the viewer ran, and it carries the time it
// was taken.
//
// A note that is too old to be trusted, or that cannot be read at all, is
// dropped here rather than handed to the player as an answer.
async function jimakuFindings() {
  const storageKey = findingStorageKey();
  const stored = await ext.storage.local.get(storageKey);
  const value = stored[storageKey];
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const notes = {};
  let dropped = 0;
  for (const [showKey, note] of Object.entries(raw)) {
    const normalized = importApi().normalizeJimakuFinding({ ...note, showKey: note?.showKey || showKey });
    if (!normalized || importApi().findingIsExpired(normalized, Date.now())) {
      dropped += 1;
      continue;
    }
    notes[normalized.showKey] = normalized;
  }
  if (dropped) await ext.storage.local.set({ [storageKey]: notes });
  return notes;
}

async function writeJimakuFindings(notes) {
  const storageKey = findingStorageKey();
  const limit = importApi().JIMAKU_FINDING_LIMIT;
  const entries = Object.entries(notes);
  if (entries.length > limit) {
    // Oldest note first, so the limit removes what the viewer stopped watching.
    entries.sort((left, right) =>
      String(left[1]?.checkedAt || "").localeCompare(String(right[1]?.checkedAt || "")),
    );
    for (const [key] of entries.slice(0, entries.length - limit)) {
      delete notes[key];
    }
  }
  await ext.storage.local.set({ [storageKey]: notes });
}

// A note the viewer can see is a note the viewer can drop: asking Jimaku about a
// show is something LST did for them, and it is theirs to forget.
async function forgetJimakuFinding(showKey) {
  const key = String(showKey || "").trim();
  if (!key) return false;
  const notes = await jimakuFindings();
  if (!Object.prototype.hasOwnProperty.call(notes, key)) return false;
  delete notes[key];
  await writeJimakuFindings(notes);
  return true;
}

async function rememberJimakuFinding(note) {
  const normalized = importApi().normalizeJimakuFinding(note);
  if (!normalized) return null;
  const notes = await jimakuFindings();
  notes[normalized.showKey] = normalized;
  await writeJimakuFindings(notes);
  return normalized;
}

async function importFetch(url, init = {}, timeoutMs = IMPORT_TIMEOUT_MS, label = "Subtitle source") {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      if (response.status === 401) {
        // Only a request that carried a key can fail for the key's sake; a
        // download sends none, so a 401 there means something else.
        throw new Error(
          init?.headers?.Authorization
            ? "Jimaku refused the request. Check the API key saved in LST."
            : "Jimaku refused the download; the file may have been removed from the entry.",
        );
      }
      if (response.status === 429) {
        throw new Error("Jimaku is rate limiting this address. Try again shortly.");
      }
      throw new Error(`${label} replied ${response.status} ${response.statusText}`.trim());
    }
    return response;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${label} did not answer within ${Math.round(timeoutMs / 1000)}s.`);
    }
    if (error instanceof TypeError) {
      // A blocked or refused request arrives as a TypeError with no detail; the
      // likely cause is a host permission the viewer has not granted yet.
      throw new Error(
        `LST could not reach ${label}. Allow access to it when the browser asks, then retry.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function importJson(url, init, label) {
  const response = await importFetch(url, init, IMPORT_TIMEOUT_MS, label);
  return response.json();
}

async function jimakuApiKey() {
  const storageKey = importKeyStorage();
  const stored = await ext.storage.local.get(storageKey);
  return String(stored[storageKey] || "").trim();
}

async function importedTracks() {
  const storageKey = importTracksStorageKey();
  const stored = await ext.storage.local.get(storageKey);
  const value = stored[storageKey];
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function writeImportedTracks(tracks) {
  const storageKey = importTracksStorageKey();
  const limit = importApi().IMPORTED_TRACK_LIMIT;
  const entries = Object.entries(tracks);
  if (entries.length > limit) {
    // Oldest import first, so the limit removes what the viewer stopped using.
    entries.sort((left, right) =>
      String(left[1]?.importedAt || "").localeCompare(String(right[1]?.importedAt || "")),
    );
    for (const [key] of entries.slice(0, entries.length - limit)) {
      delete tracks[key];
    }
  }
  await ext.storage.local.set({ [storageKey]: tracks });
}

function importTrackSummary(track) {
  const api = importApi();
  return api.trackSummary(api.normalizeImportedTrack(track) || track) || null;
}

async function importSearch(query, options = {}) {
  const api = importApi();
  const text = String(query || "").trim();
  if (!text) throw new Error("Enter a show name to search for.");
  const url = api.searchUrl(text, options);
  const payload = await importJson(url, {}, "The subtitle search service");
  const result = {
    query: text,
    source: api.SUBTITLEBOT_ORIGIN,
    ...api.parseSearchResults(payload),
  };
  // A search the viewer ran is also the answer to "does Jimaku have subtitles
  // for this show", so it is kept as a note for that show and handed back with
  // the results. Only a caller that knows which show this is can file it.
  const showKey = String(options.showKey || "").trim();
  const finding = showKey
    ? await rememberJimakuFinding(
        api.findingFromSearch({
          showKey,
          siteId: options.siteId,
          showName: options.showName,
          query: text,
          entries: result.entries,
          checkedAt: new Date().toISOString(),
        }),
      )
    : null;
  return { ...result, finding };
}

async function importListFiles(entryId, episode, options = {}) {
  const api = importApi();
  const id = Number(entryId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("Choose a show first.");
  const key = await jimakuApiKey();
  if (!key) {
    throw new Error(
      "Jimaku asks for an API key to list an entry's files. Create one on your Jimaku account page and save it here.",
    );
  }
  const url = api.filesUrl(id, Number.isInteger(episode) ? episode : undefined);
  const payload = await importJson(url, { headers: { Authorization: key } }, "Jimaku");
  const result = { entryId: id, ...api.parseFileList(payload) };
  // Listing the files sharpens the note the search left: it is the difference
  // between "Jimaku knows this show" and "there is a file for this episode".
  const showKey = String(options.showKey || "").trim();
  let finding = null;
  if (showKey) {
    const notes = await jimakuFindings();
    finding = await rememberJimakuFinding(
      api.findingForFiles({
        finding: notes[showKey],
        entryId: id,
        entryName: options.entryName,
        files: result.files,
        episode,
        checkedAt: new Date().toISOString(),
      }),
    );
  }
  return { ...result, finding };
}

// Every way a piece of text can fail to become a track, said once. The reasons
// come from the module, and this is the only place that turns one into a
// sentence a viewer reads.
function importRefusal(reason, details = {}) {
  const api = importApi();
  switch (reason) {
    case api.TRACK_TEXT_REFUSAL.empty:
      return details.source === api.TRACK_SOURCE.localFile
        ? "That file is empty."
        : "That file arrived empty.";
    case api.TRACK_TEXT_REFUSAL.tooLarge:
      return "That file is larger than LST will store for one episode.";
    case api.TRACK_TEXT_REFUSAL.unsupportedFormat:
      return `${details.formatLabel || "That format"} subtitles cannot be read yet. Choose a SubRip (.srt), WebVTT, or TTML file.`;
    case api.TRACK_TEXT_REFUSAL.unknownFormat:
      return "LST could not tell what subtitle format that file is. Choose a SubRip (.srt), WebVTT, or TTML file.";
    case api.TRACK_TEXT_REFUSAL.unreadableCues:
      return "That file has no readable SubRip cues.";
    case api.TRACK_TEXT_REFUSAL.notTimedText:
      return `That file is named as ${details.formatLabel || "subtitles"} but holds no subtitle timings.`;
    default:
      return "That file cannot be used as subtitles for this episode.";
  }
}

// The format is checked before a download starts, so a file LST cannot read is
// never fetched in the first place.
function importFormatRefusal(fileName) {
  const api = importApi();
  const format = api.subtitleFormat(fileName);
  if (format.supported) return null;
  const reason =
    format.reason === api.FORMAT_REASON.unknown
      ? api.TRACK_TEXT_REFUSAL.unknownFormat
      : api.TRACK_TEXT_REFUSAL.unsupportedFormat;
  return { reason, formatLabel: format.label };
}

// One record shape for both sources: where a file came from changes which of
// these fields are filled, never what a track is.
function importedTrackRecord({ episodeKey, source, entry = {}, file = {}, facts, text }) {
  return {
    episodeKey,
    source,
    entryId: Number(entry.entryId) || Number(file.entryId) || 0,
    entryName: String(entry.displayName || entry.name || ""),
    entryUrl: String(entry.pageUrl || ""),
    fileName: facts.fileName || String(file.name || ""),
    fileUrl: String(facts.fileUrl || ""),
    size: Number(file.size) || facts.bytes,
    lastModified: String(file.lastModified || ""),
    format: facts.format,
    language: facts.language,
    languageCode: facts.languageCode,
    translate: facts.translate,
    translateReason: facts.translateReason,
    cueCount: facts.cueCount,
    importedAt: new Date().toISOString(),
    // A newly imported file starts where its own timeline says: the correction
    // belongs to a file, and this is a different file from the one the viewer
    // may have corrected before.
    timingOffsetMs: 0,
    text,
  };
}

async function storeImportedTrack(track) {
  const tracks = await importedTracks();
  tracks[track.episodeKey] = track;
  await writeImportedTracks(tracks);
}

function importedTrackResponse(track, facts) {
  return { ...importTrackSummary(track), episodeMatch: facts.episodeMatch || null };
}

// Download one file and file it under the episode the viewer is watching. The
// viewer's language settings decide whether that track will need translating;
// the decision and its reason are stored with the track so the player can act
// on it without asking again.
async function importTrack({ episodeKey, entry = {}, file = {}, translate, episode } = {}) {
  const api = importApi();
  const key = String(episodeKey || "").trim();
  if (!key) {
    throw new Error("Open a supported playback page before importing subtitles.");
  }
  const resolved = api.resolveJimakuUrl(file.url);
  if (!resolved.ok) {
    throw new Error(
      resolved.reason === "file-url-off-origin"
        ? "That file is not served by Jimaku, so LST will not download it."
        : "That file has no usable download address.",
    );
  }
  const refused = importFormatRefusal(file.name);
  if (refused) throw new Error(importRefusal(refused.reason, refused));

  const settings = await getSettings();
  const response = await importFetch(resolved.url, {}, IMPORT_DOWNLOAD_TIMEOUT_MS, "Jimaku");
  const text = await response.text();

  const facts = api.describeTextTrack({
    fileName: file.name,
    text,
    language: file.language,
    languageCode: file.languageCode,
    targetLanguage: settings.targetLanguage,
    translate,
    episode,
    fileEpisode: file.episode,
  });
  if (!facts.ok) throw new Error(importRefusal(facts.reason, facts));

  const track = importedTrackRecord({
    episodeKey: key,
    source: api.TRACK_SOURCE.jimaku,
    entry,
    file,
    facts: { ...facts, fileUrl: resolved.url },
    text,
  });
  await storeImportedTrack(track);
  return importedTrackResponse(track, facts);
}

// A subtitle file the viewer already has on disk. Nothing is fetched and no
// host permission is involved: the extension's own options page reads the file
// the viewer picked and hands the text over, so the only thing that leaves the
// device is what a translation provider is sent for a track that needs
// translating — exactly as for any other track.
async function importLocalTrack({ episodeKey, fileName, text, size, translate, episode } = {}) {
  const api = importApi();
  const key = String(episodeKey || "").trim();
  if (!key) {
    throw new Error("Open a supported playback page before importing subtitles.");
  }
  const name = String(fileName || "").trim();
  if (!name) throw new Error("Choose a subtitle file to import.");

  const settings = await getSettings();
  const facts = api.describeTextTrack({
    fileName: name,
    text,
    targetLanguage: settings.targetLanguage,
    translate,
    episode,
  });
  if (!facts.ok) {
    throw new Error(importRefusal(facts.reason, { ...facts, source: api.TRACK_SOURCE.localFile }));
  }

  const track = importedTrackRecord({
    episodeKey: key,
    source: api.TRACK_SOURCE.localFile,
    file: { name, size },
    facts,
    text,
  });
  await storeImportedTrack(track);
  return importedTrackResponse(track, facts);
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
        // The Jimaku key is stored like a provider key, not like a preference:
        // it is written by its own message and never by a settings save. The
        // module owns its storage key, and is not loaded in every context that
        // calls this router, so the key cannot be named here.
        try {
          delete patch[importKeyStorage()];
        } catch {
          // The import module is missing; its key was never written either.
        }
        await ext.storage.local.set(patch);
        const legacyKeys = Object.entries(RENAMED_SETTING_KEYS)
          .filter(([key]) => patch[key] !== undefined)
          .map(([, legacyKey]) => legacyKey);
        if (legacyKeys.length) {
          try {
            await ext.storage.local.remove(legacyKeys);
          } catch (error) {
            // The value is already stored under the new key and the fallback
            // read still resolves it, so cleanup failing is not a failed save.
            console.warn("[LST] Could not remove a renamed setting:", error);
          }
        }
        sendResponse({ ok: true, settings: await getSettings() });
        return;
      }

      case "GET_IMPORT_KEY_STATUS": {
        sendResponse({ ok: true, configured: Boolean(await jimakuApiKey()) });
        return;
      }

      case "SET_IMPORT_KEY": {
        const key = String(message.key || "").trim();
        const storageKey = importKeyStorage();
        if (key) await ext.storage.local.set({ [storageKey]: key });
        else await ext.storage.local.remove(storageKey);
        sendResponse({ ok: true, configured: Boolean(key) });
        return;
      }

      case "IMPORT_SEARCH": {
        sendResponse({
          ok: true,
          ...(await importSearch(message.query, {
            anime: message.anime !== false,
            limit: message.limit,
            showKey: message.showKey,
            showName: message.showName,
            siteId: message.siteId,
          })),
        });
        return;
      }

      case "IMPORT_LIST_FILES": {
        sendResponse({
          ok: true,
          ...(await importListFiles(message.entryId, message.episode, {
            showKey: message.showKey,
            entryName: message.entryName,
          })),
        });
        return;
      }

      // What LST last learned about a show. Read when an episode starts, so the
      // player can say what Jimaku holds without asking anyone — a note is only
      // ever as old as the last search the viewer ran.
      case "GET_JIMAKU_FINDING": {
        const showKey = String(message.showKey || "").trim();
        if (!showKey) {
          sendResponse({ ok: true, finding: null, reason: importApi().FINDING_REASON.noShowKey });
          return;
        }
        const notes = await jimakuFindings();
        const finding = notes[showKey] || null;
        sendResponse({
          ok: true,
          finding,
          reason: finding ? "ok" : importApi().FINDING_REASON.none,
        });
        return;
      }

      case "DELETE_JIMAKU_FINDING": {
        sendResponse({ ok: true, removed: await forgetJimakuFinding(message.showKey) });
        return;
      }

      case "IMPORT_TRACK": {
        sendResponse({
          ok: true,
          track: await importTrack({
            episodeKey: message.episodeKey,
            entry: message.entry,
            file: message.file,
            translate: message.translate,
            episode: message.episode,
          }),
        });
        return;
      }

      // A file the viewer already has. No request is made for it, so this
      // handler is the only import path that cannot fail for want of network or
      // a host permission.
      case "IMPORT_TRACK_TEXT": {
        sendResponse({
          ok: true,
          track: await importLocalTrack({
            episodeKey: message.episodeKey,
            fileName: message.fileName,
            text: message.text,
            size: message.size,
            translate: message.translate,
            episode: message.episode,
          }),
        });
        return;
      }

      case "GET_IMPORTED_TRACK": {
        const api = importApi();
        const episodeKey = String(message.episodeKey || "").trim();
        if (!episodeKey) {
          sendResponse({ ok: true, track: null, reason: "no-episode-key" });
          return;
        }
        const tracks = await importedTracks();
        const track = api.normalizeImportedTrack(tracks[episodeKey]);
        sendResponse({
          ok: true,
          track,
          reason: track ? "ok" : "not-imported",
        });
        return;
      }

      case "LIST_IMPORTED_TRACKS": {
        const api = importApi();
        const tracks = await importedTracks();
        const summaries = [];
        for (const [episodeKey, track] of Object.entries(tracks)) {
          const normalized = api.normalizeImportedTrack(track);
          if (normalized) summaries.push(api.trackSummary(normalized));
          else summaries.push({ episodeKey, hasText: false, reason: "unreadable-track" });
        }
        summaries.sort((left, right) =>
          String(right.importedAt || "").localeCompare(String(left.importedAt || "")),
        );
        sendResponse({
          ok: true,
          tracks: summaries,
          bytes: api.importedTrackBytes(tracks),
          limit: api.IMPORTED_TRACK_LIMIT,
        });
        return;
      }

      case "DELETE_IMPORTED_TRACK": {
        const episodeKey = String(message.episodeKey || "").trim();
        const tracks = await importedTracks();
        const existed = Object.prototype.hasOwnProperty.call(tracks, episodeKey);
        delete tracks[episodeKey];
        await writeImportedTracks(tracks);
        sendResponse({ ok: true, removed: existed });
        return;
      }

      case "SET_IMPORTED_TRACK_TIMING": {
        // Where a file's own timeline sits on the video's clock belongs to the
        // file, so the correction is stored with it and for the episode it was
        // imported for. A correction for an episode with no imported file is
        // refused rather than kept, because nothing would ever read it.
        const api = importApi();
        const episodeKey = String(message.episodeKey || "").trim();
        if (!episodeKey) {
          sendResponse({ ok: true, track: null, reason: "no-episode-key" });
          return;
        }
        const tracks = await importedTracks();
        const track = api.normalizeImportedTrack(tracks[episodeKey]);
        if (!track) {
          sendResponse({ ok: true, track: null, reason: "not-imported" });
          return;
        }
        track.timingOffsetMs = api.normalizeFileTiming(message.offsetMs);
        tracks[episodeKey] = track;
        await writeImportedTracks(tracks);
        sendResponse({
          ok: true,
          track: api.trackSummary(track),
          timing: api.describeFileTiming(track.timingOffsetMs),
          reason: "ok",
        });
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
        // openOptionsPage() cannot name a panel, and the import card lives in
        // one, so a caller that was asked for a specific card gets it through a
        // tab of LST's own. The hash is checked against the one the options page
        // honours rather than passed along.
        const hash = message.hash === "#import" ? "#import" : "";
        if (hash) {
          await ext.tabs.create({ url: ext.runtime.getURL(`options.html${hash}`) });
        } else {
          await ext.runtime.openOptionsPage();
        }
        sendResponse({ ok: true, hash });
        return;
      }

      case "TRANSLATE_BATCH": {
        const settings = await getSettings();
        const context = {
          ...sanitizeContextItems(message.contextItems),
          sent: Array.isArray(message.contextItems) ? message.contextItems.length : 0
        };
        const opts = {
          provider: message.provider || settings.provider,
          ollamaUrl: message.ollamaUrl || settings.ollamaUrl,
          model: message.model || settings.model,
          targetLanguage: message.targetLanguage || settings.targetLanguage,
          requestTimeoutSeconds:
            message.requestTimeoutSeconds || settings.requestTimeoutSeconds,
          customTranslationPrompt: settings.customTranslationPrompt || "",
          verifyTranslations: settings.verifyTranslations !== false,
          // Context arrives in a message, so it is checked here, once, before it
          // can reach a provider: the report travels back with the response so
          // the content script can tell the viewer why a line was left out.
          contextItems: context.items,
          contextItemsSent: context.sent,
          contextReport: context
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
            contextCueCount: opts.contextItems.length,
            contextSentCues: context.sent,
            contextReason: context.reason,
            contextRefusedCues: context.refused || 0,
            contextDecisions: context.decisions || []
          }
        });
        return;
      }

      case "CACHE_GET": {
        const entries = await cacheGet(message.cacheId, message.keys || []);
        sendResponse({
          ok: true,
          entries: verificationEnabled(await getSettings())
            ? dropUnverifiedCacheEntries(message.cacheId, entries)
            : entries
        });
        return;
      }

      case "CACHE_SET": {
        const decisions = await cacheSet(
          message.cacheId,
          message.entries || {},
          message.metadata || {}
        );
        sendResponse({ ok: true, decisions: decisions || [] });
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
