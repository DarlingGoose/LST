import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

// Drives the real TRANSLATE_BATCH handler with a stubbed provider so the
// verification wiring is exercised, not just the guard's own rules.

const values = {};
const requests = [];
let handler;
let mode = "good";

const storage = {
  async get(query) {
    if (query == null) return { ...values };
    if (typeof query === "string") return { [query]: values[query] };
    if (Array.isArray(query)) {
      return Object.fromEntries(query.map((key) => [key, values[key]]));
    }
    return Object.fromEntries(
      Object.entries(query).map(([key, fallback]) => [key, values[key] ?? fallback]),
    );
  },
  async set(patch) {
    Object.assign(values, patch);
  },
  async remove(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
  },
};

function structuredResponse(items) {
  return JSON.stringify({
    translations: items.map((item) => ({ id: item.id, text: item.text })),
  });
}

async function mockFetch(url, init = {}) {
  const body = JSON.parse(init.body);
  const system = body.messages[0].content;
  const user = body.messages[1].content;
  const isRetry = system.includes("Verification failed");
  requests.push({ url: String(url), isRetry, system, user });

  let parsed = null;
  try {
    parsed = JSON.parse(user);
  } catch {
    parsed = null;
  }

  let content;

  const echo = () =>
    parsed?.subtitles ? structuredResponse(parsed.subtitles) : user;

  // The model translates properly on a verification retry.
  const translated = (text) => `EN(${text})`;
  const translateStructured = (items) =>
    JSON.stringify({
      translations: items.map((item) => ({ id: item.id, text: translated(item.text) })),
    });

  if (isRetry) {
    content = mode === "stubborn"
      ? echo()
      : parsed?.subtitles
        ? translateStructured(parsed.subtitles)
        : translated(user);
  } else if (mode === "good") {
    content = parsed?.subtitles ? translateStructured(parsed.subtitles) : translated(user);
  } else if (mode === "mixed" && parsed?.subtitles) {
    content = JSON.stringify({
      translations: parsed.subtitles.map((item, index) => ({
        id: item.id,
        text: index === 0 ? translated(item.text) : item.text,
      })),
    });
  } else {
    // Echo the source back: the reported failure mode.
    content = echo();
  }

  return {
    ok: true,
    status: 200,
    statusText: "OK",
    async json() {
      return { choices: [{ finish_reason: "stop", message: { content } }] };
    },
  };
}

const context = vm.createContext({
  AbortController, Date, URL, fetch: mockFetch, setTimeout, clearTimeout,
  console, TextDecoder, TextEncoder,
  chrome: {
    runtime: {
      onInstalled: { addListener() {} },
      onMessage: { addListener(callback) { handler = callback; } },
      sendMessage: async () => {},
    },
    storage: { local: storage },
  },
});

vm.runInContext(
  await fs.readFile(new URL("../translation-context.js", import.meta.url), "utf8"),
  context,
  { filename: "translation-context.js" },
);
vm.runInContext(
  await fs.readFile(new URL("../episode-identity.js", import.meta.url), "utf8"),
  context,
);
vm.runInContext(
  await fs.readFile(new URL("../translation-guard.js", import.meta.url), "utf8"),
  context,
);
vm.runInContext(
  await fs.readFile(new URL("../structured-response.js", import.meta.url), "utf8"),
  context,
);
vm.runInContext(
  await fs.readFile(new URL("../background.js", import.meta.url), "utf8"),
  context,
);

function send(message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out: ${message.type}`)),
      2000,
    );
    handler(message, {}, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

const items = [
  { id: "a", text: "こんにちは" },
  { id: "b", text: "さようなら" },
];

await send({ type: "SAVE_SETTINGS", settings: {
  provider: "deepseek",
  model: "deepseek-v4-flash",
  targetLanguage: "English",
} });
await send({ type: "SET_PROVIDER_KEY", provider: "deepseek", key: "test-key" });

// 1. A model that keeps echoing the source, even when retried: nothing
//    reaches the cache and the failure is reported.
mode = "stubborn";
requests.length = 0;
let result = await send({ type: "TRANSLATE_BATCH", items });
assert.equal(result.ok, true);
assert.deepEqual(Array.from(result.translations), []);
assert.equal(result.failures.length, 2);
assert.deepEqual(
  Array.from(result.failures, (failure) => failure.id),
  ["a", "b"],
);
assert.match(result.failures[0].error, /not written in English|instead of translating into English/);
assert.equal(result.failures[0].verification, "source-language-leaked");
const rejectedDiagnostics = result.diagnostics.filter(
  (entry) => entry.stage === "verification-rejected",
);
assert.equal(rejectedDiagnostics.length, 2);
assert.equal(rejectedDiagnostics[0].observedScripts, "Hiragana");
assert.equal(
  result.diagnostics.find((entry) => entry.stage === "structured-success")
    .verification.rejected,
  2,
);
// Each rejected line is retried on its own, once.
assert.equal(requests.filter((request) => request.isRetry).length, 2);

// 2. A model that returns proper English: translations pass through untouched.
mode = "good";
requests.length = 0;
result = await send({ type: "TRANSLATE_BATCH", items });
assert.deepEqual(
  Array.from(result.translations, (entry) => entry.text),
  ["EN(こんにちは)", "EN(さようなら)"],
);
assert.equal(result.failures.length, 0);
assert.equal(result.diagnostics[0].verification.rejected, 0);
assert.equal(requests.filter((request) => request.isRetry).length, 0);

// 3. A mixed batch keeps the good line and escalates only the rejected one, so
//    a partial failure never costs a re-translation of the whole batch.
mode = "mixed";
requests.length = 0;
result = await send({ type: "TRANSLATE_BATCH", items });
assert.deepEqual(
  Array.from(result.translations, (entry) => entry.text),
  ["EN(こんにちは)", "EN(さようなら)"],
);
assert.equal(result.failures.length, 0);
assert.equal(requests.filter((request) => request.isRetry).length, 1);
assert.equal(result.diagnostics[0].verification.accepted, 1);
assert.equal(result.diagnostics[0].verification.rejected, 1);

// 4. A rejected line that recovers on retry is cached, not reported.
mode = "recovers";
requests.length = 0;
result = await send({ type: "TRANSLATE_BATCH", items });
assert.deepEqual(
  Array.from(result.translations, (entry) => entry.text),
  ["EN(こんにちは)", "EN(さようなら)"],
);
assert.equal(result.failures.length, 0);
assert.equal(requests.filter((request) => request.isRetry).length, 2);

// 5. Turning verification off restores the old behavior exactly.
mode = "stubborn";
await send({ type: "SAVE_SETTINGS", settings: { verifyTranslations: false } });
requests.length = 0;
result = await send({ type: "TRANSLATE_BATCH", items });
assert.deepEqual(
  Array.from(result.translations, (entry) => entry.text),
  ["こんにちは", "さようなら"],
);
assert.equal(result.failures.length, 0);
assert.equal(result.diagnostics[0].verification.status, "off");
assert.equal(requests.filter((request) => request.isRetry).length, 0);

// 6. A poisoned entry written before verification existed is ignored on read, so
//    playback re-translates the cue instead of replaying the wrong language.
const cacheId = "81234567:deepseek%2Fdeepseek-v4-flash:English";
const cacheKeys = ["0:1500:こんにちは", "1500:3000:さようなら"];
await send({ type: "SAVE_SETTINGS", settings: { verifyTranslations: true } });
await send({ type: "CACHE_SET", cacheId, entries: {
  "0:1500:こんにちは": "こんにちは",
  "1500:3000:さようなら": "Goodbye",
}, metadata: {} });

let read = await send({ type: "CACHE_GET", cacheId, keys: cacheKeys });
assert.deepEqual(Object.keys(read.entries), ["1500:3000:さようなら"]);

// With verification off, the stored entry is served as-is: the setting controls
// both reading and writing, and the entry is never deleted behind the user's
// back.
await send({ type: "SAVE_SETTINGS", settings: { verifyTranslations: false } });
read = await send({ type: "CACHE_GET", cacheId, keys: cacheKeys });
assert.deepEqual(Object.keys(read.entries).sort(), [...cacheKeys].sort());

console.log("Translation verification pipeline checks passed.");