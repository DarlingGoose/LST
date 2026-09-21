import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const values = {};
const requests = [];
let handler;

const storage = {
  async get(query) {
    if (query == null) return { ...values };
    if (typeof query === "string") return { [query]: values[query] };
    if (Array.isArray(query)) return Object.fromEntries(query.map((key) => [key, values[key]]));
    return Object.fromEntries(Object.entries(query).map(([key, fallback]) =>
      [key, values[key] ?? fallback]));
  },
  async set(patch) { Object.assign(values, patch); },
  async remove(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
  }
};

async function mockFetch(url, init = {}) {
  requests.push({ url: String(url), init });
  let data;
  if (url === "https://api.deepseek.com/models") {
    data = { data: [{ id: "deepseek-v4-flash" }] };
  } else if (url === "https://api.deepseek.com/chat/completions") {
    const body = JSON.parse(init.body);
    const prompt = JSON.parse(body.messages[1].content);
    data = { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
      translations: prompt.subtitles.map((item) => ({ id: item.id, text: `D:${item.text}` }))
    }) } }] };
  } else if (String(url).startsWith("https://generativelanguage.googleapis.com/v1beta/models")) {
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      const prompt = JSON.parse(body.contents[0].parts[0].text);
      data = { candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({
        translations: prompt.subtitles.map((item) => ({ id: item.id, text: `G:${item.text}` }))
      }) }] } }] };
    } else {
      data = { models: [
        { name: "models/gemini-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/embedding", supportedGenerationMethods: ["embedContent"] }
      ] };
    }
  } else {
    throw new Error(`Unexpected request: ${url}`);
  }
  return { ok: true, status: 200, statusText: "OK", async json() { return data; } };
}

const context = vm.createContext({
  AbortController, Date, URL, fetch: mockFetch, setTimeout, clearTimeout,
  console, TextDecoder, TextEncoder,
  chrome: { runtime: {
    onInstalled: { addListener() {} },
    onMessage: { addListener(callback) { handler = callback; } },
    sendMessage: async () => {}
  }, storage: { local: storage } }
});
vm.runInContext(
  await fs.readFile(new URL("../src/shared/settings-schema.js", import.meta.url), "utf8"),
  context,
  { filename: "settings-schema.js" },
);
vm.runInContext(
  await fs.readFile(new URL("../src/shared/structured-response.js", import.meta.url), "utf8"),
  context,
  { filename: "structured-response.js" },
);
vm.runInContext(
  await fs.readFile(new URL("../src/shared/episode-identity.js", import.meta.url), "utf8"),
  context,
  { filename: "episode-identity.js" },
);
vm.runInContext(
  await fs.readFile(new URL("../src/shared/translation-context.js", import.meta.url), "utf8"),
  context,
  { filename: "translation-context.js" },
);
vm.runInContext(await fs.readFile(new URL("../src/background/index.js", import.meta.url), "utf8"), context);

function send(message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out: ${message.type}`)), 1000);
    handler(message, {}, (response) => { clearTimeout(timeout); resolve(response); });
  });
}

for (const [provider, key, model, prefix] of [
  ["deepseek", "deepseek-test-key", "deepseek-v4-flash", "D"],
  ["gemini", "gemini-test-key", "gemini-flash", "G"]
]) {
  assert.equal((await send({ type: "SET_PROVIDER_KEY", provider, key })).ok, true);
  const settingsResponse = await send({ type: "GET_SETTINGS" });
  assert.equal(JSON.stringify(settingsResponse).includes(key), false);
  const models = await send({ type: "GET_MODELS", provider });
  assert.deepEqual(Array.from(models.models, (item) => item.name), [model]);
  await send({ type: "SAVE_SETTINGS", settings: {
    provider, model, targetLanguage: "English",
    customTranslationPrompt: "Custom rules for {{targetLanguage}}."
  } });
  const result = await send({ type: "TRANSLATE_BATCH", items: [
    { id: "a", text: "こんにちは" }, { id: "b", text: "さようなら" }
  ] });
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.translations, (item) => item.text),
    [`${prefix}:こんにちは`, `${prefix}:さようなら`]);
  assert.equal(result.failures.length, 0);
  const request = requests.at(-1);
  assert.equal(request.url.startsWith("https://"), true);
  assert.equal(JSON.stringify(result).includes(key), false);
  if (provider === "deepseek") {
    assert.equal(request.init.headers.Authorization, `Bearer ${key}`);
    assert.equal(JSON.parse(request.init.body).response_format.type, "json_object");
    assert.match(JSON.parse(request.init.body).messages[0].content, /Custom rules for English/);
  } else {
    assert.equal(request.init.headers["x-goog-api-key"], key);
    assert.equal(JSON.parse(request.init.body).generationConfig.responseMimeType,
      "application/json");
    assert.match(JSON.parse(request.init.body).systemInstruction.parts[0].text, /Custom rules for English/);
  }
}

await send({ type: "SET_PROVIDER_KEY", provider: "gemini", key: "" });
assert.equal((await send({ type: "GET_PROVIDER_KEY_STATUS" })).configured.gemini, false);
assert.equal(values.geminiApiKey, undefined);
console.log("Provider request and credential checks passed.");
