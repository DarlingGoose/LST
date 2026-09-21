import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

// Two layers, matching the other suites in this repo:
//
//   1. The pure alignment helpers in structured-response.js, directly.
//   2. The real TRANSLATE_BATCH handler over a stubbed provider, for the
//      recovery behaviours those helpers replaced. Every scenario here used to
//      be handled by a different stacked mechanism: positional guessing, an
//      in-catch plain fallback, and a recursive halving of the batch.

const source = await fs.readFile(
  new URL("../src/shared/structured-response.js", import.meta.url),
  "utf8",
);
const unit = vm.createContext({});
vm.runInContext(source, unit, { filename: "structured-response.js" });
const R = unit.LSTStructuredResponse;

// ---------------------------------------------------------------------------
// 1. extractJson
// ---------------------------------------------------------------------------

assert.equal(R.extractJson('{"a":1}').strategy, "direct");
assert.equal(JSON.stringify(R.extractJson('{"a":1}').value), '{"a":1}');

{
  const fenced = R.extractJson('Here you go:\n```json\n{"a":1}\n```\nAnything else?');
  assert.equal(fenced.strategy, "fenced");
  assert.equal(JSON.stringify(fenced.value), '{"a":1}');
}
assert.equal(R.extractJson('Sure.\n{"a":1}\nHope that helps!').strategy, "scanned");
assert.equal(R.extractJson("no json here at all").value, undefined);
assert.equal(R.extractJson("").strategy, "none");

{
  // A response cut off mid-object keeps the elements that did arrive.
  const truncated = R.extractJson('{"translations":[{"id":"1","text":"one"},{"id":"2","te');
  assert.equal(truncated.strategy, "repaired");
  assert.equal(truncated.truncated, true);
  assert.deepEqual(Array.from(truncated.value.translations, (row) => row.id), ["1"]);
}

{
  // Braces inside strings must not confuse the scan.
  const tricky = R.extractJson('preamble [1] {"translations":[{"id":"1","text":"a } b"}]} trailing');
  assert.equal(tricky.strategy, "scanned");
  assert.equal(tricky.value.translations[0].text, "a } b");
}

// ---------------------------------------------------------------------------
// 2. readRows
// ---------------------------------------------------------------------------

const rowIds = (value) => Array.from(R.readRows(value).rows, (row) => row.id);

assert.deepEqual(rowIds({ translations: [{ id: "1", text: "a" }] }), ["1"]);
assert.deepEqual(rowIds([{ id: "1", text: "a" }]), ["1"]);
assert.deepEqual(rowIds({ items: [{ index: 1, translation: "a" }] }), ["1"]);
assert.deepEqual(rowIds({ translations: { 1: "a", 2: "b" } }), ["1", "2"]);
assert.deepEqual(rowIds({ id: "1", text: "a" }), ["1"]);
assert.deepEqual(rowIds({ translations: "[1]" }), []);
assert.deepEqual(rowIds(null), []);
assert.equal(R.readRows({ subtitles: [], extra: "x" }).shape, "subtitles");

// ---------------------------------------------------------------------------
// 3. alignRows
// ---------------------------------------------------------------------------

const ids = ["a:1:one", "b:2:two", "c:3:three"];
const row = (id, text) => ({ id, text });

{
  const aligned = R.alignRows(ids, [row("a:1:one", "ONE"), row("b:2:two", "TWO"), row("c:3:three", "THREE")]);
  assert.equal(aligned.idRecovery, "exact");
  assert.deepEqual(Array.from(aligned.translations, (entry) => entry.text), ["ONE", "TWO", "THREE"]);
  assert.deepEqual([...aligned.missing], []);
}

{
  // Out-of-order rows still produce a deterministic, input-ordered result.
  const aligned = R.alignRows(ids, [row("c:3:three", "THREE"), row("a:1:one", "ONE"), row("b:2:two", "TWO")]);
  assert.deepEqual(Array.from(aligned.translations, (entry) => entry.text), ["ONE", "TWO", "THREE"]);
}

{
  // Decoration around an id the model was given is stripped; nothing else is.
  const aligned = R.alignRows(ids, [row(' "a:1:one" ', "ONE"), row("#b:2:two", "TWO"), row("c:3:three.", "THREE")]);
  assert.equal(aligned.idRecovery, "exact");
}

{
  // A partial match must NOT fall back to position: the unmatched lines are
  // reported missing so the caller re-asks for exactly those.
  const aligned = R.alignRows(ids, [row("x", "THREE"), row("a:1:one", "ONE"), row("y", "TWO")]);
  assert.equal(aligned.idRecovery, "partial");
  assert.deepEqual(Array.from(aligned.translations, (entry) => entry.text), ["ONE"]);
  assert.deepEqual([...aligned.missing], ["b:2:two", "c:3:three"]);
  assert.deepEqual([...aligned.unexpected], ["x", "y"]);
}

{
  // No recognizable id at all, with a matching count: order is the only signal
  // left, so positional recovery is allowed.
  const aligned = R.alignRows(ids, [row("x", "ONE"), row("y", "TWO"), row("z", "THREE")]);
  assert.equal(aligned.idRecovery, "positional");
  assert.deepEqual(Array.from(aligned.translations, (entry) => entry.text), ["ONE", "TWO", "THREE"]);
  assert.deepEqual([...aligned.missing], []);
}

{
  // ... but not when the count disagrees: that is a dropped line, not a
  // renamed id.
  const aligned = R.alignRows(ids, [row("x", "ONE"), row("y", "TWO")]);
  assert.equal(aligned.idRecovery, "none");
  assert.deepEqual([...aligned.translations], []);
  assert.deepEqual([...aligned.missing], ids);
}

{
  // A blank row is not an answer.
  const aligned = R.alignRows(["1", "2"], [row("1", "  "), row("2", "TWO")]);
  assert.deepEqual([...aligned.missing], ["1"]);
}

{
  // A repeated id does not silently overwrite the first answer.
  const aligned = R.alignRows(["1"], [row("1", "FIRST"), row("1", "SECOND")]);
  assert.equal(aligned.translations[0].text, "FIRST");
  assert.deepEqual([...aligned.duplicates], ["1"]);
}

// ---------------------------------------------------------------------------
// 4. toOrdinals
// ---------------------------------------------------------------------------

{
  const ordinals = R.toOrdinals(ids);
  assert.deepEqual([...ordinals.ids], ["1", "2", "3"]);
  assert.equal(ordinals.byOrdinal.get("2"), "b:2:two");
}

// ---------------------------------------------------------------------------
// 5. TRANSLATE_BATCH end to end
// ---------------------------------------------------------------------------

const values = {};
const requests = [];
let handler;
let scenario;

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

function readRequest(init) {
  const body = JSON.parse(init.body);
  const system = body.messages[0].content;
  const user = body.messages[1].content;
  let parsed = null;
  try {
    parsed = JSON.parse(user);
  } catch {
    parsed = null;
  }
  const request = {
    system,
    user,
    // The plain single-line path asks for raw text, never for JSON.
    plain: system.includes("Return only the translated subtitle text"),
    lines: Array.isArray(parsed?.subtitles) ? parsed.subtitles : null,
  };
  requests.push(request);
  return request;
}

// The model that behaves: echo the ordinals, translate every line.
function faithful(request) {
  if (request.plain) return `T(${request.user})`;
  return JSON.stringify({
    translations: (request.lines || []).map((line) => ({
      id: line.id,
      text: `T(${line.text})`,
    })),
  });
}

async function mockFetch(url, init = {}) {
  const request = readRequest(init);
  const content = scenario(request);
  if (typeof content === "object" && content.status) {
    return {
      ok: false,
      status: content.status,
      statusText: content.statusText || "Error",
      async text() {
        return "";
      },
    };
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
  await fs.readFile(new URL("../src/shared/settings-schema.js", import.meta.url), "utf8"),
  context,
  { filename: "settings-schema.js" },
);
vm.runInContext(
  await fs.readFile(new URL("../src/shared/translation-context.js", import.meta.url), "utf8"),
  context,
  { filename: "translation-context.js" },
);
vm.runInContext(
  await fs.readFile(new URL("../src/shared/episode-identity.js", import.meta.url), "utf8"),
  context,
);
vm.runInContext(
  await fs.readFile(new URL("../src/shared/translation-guard.js", import.meta.url), "utf8"),
  context,
);
vm.runInContext(source, context, { filename: "structured-response.js" });
vm.runInContext(
  await fs.readFile(new URL("../src/background/index.js", import.meta.url), "utf8"),
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

const cues = (...texts) =>
  texts.map((text) => ({ id: `1000:2000:${text}`, text }));
const bySource = (result) =>
  Object.fromEntries(
    Array.from(result.translations, (entry) => [entry.id, entry.text]),
  );

await send({ type: "SAVE_SETTINGS", settings: {
  provider: "deepseek",
  model: "deepseek-v4-flash",
  targetLanguage: "English",
} });
await send({ type: "SET_PROVIDER_KEY", provider: "deepseek", key: "test-key" });

const three = cues("alpha", "bravo", "charlie");

// A. Prose and a code fence around the JSON. This used to be invalid JSON, and
//    losing the parse meant losing the whole batch.
{
  scenario = (request) => {
    if (request.plain) return `T(${request.user})`;
    return "Sure, here it is:\n\n```json\n" +
      faithful(request) +
      "\n```\n\nLet me know if you need the rest.";
  };
  requests.length = 0;
  const result = await send({ type: "TRANSLATE_BATCH", items: three });
  assert.deepEqual(bySource(result), {
    "1000:2000:alpha": "T(alpha)",
    "1000:2000:bravo": "T(bravo)",
    "1000:2000:charlie": "T(charlie)",
  });
  assert.equal(result.failures.length, 0);
  assert.equal(requests.length, 1, "no recovery request was needed");
  assert.equal(result.diagnostics[0].extraction, "fenced");
  assert.equal(result.diagnostics[0].idRecovery, "exact");
}

// B. A truncated response. The lines that arrived are kept and only the
//    unanswered one is re-asked; the batch is never re-sent whole.
{
  scenario = (request) => {
    if (request.plain) return `T(${request.user})`;
    return '{"translations":[{"id":"1","text":"T(alpha)"},{"id":"2","text":"T(bravo)"},{"id":"3","te';
  };
  requests.length = 0;
  const result = await send({ type: "TRANSLATE_BATCH", items: three });
  assert.deepEqual(bySource(result), {
    "1000:2000:alpha": "T(alpha)",
    "1000:2000:bravo": "T(bravo)",
    "1000:2000:charlie": "T(charlie)",
  });
  assert.equal(result.failures.length, 0);
  assert.equal(requests.length, 2, "one structured request plus one re-ask");
  assert.equal(requests.filter((request) => request.plain).length, 1);
  assert.equal(JSON.stringify(result.diagnostics[0].alignment), '{"matched":2,"unanswered":1}');
  assert.equal(result.diagnostics[0].extraction, "repaired");
  assert.ok(
    result.diagnostics.some((entry) => entry.stage === "unanswered-retry-success"),
    "the re-asked line is reported as an unanswered retry, not a verification one",
  );
}

// C. Rows answered out of order are still mapped by id, not by position.
{
  scenario = (request) => {
    if (request.plain) return `T(${request.user})`;
    const lines = request.lines.slice().reverse();
    return JSON.stringify({
      translations: lines.map((line) => ({ id: line.id, text: `T(${line.text})` })),
    });
  };
  requests.length = 0;
  const result = await send({ type: "TRANSLATE_BATCH", items: three });
  assert.deepEqual(bySource(result), {
    "1000:2000:alpha": "T(alpha)",
    "1000:2000:bravo": "T(bravo)",
    "1000:2000:charlie": "T(charlie)",
  });
  assert.equal(requests.length, 1);
  assert.equal(result.diagnostics[0].idRecovery, "exact");
}

// D. The regression this whole file exists for. The model returns three rows
//    with only one recognizable id, and it has shuffled the text. Positional
//    recovery would have attached "T(charlie)" to "alpha". Instead the two
//    unmatched lines are re-asked, and every cue gets its own translation.
{
  scenario = (request) => {
    if (request.plain) return `T(${request.user})`;
    return JSON.stringify({ translations: [
      { id: "x", text: "T(charlie)" },
      { id: "1", text: "T(alpha)" },
      { id: "y", text: "T(bravo)" },
    ] });
  };
  requests.length = 0;
  const result = await send({ type: "TRANSLATE_BATCH", items: three });
  assert.deepEqual(bySource(result), {
    "1000:2000:alpha": "T(alpha)",
    "1000:2000:bravo": "T(bravo)",
    "1000:2000:charlie": "T(charlie)",
  });
  assert.equal(result.failures.length, 0);
  assert.equal(result.diagnostics[0].idRecovery, "partial");
  assert.deepEqual([...result.diagnostics[0].unexpectedIds], ["x", "y"]);
  assert.equal(requests.filter((request) => request.plain).length, 2);
}

// E. The model ignores the ids entirely but answers every line in order: still
//    recovered, and reported as positional so the debug panel can say so.
{
  scenario = (request) => {
    if (request.plain) return `T(${request.user})`;
    return JSON.stringify({
      translations: request.lines.map((line) => ({ id: `line-${line.id}`, text: `T(${line.text})` })),
    });
  };
  requests.length = 0;
  const result = await send({ type: "TRANSLATE_BATCH", items: three });
  assert.equal(result.diagnostics[0].idRecovery, "positional");
  assert.deepEqual(bySource(result), {
    "1000:2000:alpha": "T(alpha)",
    "1000:2000:bravo": "T(bravo)",
    "1000:2000:charlie": "T(charlie)",
  });
  assert.equal(requests.length, 1);
}

// F. A dropped line with unusable ids: the count no longer matches, so nothing
//    is guessed and all three lines are re-asked individually.
{
  scenario = (request) => {
    if (request.plain) return `T(${request.user})`;
    return JSON.stringify({ translations: [
      { id: "?", text: "T(alpha)" },
      { id: "?", text: "T(bravo)" },
    ] });
  };
  requests.length = 0;
  const result = await send({ type: "TRANSLATE_BATCH", items: three });
  assert.equal(result.diagnostics[0].idRecovery, "none");
  assert.equal(result.failures.length, 0);
  assert.deepEqual(bySource(result), {
    "1000:2000:alpha": "T(alpha)",
    "1000:2000:bravo": "T(bravo)",
    "1000:2000:charlie": "T(charlie)",
  });
  assert.equal(requests.length, 4, "one structured request plus three re-asks");
  assert.equal(result.diagnostics[0].alignment.unanswered, 3);
}

// G. Nothing parseable. One split is attempted, and each half then escalates a
//    single line, so an unusable response costs a bounded number of requests
//    instead of a re-translation of the batch down to singletons.
{
  scenario = (request) =>
    request.plain ? `T(${request.user})` : "I am unable to help with that.";
  requests.length = 0;
  const result = await send({
    type: "TRANSLATE_BATCH",
    items: cues("alpha", "bravo"),
  });
  assert.deepEqual(bySource(result), {
    "1000:2000:alpha": "T(alpha)",
    "1000:2000:bravo": "T(bravo)",
  });
  assert.equal(result.failures.length, 0);
  assert.equal(
    result.diagnostics.filter((entry) => entry.stage === "structured-failure").length,
    3,
    "the parent and both halves report a structured failure",
  );
  assert.equal(requests.length, 5, "the split is bounded to one level");
}

// H. A refused credential never triggers recovery requests.
{
  scenario = () => ({ status: 401, statusText: "Unauthorized" });
  requests.length = 0;
  const result = await send({ type: "TRANSLATE_BATCH", items: three });
  assert.equal(result.translations.length, 0);
  assert.equal(result.failures.length, 3);
  assert.equal(requests.length, 1);
  assert.equal(result.diagnostics[0].stage, "structured-failure");
}

// I. Verification and alignment share one escalation path, and a line the guard
//    refused is still handed back with the guard's reason.
{
  scenario = (request) => {
    if (request.plain) return "Proper English.";
    return JSON.stringify({ translations: request.lines.map((line) => ({
      id: line.id,
      // The second line comes back as the source text, which the guard refuses.
      text: line.id === "2" ? line.text : "Good morning.",
    })) });
  };
  requests.length = 0;
  const result = await send({
    type: "TRANSLATE_BATCH",
    items: cues("おはようございます", "こんばんは"),
  });
  assert.equal(result.failures.length, 0);
  assert.equal(result.translations.length, 2);
  assert.equal(result.diagnostics[0].verification.rejected, 1);
  const retry = result.diagnostics.find(
    (entry) => entry.stage === "verification-retry-success",
  );
  assert.ok(retry, "the refused line was retried on its own");
  assert.equal(requests.filter((request) => request.plain).length, 1);
}

// J. Alignment recovery is independent of the verification setting: with
//    verification off, a dropped line is still re-asked, and the re-ask is not
//    run through the guard.
{
  await send({ type: "SAVE_SETTINGS", settings: { verifyTranslations: false } });
  scenario = (request) => {
    if (request.plain) return `T(${request.user})`;
    // Cut off after the second line's id.
    return '{"translations":[{"id":"1","text":"T(alpha)"},{"id":"2","te';
  };
  requests.length = 0;
  const result = await send({ type: "TRANSLATE_BATCH", items: three });
  assert.equal(result.failures.length, 0);
  assert.equal(result.translations.length, 3);
  assert.equal(result.diagnostics[0].verification.status, "off");
  assert.ok(result.diagnostics.some((entry) => entry.stage === "unanswered-retry-success"));
  assert.equal(
    result.diagnostics.filter((entry) => entry.stage.startsWith("verification-")).length,
    0,
    "the guard does not touch an unanswered line while verification is off",
  );
  await send({ type: "SAVE_SETTINGS", settings: { verifyTranslations: true } });
}

console.log("Structured response alignment checks passed.");
