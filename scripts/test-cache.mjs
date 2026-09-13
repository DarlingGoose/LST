import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const values = {};
let messageHandler;
let installedHandler;
const fetchRequests = [];

async function mockFetch(url, init = {}) {
  fetchRequests.push({ url, init });
  const body = JSON.parse(init.body || "{}");
  const prompt = JSON.parse(body.prompt || "{}");
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    async json() {
      return {
        response: JSON.stringify({
          translations: (prompt.subtitles || []).map((item) => ({
            id: item.id,
            text: `translated:${item.text}`,
          })),
        }),
        done_reason: "stop",
      };
    },
  };
}

const storage = {
  async get(query) {
    if (query == null) return { ...values };
    if (typeof query === "string") return { [query]: values[query] };
    if (Array.isArray(query)) {
      return Object.fromEntries(query.map((key) => [key, values[key]]));
    }
    return Object.fromEntries(
      Object.entries(query).map(([key, fallback]) => [key, values[key] ?? fallback])
    );
  },
  async set(entries) {
    Object.assign(values, entries);
  },
  async remove(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
  }
};

const context = vm.createContext({
  AbortController,
  console,
  Date,
  fetch: mockFetch,
  setTimeout,
  clearTimeout,
  TextDecoder,
  TextEncoder,
  URL,
  chrome: {
    runtime: {
      onInstalled: { addListener(handler) { installedHandler = handler; } },
      onMessage: { addListener(handler) { messageHandler = handler; } },
      sendMessage: async () => {},
      openOptionsPage: async () => {}
    },
    storage: { local: storage }
  }
});

const source = await fs.readFile(new URL("../background.js", import.meta.url), "utf8");
vm.runInContext(source, context, { filename: "background.js" });

await installedHandler();
assert.equal(values.model, "translategemma:4b");
assert.equal(values.showQuickPills, true);
assert.equal(values.showTranscriptSidebar, false);
assert.equal(values.useTranslationContext, false);

let response = await send({
  type: "TRANSLATE_BATCH",
  model: "test-model",
  targetLanguage: "English",
  items: [{ id: "target", text: "対象" }],
  contextItems: [
    { position: "before", startMs: 1000, text: "前" },
    { position: "after", startMs: 3000, text: "後" },
  ],
});
assert.equal(response.translations.length, 1);
assert.equal(response.translations[0].id, "target");
assert.equal(response.summary.contextCueCount, 2);
const contextRequestBody = JSON.parse(fetchRequests.at(-1).init.body);
const contextPrompt = JSON.parse(contextRequestBody.prompt);
assert.equal(contextPrompt.subtitles.length, 1);
assert.equal(contextPrompt.contextSubtitles.length, 2);
assert.match(contextRequestBody.system, /reference only/i);

function send(message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out: ${message.type}`)), 1000);
    messageHandler(message, {}, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

const cacheId = "8123:qwen3%3A8b:English";
await send({
  type: "CACHE_SET",
  cacheId,
  entries: { "0:1000:こんにちは": "Hello" },
  metadata: {
    videoId: "8123",
    title: "Example Show: Episode 1",
    showName: "Example Show",
    episodeName: "S1:E1 The Beginning",
    model: "qwen3:8b",
    targetLanguage: "English",
    sourceCueCount: 24
  }
});

response = await send({ type: "LIST_TRANSLATION_CACHES" });
assert.equal(response.ok, true);
assert.equal(response.caches.length, 1);
assert.equal(response.caches[0].title, "Example Show: Episode 1");
assert.equal(response.caches[0].showName, "Example Show");
assert.equal(response.caches[0].episodeName, "S1:E1 The Beginning");
assert.equal(response.caches[0].cueCount, 1);
assert.equal(response.caches[0].sourceCueCount, 24);
assert.equal(response.caches[0].model, "qwen3:8b");
assert.ok(response.caches[0].bytes > 0);
assert.equal(response.totalBytes, response.caches[0].bytes);

response = await send({ type: "GET_TRANSLATION_CACHE", cacheId });
assert.equal(response.metadata.showName, "Example Show");
assert.equal(response.metadata.episodeName, "S1:E1 The Beginning");
assert.deepEqual(JSON.parse(JSON.stringify(response.cues)), [{
  startMs: 0,
  endMs: 1000,
  sourceText: "こんにちは",
  translatedText: "Hello"
}]);

await send({
  type: "CACHE_SET",
  cacheId,
  entries: { "1000:2000:世界": "World" },
  metadata: { showName: "Example Show", episodeName: "" }
});
response = await send({ type: "LIST_TRANSLATION_CACHES" });
assert.equal(response.caches[0].episodeName, "S1:E1 The Beginning");
assert.equal(response.caches[0].cueCount, 2);
await send({
  type: "CACHE_SET",
  cacheId,
  entries: {},
  metadata: {
    showName: "Netflix",
    title: "Netflix episode 8123",
    episodeName: "Episode 8123"
  }
});
response = await send({ type: "LIST_TRANSLATION_CACHES" });
assert.equal(response.caches[0].showName, "Example Show");
assert.equal(response.caches[0].episodeName, "S1:E1 The Beginning");
response = await send({ type: "GET_TRANSLATION_CACHE", cacheId });
assert.deepEqual(
  JSON.parse(JSON.stringify(response.cues.map((cue) => cue.startMs))),
  [0, 1000]
);

response = await send({ type: "DELETE_TRANSLATION_CACHE", cacheId });
assert.equal(response.removed, true);
assert.equal((await send({ type: "LIST_TRANSLATION_CACHES" })).caches.length, 0);

values["translationCache:9999:legacy-model:Japanese"] = { cue: "翻訳" };
response = await send({ type: "LIST_TRANSLATION_CACHES" });
assert.equal(response.caches[0].title, "Netflix episode 9999");
assert.equal(response.caches[0].showName, "Netflix");
assert.equal(response.caches[0].episodeName, "Episode 9999");
assert.equal(response.caches[0].model, "legacy-model");
response = await send({
  type: "GET_TRANSLATION_CACHE",
  cacheId: "9999:legacy-model:Japanese"
});
assert.equal(response.cues[0].sourceText, "cue");
assert.equal(response.cues[0].translatedText, "翻訳");

const reconciliationCacheId = "81769818:test-model:English";
await send({
  type: "CACHE_SET",
  cacheId: reconciliationCacheId,
  entries: {
    "fallback:unique line": "Unique translation",
    "-1000:-1000:legacy line": "Legacy translation",
    "fallback:repeated line": "Ambiguous translation",
    "fallback:unmatched line": "Unmatched translation"
  },
  metadata: {
    showName: "Example Show",
    episodeName: "Episode 50",
    sourceCueCount: 4
  }
});

response = await send({
  type: "CACHE_GET",
  cacheId: reconciliationCacheId,
  keys: ["fallback:legacy line"]
});
assert.equal(response.entries["fallback:legacy line"], "Legacy translation");

response = await send({
  type: "CACHE_RECONCILE_FALLBACK",
  cacheId: reconciliationCacheId,
  timedCues: [
    { key: "0:1000:unique line", sourceText: "unique line" },
    { key: "1000:2000:legacy line", sourceText: "legacy line" },
    { key: "2000:3000:repeated line", sourceText: "repeated line" },
    { key: "3000:4000:repeated line", sourceText: "repeated line" }
  ]
});
assert.equal(response.promoted, 2);
assert.equal(response.pruned, 2);
assert.equal(response.ambiguous, 1);
assert.equal(response.unmatched, 1);

response = await send({
  type: "GET_TRANSLATION_CACHE",
  cacheId: reconciliationCacheId
});
assert.equal(
  response.cues.find((cue) => cue.startMs === 0)?.translatedText,
  "Unique translation"
);
assert.equal(
  response.cues.find((cue) => cue.startMs === 1000)?.translatedText,
  "Legacy translation"
);
assert.equal(
  response.cues.filter((cue) => cue.fallback).length,
  2
);
response = await send({ type: "LIST_TRANSLATION_CACHES" });
const reconciledCache = response.caches.find(
  (cache) => cache.cacheId === reconciliationCacheId
);
assert.equal(reconciledCache.cueCount, 2);
assert.equal(reconciledCache.fallbackCueCount, 2);

response = await send({ type: "CLEAR_TRANSLATION_CACHE" });
assert.equal(response.removed, 2);
assert.equal((await send({ type: "LIST_TRANSLATION_CACHES" })).caches.length, 0);

await send({
  type: "APPEND_DEBUG_EVENTS",
  events: [{
    timestamp: 123,
    level: "warning",
    category: "rendering",
    event: "subtitle-cleared",
    videoId: "8123",
    videoTime: 42.1256,
    cue: "41000:43000",
    details: {
      reason: "test",
      url: "https://example.invalid/?token=secret",
      subtitleText: "private subtitle",
      observations: [{ lengths: [{ length: 12, textId: "text-1" }] }],
    },
  }],
});
response = await send({ type: "GET_DEBUG_EVENTS" });
assert.equal(response.events.length, 1);
assert.equal(response.events[0].videoTime, 42.126);
assert.equal(response.events[0].details.reason, "test");
assert.equal(response.events[0].details.url, "[redacted]");
assert.equal(response.events[0].details.subtitleText, "[redacted]");
assert.equal(response.events[0].details.observations[0].lengths[0].length, 12);
assert.equal(response.events[0].details.observations[0].lengths[0].textId, "text-1");
assert.ok(response.bytes > 0);
await send({ type: "CLEAR_DEBUG_EVENTS" });
assert.equal((await send({ type: "GET_DEBUG_EVENTS" })).events.length, 0);

for (let batch = 0; batch < 8; batch++) {
  await send({
    type: "APPEND_DEBUG_EVENTS",
    events: Array.from({ length: 100 }, (_, index) => ({
      timestamp: batch * 100 + index + 1,
      level: "info",
      category: "test",
      event: "bounded-event",
    })),
  });
}
response = await send({ type: "GET_DEBUG_EVENTS" });
assert.equal(response.events.length, 750);
assert.equal(response.events[0].timestamp, 51);
values["translationCache:debug-clear-test:model:English"] = { cue: "translation" };
await send({ type: "CLEAR_DEBUG_EVENTS" });
assert.deepEqual(values["translationCache:debug-clear-test:model:English"], {
  cue: "translation",
});

console.log("Translation cache management checks passed.");
