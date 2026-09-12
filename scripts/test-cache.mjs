import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const values = {};
let messageHandler;
let installedHandler;

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
  fetch,
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

let response = await send({ type: "LIST_TRANSLATION_CACHES" });
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

response = await send({ type: "CLEAR_TRANSLATION_CACHE" });
assert.equal(response.removed, 1);
assert.equal((await send({ type: "LIST_TRANSLATION_CACHES" })).caches.length, 0);

console.log("Translation cache management checks passed.");
