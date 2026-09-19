import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

// Layer 1 — the identity module on its own.

const identitySource = await fs.readFile(
  new URL("../episode-identity.js", import.meta.url),
  "utf8",
);
const translationContextSource = await fs.readFile(
  new URL("../translation-context.js", import.meta.url),
  "utf8",
);
const playbackSiteSource = await fs.readFile(
  new URL("../playback-site.js", import.meta.url),
  "utf8",
);
const identityContext = vm.createContext({});
vm.runInContext(identitySource, identityContext, {
  filename: "episode-identity.js",
});
const identity = identityContext.LSTEpisodeIdentity;
const DEFAULT_SITE = identity.DEFAULT_SITE_ID;

assert.equal(identity.NAME_KIND.empty, "empty");
assert.equal(identity.NAME_KIND.placeholder, "placeholder");
assert.equal(identity.NAME_KIND.specific, "specific");

// One vocabulary for "Netflix never told us the name", shared by the page, the
// background, the popup and the cache list. Every shape carries its reason.
const placeholderNames = [
  ["Netflix", "netflix-brand-only"],
  ["Netflix", "netflix-brand-only"],
  ["Netflix - Watch TV Shows", "netflix-brand-only"],
  ["Netflix | Official Site", "netflix-brand-only"],
  ["Netflix episode 80100172", "video-id-placeholder"],
  ["Episode 80100172", "video-id-placeholder"],
  ["Episode 12345", "video-id-placeholder"],
  ["Video 80100172", "video-id-placeholder"],
  ["Episode details unavailable", "netflix-title-unavailable"],
  ["Unknown Netflix episode", "netflix-title-unavailable"],
  ["Unknown episode", "video-id-unknown"],
];
for (const [value, reason] of placeholderNames) {
  const classified = identity.classifyName(value);
  assert.equal(classified.kind, "placeholder", `${value} should be a placeholder`);
  assert.equal(classified.reason, reason, `${value} reason`);
}

// A real name is a real name, even when it starts with the same words, because
// the shapes are anchored to the whole value.
const specificNames = [
  "Example Show",
  "The Night Agent",
  "Episode 5 · The Beginning",
  "Season 1 · Episode 50 · The Beginning",
  "Netflix episode 5 · The Beginning",
];
for (const value of specificNames) {
  const classified = identity.classifyName(value);
  assert.equal(classified.kind, "specific", `${value} should be a real name`);
  assert.equal(classified.reason, "specific-name");
}

assert.equal(identity.classifyName("").kind, "empty");
assert.equal(identity.classifyName("   ").reason, "empty-name");
assert.equal(identity.classifyName(null).kind, "empty");
assert.equal(identity.classifyName("  Example   Show  ").name, "Example Show");
assert.equal(identity.isPlaceholderName("Episode 12345"), true);
assert.equal(identity.isPlaceholderName("The Night Agent"), false);
assert.equal(identity.isSpecificName("Episode 12345"), false);
assert.equal(identity.isSpecificName("The Night Agent"), true);

// A real name beats a placeholder no matter which order the sources arrive in.
assert.equal(
  identity.preferredName("Episode 80100172", "Example Show").name,
  "Example Show",
);
assert.equal(
  identity.preferredName("Example Show", "Episode 80100172").name,
  "Example Show",
);
assert.equal(identity.preferredName("", "Netflix").name, "Netflix");
assert.equal(identity.preferredName(undefined, null).name, "");

// A name is only written from parts LST actually has.
assert.equal(
  identity.episodeNameFromParts({ episodeNumber: 5, title: "The Beginning" }),
  "Episode 5 · The Beginning",
);
assert.equal(identity.episodeNameFromParts({ episodeNumber: 5, title: "" }), "Episode 5");
assert.equal(identity.episodeNameFromParts({ title: "The Beginning" }), "The Beginning");
assert.equal(identity.episodeNameFromParts({}), "");
assert.equal(identity.episodeNameFromParts(), "");

// Episode markers are declared patterns, and the answer says which one matched.
const markers = [
  ["S1:E50", "Season 1 · Episode 50", "season-episode", 1, 50],
  ["S1E50", "Season 1 · Episode 50", "season-episode", 1, 50],
  ["s1 e50", "Season 1 · Episode 50", "season-episode", 1, 50],
  ["Season 1 Episode 50", "Season 1 · Episode 50", "season-episode", 1, 50],
  ["SEASON 02 · EPISODE 03 - Pilot", "Season 2 · Episode 3", "season-episode", 2, 3],
  ["E50", "Episode 50", "episode-number", null, 50],
  ["Episode 50", "Episode 50", "episode-number", null, 50],
  ["Episode 007", "Episode 7", "episode-number", null, 7],
];
for (const [text, marker, shape, season, episode] of markers) {
  const found = identity.episodeMarker(text);
  assert.equal(found.marker, marker, `${text} marker`);
  assert.equal(found.shape, shape, `${text} shape`);
  assert.equal(found.season, season, `${text} season`);
  assert.equal(found.episode, episode, `${text} episode`);
}
assert.equal(identity.episodeMarker("Pilot").marker, "");
assert.equal(identity.episodeMarker("Pilot").reason, "no-episode-marker");
assert.equal(identity.episodeMarker("").reason, "empty-text");
assert.equal(identity.episodeMarker(undefined).reason, "empty-text");

// One placeholder format per situation, so it can be recognized by shape
// instead of by comparing against one exact expected string.
assert.equal(identity.fallbackEpisodeName("80100172"), "Episode 80100172");
assert.equal(identity.fallbackEpisodeName("unknown"), "Episode details unavailable");
assert.equal(identity.fallbackEpisodeName(""), "Episode details unavailable");
assert.equal(identity.fallbackTitle("80100172"), "Netflix episode 80100172");
assert.equal(identity.fallbackTitle("unknown"), "Unknown Netflix episode");
assert.equal(identity.fallbackTitle("B0B6GZ954Y", "primevideo"), "Prime Video episode B0B6GZ954Y");
assert.equal(identity.fallbackTitle("unknown", "primevideo"), "Unknown Prime Video episode");
assert.equal(identity.siteLabel("netflix"), "Netflix");
assert.equal(identity.siteLabel("primevideo"), "Prime Video");
assert.equal(identity.siteLabel(DEFAULT_SITE), "Netflix");
// An id is "known" only when it matches a shape a service actually issues, so a
// cache keyed on a guess is never written.
assert.equal(identity.isKnownVideoId("80100172"), true);
assert.equal(identity.videoIdKind("80100172"), "netflix-id");
assert.equal(identity.isKnownVideoId("B0B6GZ954Y"), true);
assert.equal(identity.videoIdKind("B0B6GZ954Y"), "asin");
assert.equal(identity.isKnownVideoId("amzn1.dv.gti.3a1b-2c3d"), true);
assert.equal(identity.videoIdKind("amzn1.dv.gti.3a1b-2c3d"), "prime-gti");
assert.equal(identity.isKnownVideoId("unknown"), false);
assert.equal(identity.isKnownVideoId(""), false);
assert.equal(identity.videoIdKind(""), "");
assert.equal(identity.videoIdKind("not-an-id"), "");
assert.equal(identity.isKnownVideoId("not-an-id"), false, "an unrecognized shape is not a known id");

// Cache ids round-trip, and the language slot is read from the last separator so
// a model name containing a colon can never shift it.
const ollamaCacheId = identity.encodeCacheId({
  videoId: "8123",
  model: "qwen3:8b",
  provider: "ollama",
  targetLanguage: "English",
});
assert.equal(ollamaCacheId, "8123:qwen3%3A8b:English");
assert.deepEqual(JSON.parse(JSON.stringify(identity.decodeCacheId(ollamaCacheId))), {
  videoId: "8123",
  siteId: "netflix",
  provider: "ollama",
  model: "qwen3:8b",
  targetLanguage: "English",
  namespace: "legacy",
  reason: "legacy-cache-id",
});

const remoteCacheId = identity.encodeCacheId({
  videoId: "8123",
  model: "deepseek-chat",
  provider: "deepseek",
  targetLanguage: "Japanese",
});
assert.equal(remoteCacheId, "8123:deepseek%2Fdeepseek-chat:Japanese");
assert.equal(identity.decodeCacheId(remoteCacheId).provider, "deepseek");
assert.equal(identity.decodeCacheId(remoteCacheId).model, "deepseek-chat");
assert.equal(identity.decodeCacheId(remoteCacheId).targetLanguage, "Japanese");

// Caches written by earlier versions keep working: an un-namespaced key resolves
// to Netflix by the rule that predates the namespace, and says so.
const legacy = identity.decodeCacheId("9999:legacy-model:Japanese");
assert.equal(legacy.videoId, "9999");
assert.equal(legacy.model, "legacy-model");
assert.equal(legacy.siteId, "netflix");
assert.equal(legacy.namespace, "legacy");
assert.equal(legacy.reason, "legacy-cache-id");
assert.deepEqual(JSON.parse(JSON.stringify(identity.inferCacheMetadata("9999:legacy-model:Japanese"))), {
  videoId: "9999",
  siteId: "netflix",
  showName: "Netflix",
  episodeName: "Episode 9999",
  title: "Netflix episode 9999",
  provider: "ollama",
  model: "legacy-model",
  targetLanguage: "Japanese",
  reason: "legacy-cache-id",
});

// A second service is namespaced, and Netflix keys stay byte-identical to the
// keys already in storage, so there is nothing to migrate.
{
  const netflixKey = identity.encodeCacheId({
    videoId: "8123",
    model: "qwen3:8b",
    provider: "ollama",
    targetLanguage: "English",
    siteId: "netflix",
  });
  assert.equal(netflixKey, "8123:qwen3%3A8b:English", "a Netflix key must not change");

  const primeKey = identity.encodeCacheId({
    videoId: "B0B6GZ954Y",
    model: "qwen3:8b",
    provider: "ollama",
    targetLanguage: "English",
    siteId: "primevideo",
  });
  assert.equal(primeKey, "primevideo~B0B6GZ954Y:qwen3%3A8b:English");

  const decoded = identity.decodeCacheId(primeKey);
  assert.equal(decoded.videoId, "B0B6GZ954Y");
  assert.equal(decoded.siteId, "primevideo");
  assert.equal(decoded.namespace, "site");
  assert.equal(decoded.reason, "ok");
  assert.equal(decoded.model, "qwen3:8b");

  const primeMetadata = identity.inferCacheMetadata(primeKey);
  assert.equal(primeMetadata.siteId, "primevideo");
  assert.equal(primeMetadata.showName, "Prime Video", "a Prime cache is not filed under Netflix");
  assert.equal(primeMetadata.episodeName, "Episode B0B6GZ954Y");
  assert.equal(primeMetadata.title, "Prime Video episode B0B6GZ954Y");

  // A GTI id is a known id shape and namespaces the same way.
  const gtiKey = identity.encodeCacheId({
    videoId: "amzn1.dv.gti.3a1b2c3d",
    model: "qwen3:8b",
    siteId: "primevideo",
    targetLanguage: "Japanese",
  });
  assert.match(gtiKey, /^primevideo~amzn1\.dv\.gti\.3a1b2c3d:/);

  // An unknown namespace is reported, not silently treated as Netflix.
  const unknownNamespace = identity.decodeCacheId("somewhere~8123:qwen3%3A8b:English");
  assert.equal(unknownNamespace.siteId, "");
  assert.equal(unknownNamespace.videoId, null);
  assert.equal(unknownNamespace.reason, "unknown-site-namespace");

  // The service follows the key, never the page that happens to be reporting.
  const merged = identity.mergeCacheMetadata({
    inferred: identity.inferCacheMetadata(primeKey),
    incoming: { siteId: "netflix", showName: "Some Show" },
  });
  assert.equal(merged.metadata.siteId, "primevideo", "the cache id owns the service");
  assert.equal(merged.metadata.siteId, "primevideo");
  const decision = merged.decisions.find((entry) => entry.field === "siteId");
  assert.equal(decision.reason, "incoming-identity-differs");
  assert.equal(merged.metadata.showName, "Some Show");
}

// Prime Video's own placeholders are recognized by shape.
for (const [value, reason] of [
  ["Prime Video", "prime-brand-only"],
  ["Prime Video - Watch", "prime-brand-only"],
  ["Amazon.co.jp", "prime-brand-only"],
  ["Amazon.co.jp: Show : Prime Video", "prime-brand-only"],
  ["Prime Video episode B0B6GZ954Y", "video-id-placeholder"],
  ["Unknown Prime Video episode", "prime-title-unavailable"],
]) {
  const classified = identity.classifyName(value);
  assert.equal(classified.kind, "placeholder", `${value} should be a placeholder`);
  assert.equal(classified.reason, reason, `${value} reason`);
}
// A name that merely starts with the same words is still a real name.
assert.equal(identity.isSpecificName("Prime Video Original: The Show"), true);
assert.equal(identity.isSpecificName("Prime Video episode 5 · Pilot"), true);

const unknownVideo = identity.inferCacheMetadata("unknown:qwen3%3A8b:English");
assert.equal(unknownVideo.videoId, "unknown");
assert.equal(unknownVideo.episodeName, "Episode details unavailable");
assert.equal(unknownVideo.title, "Unknown Netflix episode");
assert.equal(unknownVideo.reason, "video-id-unknown");

const malformed = identity.decodeCacheId("no-separators-here");
assert.equal(malformed.reason, "malformed-cache-id");
assert.equal(malformed.videoId, null);
assert.equal(identity.decodeCacheId("").reason, "malformed-cache-id");
assert.equal(identity.decodeCacheId(null).reason, "malformed-cache-id");
assert.equal(identity.inferCacheMetadata("broken").model, "Unknown model");
assert.equal(identity.inferCacheMetadata("broken").targetLanguage, "Unknown language");

// The episode title and number are read from the object that holds the video id,
// not from a fixed number of characters after it, and every way of coming up
// empty is named.
const episodeHtml = [
  "window.__data = ",
  '{"videoId":80100172,"title":"The Beginning","number":5,"runtime":3600};',
].join("");
assert.deepEqual(
  JSON.parse(JSON.stringify(identity.findEpisodeMetadataInHtml(episodeHtml, "80100172"))),
  { episodeNumber: 5, title: "The Beginning", reason: "ok" },
);

// Field order and whitespace are Netflix's choice, not a contract.
assert.deepEqual(
  JSON.parse(JSON.stringify(identity.findEpisodeMetadataInHtml(
    '{"number": 12, "videoId" : "80100172", "title" : "He said \\"go\\""}',
    "80100172",
  ))),
  { episodeNumber: 12, title: 'He said "go"', reason: "ok" },
);

// The gap between the video id and the number is not bounded any more.
const paddedHtml = `{"videoId":80100172,"filler":"${"x".repeat(4000)}","title":"Far Apart","number":9}`;
assert.equal(identity.findEpisodeMetadataInHtml(paddedHtml, "80100172").title, "Far Apart");
assert.equal(identity.findEpisodeMetadataInHtml(paddedHtml, "80100172").episodeNumber, 9);

// A nested object is never scanned past: the fields live in the same flat object.
assert.equal(
  identity.findEpisodeMetadataInHtml(
    '{"videoId":80100172,"title":"Right One","number":5,"nested":{"title":"Wrong One","number":9}}',
    "80100172",
  ).title,
  "Right One",
);

assert.equal(
  identity.findEpisodeMetadataInHtml('{"videoId":999}', "80100172").reason,
  "video-id-not-found",
);
assert.equal(
  identity.findEpisodeMetadataInHtml('{"videoId":80100172,"title":"T"}', "80100172").reason,
  "episode-number-missing",
);
assert.equal(
  identity.findEpisodeMetadataInHtml('{"videoId":80100172,"number":5}', "80100172").reason,
  "episode-title-missing",
);
assert.equal(
  identity.findEpisodeMetadataInHtml('{"videoId":80100172,"other":1}', "80100172").reason,
  "episode-metadata-not-found",
);
assert.equal(
  identity.findEpisodeMetadataInHtml(episodeHtml, "unknown").reason,
  "video-id-unknown",
);
assert.equal(
  identity.findEpisodeMetadataInHtml("", "80100172").reason,
  "video-id-not-found",
);

// Merging: identity follows the cache id, a real name always beats a
// placeholder, and every field records the decision that produced it.
const inferred = identity.inferCacheMetadata("8123:qwen3%3A8b:English");
const merge = (existing, incoming) =>
  identity.mergeCacheMetadata({ inferred, existing, incoming });
const decisionFor = (result, field) =>
  result.decisions.find((entry) => entry.field === field);

{
  const result = merge(
    { showName: "Example Show", episodeName: "S1:E1 The Beginning", title: "Example Show: Episode 1" },
    { showName: "Netflix", episodeName: "Episode 8123", title: "Netflix episode 8123" },
  );
  assert.equal(result.metadata.showName, "Example Show");
  assert.equal(result.metadata.episodeName, "S1:E1 The Beginning");
  assert.equal(result.metadata.title, "Example Show: Episode 1");
  assert.equal(decisionFor(result, "showName").reason, "stored-specific-name");
  assert.equal(decisionFor(result, "episodeName").decision, "kept-specific-name");
}

{
  // The regression this file exists for: a placeholder worded differently from
  // the one the cache id would produce must not erase a name already found.
  const result = merge(
    { showName: "Example Show", episodeName: "S1:E1 The Beginning" },
    { episodeName: "Video 8123" },
  );
  assert.equal(result.metadata.episodeName, "S1:E1 The Beginning");
  assert.equal(decisionFor(result, "episodeName").reason, "stored-specific-name");

  const other = merge(
    { showName: "Example Show", episodeName: "S1:E1 The Beginning" },
    { episodeName: "Episode details unavailable" },
  );
  assert.equal(other.metadata.episodeName, "S1:E1 The Beginning");

  const fiveDigit = merge(
    { showName: "Example Show", episodeName: "S1:E1 The Beginning" },
    { episodeName: "Episode 12345" },
  );
  assert.equal(fiveDigit.metadata.episodeName, "S1:E1 The Beginning");
}

{
  const result = merge(
    { episodeName: "Episode 8123" },
    { showName: "Example Show", episodeName: "Episode 5 · The Beginning" },
  );
  assert.equal(result.metadata.showName, "Example Show");
  assert.equal(result.metadata.episodeName, "Episode 5 · The Beginning");
  assert.equal(decisionFor(result, "episodeName").decision, "adopted-specific-name");
  assert.equal(decisionFor(result, "episodeName").reason, "newer-specific-name");
}

{
  // Two real names: the newest observation wins, and that is reported.
  const result = merge(
    { episodeName: "Episode 4 · Pilot" },
    { episodeName: "Episode 5 · The Beginning" },
  );
  assert.equal(result.metadata.episodeName, "Episode 5 · The Beginning");
  assert.equal(decisionFor(result, "episodeName").decision, "replaced-specific-name");
}

{
  const result = merge({ showName: "Netflix", episodeName: "Episode 8123" }, {});
  assert.equal(result.metadata.showName, "Netflix");
  assert.equal(result.metadata.episodeName, "Episode 8123");
  assert.equal(decisionFor(result, "showName").decision, "kept-placeholder-name");
  assert.equal(decisionFor(result, "showName").reason, "netflix-brand-only");
}

{
  const result = merge({}, {});
  assert.equal(result.metadata.showName, "Netflix");
  assert.equal(result.metadata.episodeName, "Episode 8123");
  assert.equal(result.metadata.title, "Netflix episode 8123");
  assert.equal(decisionFor(result, "showName").decision, "no-name-observed");
}

{
  // The cache id is the storage key, so it decides identity; a caller that
  // disagrees is overruled and the disagreement is reported.
  const result = identity.mergeCacheMetadata({
    inferred,
    existing: {},
    incoming: { model: "qwen3:8b", targetLanguage: "English", provider: "ollama", videoId: "8123" },
  });
  assert.equal(result.metadata.model, "qwen3:8b");
  assert.equal(decisionFor(result, "model").reason, "identities-agree");

  const differ = identity.mergeCacheMetadata({
    inferred,
    existing: {},
    incoming: { model: "gemma3:4b" },
  });
  assert.equal(differ.metadata.model, "qwen3:8b");
  assert.equal(decisionFor(differ, "model").reason, "incoming-identity-differs");
  assert.equal(decisionFor(differ, "model").source, "cache-id");

  const unrecognized = identity.mergeCacheMetadata({
    inferred: identity.inferCacheMetadata("broken"),
    existing: {},
    incoming: { model: "qwen3:8b", targetLanguage: "English" },
  });
  assert.equal(unrecognized.metadata.model, "qwen3:8b");
  assert.equal(unrecognized.metadata.targetLanguage, "English");
  assert.equal(
    decisionFor(unrecognized, "model").reason,
    "cache-id-unrecognized",
  );
  assert.equal(
    decisionFor(unrecognized, "targetLanguage").decision,
    "adopted-incoming-identity",
  );
}

{
  // Fields that are neither identity nor a name are carried through.
  const result = merge({}, { url: "https://www.netflix.com/watch/8123", sourceCueCount: 24 });
  assert.equal(result.metadata.url, "https://www.netflix.com/watch/8123");
  assert.equal(result.metadata.sourceCueCount, 24);
  const empty = merge({ url: "https://www.netflix.com/watch/8123" }, { url: "" });
  assert.equal(empty.metadata.url, "https://www.netflix.com/watch/8123");
}

{
  const result = identity.mergeCacheMetadata({});
  assert.equal(result.metadata.model, undefined);
  assert.ok(result.decisions.length > 0);
}

// Layer 2 — the background uses that module for stored caches.

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
  },
};

const backgroundContext = vm.createContext({
  AbortController,
  console,
  Date,
  fetch: async () => ({ ok: false, status: 404, async text() { return ""; } }),
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
      openOptionsPage: async () => {},
    },
    storage: { local: storage },
  },
});

vm.runInContext(identitySource, backgroundContext, { filename: "episode-identity.js" });
vm.runInContext(translationContextSource, backgroundContext, {
  filename: "translation-context.js",
});
vm.runInContext(
  await fs.readFile(new URL("../structured-response.js", import.meta.url), "utf8"),
  backgroundContext,
  { filename: "structured-response.js" },
);
vm.runInContext(
  await fs.readFile(new URL("../background.js", import.meta.url), "utf8"),
  backgroundContext,
  { filename: "background.js" },
);
await installedHandler();

function backgroundMessage(message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out: ${message.type}`)),
      1000,
    );
    messageHandler(message, {}, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

const cacheId = "8123:qwen3%3A8b:English";
let response = await backgroundMessage({
  type: "CACHE_SET",
  cacheId,
  entries: { "0:1000:こんにちは": "Hello" },
  metadata: {
    videoId: "8123",
    showName: "The Night Agent",
    episodeName: "Season 1 · Episode 5 · The Beginning",
    title: "The Night Agent — Season 1 · Episode 5 · The Beginning",
    url: "https://www.netflix.com/watch/8123",
    provider: "ollama",
    model: "qwen3:8b",
    targetLanguage: "English",
    sourceCueCount: 24,
  },
});
assert.equal(response.ok, true);
const firstDecisions = JSON.parse(JSON.stringify(response.decisions));
assert.ok(
  firstDecisions.some((entry) => entry.decision === "adopted-specific-name"),
  "the first write should report adopting a real episode name",
);

response = await backgroundMessage({
  type: "CACHE_SET",
  cacheId,
  entries: { "1000:2000:世界": "World" },
  // A placeholder worded differently from the one the cache id would produce
  // used to overwrite the episode name that had already been found.
  metadata: { showName: "Netflix", title: "Netflix episode 8123", episodeName: "Video 8123" },
});
const placeholderDecisions = JSON.parse(JSON.stringify(response.decisions));
const episodeDecision = placeholderDecisions.find(
  (entry) => entry.field === "episodeName",
);
assert.equal(episodeDecision.decision, "kept-specific-name");
assert.equal(episodeDecision.reason, "stored-specific-name");
assert.equal(episodeDecision.source, "existing");
// The placeholder that lost is named, so a name that unexpectedly did not win
// can be traced to the rule that rejected it.
assert.equal(episodeDecision.displacedKind, "placeholder");
assert.equal(episodeDecision.displacedReason, "video-id-placeholder");
const showDecision = placeholderDecisions.find((entry) => entry.field === "showName");
assert.equal(showDecision.decision, "kept-specific-name");
assert.equal(showDecision.displacedKind, "placeholder");
assert.equal(showDecision.displacedReason, "netflix-brand-only");

response = await backgroundMessage({ type: "LIST_TRANSLATION_CACHES" });
assert.equal(response.caches[0].showName, "The Night Agent");
assert.equal(response.caches[0].episodeName, "Season 1 · Episode 5 · The Beginning");
assert.equal(response.caches[0].title, "The Night Agent — Season 1 · Episode 5 · The Beginning");
assert.equal(response.caches[0].cueCount, 2);
assert.equal(response.caches[0].model, "qwen3:8b");

response = await backgroundMessage({ type: "GET_TRANSLATION_CACHE", cacheId });
assert.equal(response.metadata.showName, "The Night Agent");
assert.equal(response.metadata.episodeName, "Season 1 · Episode 5 · The Beginning");

// A cache written before any of this existed still lists, and is named from its
// own id rather than from a placeholder some other file invented.
values["translationCache:9999:legacy-model:Japanese"] = { cue: "翻訳" };
response = await backgroundMessage({ type: "LIST_TRANSLATION_CACHES" });
const legacyCache = response.caches.find((cache) => cache.cacheId === "9999:legacy-model:Japanese");
assert.equal(legacyCache.showName, "Netflix");
assert.equal(legacyCache.episodeName, "Episode 9999");
assert.equal(legacyCache.title, "Netflix episode 9999");
assert.equal(legacyCache.model, "legacy-model");
assert.equal(legacyCache.targetLanguage, "Japanese");

// A cache id that cannot be read says so instead of pretending to know.
values["translationCache:broken"] = { cue: "翻訳" };
response = await backgroundMessage({ type: "LIST_TRANSLATION_CACHES" });
const brokenCache = response.caches.find((cache) => cache.cacheId === "broken");
assert.equal(brokenCache.showName, "Netflix");
assert.equal(brokenCache.model, "Unknown model");
assert.equal(brokenCache.targetLanguage, "Unknown language");
delete values["translationCache:broken"];

// Layer 3 — the page reaches the same conclusions, and reports them without
// writing the names themselves into the event log.

const contentSource = await fs.readFile(
  new URL("../content.js", import.meta.url),
  "utf8",
);
const syncSource = await fs.readFile(
  new URL("../subtitle-sync.js", import.meta.url),
  "utf8",
);
const CUE_TRACK = [
  "WEBVTT",
  "",
  "00:00:10.000 --> 00:00:11.000",
  "Hello.",
  "",
].join("\n");

function titleElement(text, attributes = {}, children = []) {
  const node = {
    tagName: "DIV",
    id: "",
    className: "",
    style: {
      setProperty() {},
      removeProperty() {},
      getPropertyValue() {
        return "";
      },
    },
    dataset: {},
    hidden: false,
    isConnected: true,
    nodeType: 1,
    childElementCount: children.length,
    children,
    textContent: text,
    innerText: text,
    innerHTML: "",
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      },
    },
    appendChild(child) {
      node.children.push(child);
      node.childElementCount = node.children.length;
      return child;
    },
    insertBefore(child) {
      return node.appendChild(child);
    },
    append(...appended) {
      for (const child of appended) node.appendChild(child);
    },
    replaceChildren(...replaced) {
      node.children = replaced;
      node.childElementCount = replaced.length;
    },
    removeChild(child) {
      const index = node.children.indexOf(child);
      if (index >= 0) node.children.splice(index, 1);
      node.childElementCount = node.children.length;
      return child;
    },
    remove() {},
    setAttribute() {},
    removeAttribute() {},
    getAttribute: (name) => attributes[name] ?? null,
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    scrollIntoView() {},
    matches: () => false,
    closest: () => null,
    querySelector(selector) {
      if (!node.queryCache) node.queryCache = new Map();
      if (!node.queryCache.has(selector)) {
        node.queryCache.set(selector, titleElement(""));
      }
      return node.queryCache.get(selector);
    },
    // The title containers are searched for their own headings and spans.
    querySelectorAll() {
      return children;
    },
    cloneNode() {
      return titleElement(text, attributes, children);
    },
    getBoundingClientRect() {
      return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    },
  };
  return node;
}

function titleSpecElement(spec) {
  if (typeof spec === "string") return titleElement(spec);
  const children = (spec.parts || []).map((part) => titleElement(part));
  return titleElement(spec.text || "", spec.attributes || {}, children);
}

function createHarness({
  selectorMap = {},
  pageTitle = "",
  metaTitle = "",
  episodePageHtml = "",
  cachedEntries = { "10000:11000:Hello.": "こんにちは" },
} = {}) {
  const video = {
    currentTime: 0,
    paused: false,
    duration: 1200,
    readyState: 4,
    playbackRate: 1,
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null;
    },
  };
  const sentMessages = [];
  const windowListeners = new Map();
  const runtimeListeners = new Map();
  const observers = [];
  const documentElement = titleElement("");
  const document = {
    title: pageTitle,
    documentElement,
    body: titleElement(""),
    head: titleElement(""),
    fullscreenElement: null,
    createElement: (tagName) => titleElement(""),
    createDocumentFragment: () => titleElement(""),
    addEventListener() {},
    removeEventListener() {},
    querySelector(selector) {
      if (selector === "video") return video;
      return null;
    },
    querySelectorAll(selector) {
      // The adapter selects the element the viewer is watching from this list.
      if (selector === "video") return [video];
      const parts = String(selector).split(",").map((part) => part.trim());
      const found = [];
      for (const part of parts) {
        if (part === 'meta[property="og:title"]' && metaTitle) {
          found.push(titleElement("", { content: metaTitle }));
          continue;
        }
        for (const spec of selectorMap[part] || []) found.push(titleSpecElement(spec));
      }
      return found;
    },
  };
  // The episode page's own <title> is the only thing content.js asks the DOM
  // parser for, so the stub answers exactly that.
  class DOMParserStub {
    parseFromString(html) {
      const title = /<title>([^<]*)<\/title>/i.exec(String(html))?.[1] || "";
      return { title, querySelector: () => null };
    }
  }
  // content.js compares node types against the DOM constant, so the stub needs it.
  class MutationObserverStub {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe() {}
    disconnect() {}
  }
  const consoleMessages = [];
  const describe = (value) =>
    value && typeof value === "object" && typeof value.message === "string"
      ? value.message
      : value;
  const quietConsole = {
    log: (...args) => consoleMessages.push(args.map(describe)),
    info: (...args) => consoleMessages.push(args.map(describe)),
    warn: (...args) => consoleMessages.push(args.map(describe)),
    error: (...args) => consoleMessages.push(args.map(describe)),
  };
  const fetchRequests = [];
  const context = vm.createContext({
    document,
    location: {
      href: "https://www.netflix.com/watch/80100172",
      host: "www.netflix.com",
      pathname: "/watch/80100172",
      search: "",
    },
    performance,
    console: quietConsole,
    URL,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval() {},
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    MutationObserver: MutationObserverStub,
    DOMParser: DOMParserStub,
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    fetch: async (url) => {
      fetchRequests.push(String(url));
      if (String(url).startsWith("/title/")) {
        // A real episode-page request is not a microtask, and the page needs it
        // to be slower than the cache lookup that races it.
        await sleep(20);
        return {
          ok: true,
          status: 200,
          async text() {
            return episodePageHtml;
          },
        };
      }
      return { ok: false, status: 404, async text() { return ""; } };
    },
    browser: {
      runtime: {
        onMessage: {
          addListener(handler) {
            runtimeListeners.set("message", handler);
          },
        },
        getManifest() {
          return { version: "0.0.0-test" };
        },
        sendMessage(message) {
          sentMessages.push(message);
          if (message?.type === "GET_SETTINGS") {
            return Promise.resolve({
              ok: true,
              settings: {
                enabled: true,
                provider: "ollama",
                model: "test-model",
                targetLanguage: "English",
                showDebugPanel: false,
              },
            });
          }
          if (message?.type === "CACHE_GET") {
            return Promise.resolve({ ok: true, entries: cachedEntries, cues: [] });
          }
          return Promise.resolve({ ok: true, entries: {}, cues: [] });
        },
      },
      storage: {
        local: {
          async get() {
            return {};
          },
          async set() {},
        },
      },
    },
  });
  context.addEventListener = (type, handler) => windowListeners.set(type, handler);
  const windowRef = vm.runInContext("globalThis.window = globalThis", context);

  vm.runInContext(playbackSiteSource, context, { filename: "playback-site.js" });
  vm.runInContext(identitySource, context, { filename: "episode-identity.js" });
  vm.runInContext(syncSource, context, { filename: "subtitle-sync.js" });
  vm.runInContext(translationContextSource, context, {
    filename: "translation-context.js",
  });
  vm.runInContext(contentSource, context, { filename: "content.js" });

  const debugEvents = () => {
    const events = [];
    for (const message of sentMessages) {
      if (message?.type === "APPEND_DEBUG_EVENTS") events.push(...message.events);
    }
    return events;
  };

  return {
    consoleMessages,
    fetchRequests,
    debugEvents,
    eventsNamed: (name) => debugEvents().filter((event) => event.event === name),
    messagesOfType: (type) => sentMessages.filter((message) => message?.type === type),
    async settle(ms = 0) {
      for (let i = 0; i < 12; i++) await Promise.resolve();
      if (ms) await sleep(ms);
      for (let i = 0; i < 12; i++) await Promise.resolve();
    },
    async start(vtt = CUE_TRACK) {
      await this.settle();
      const handler = windowListeners.get("message");
      assert.ok(handler, "content.js should listen for captured subtitles");
      handler({
        source: windowRef,
        data: {
          source: "lst-local-subtitle-translate",
          type: "SUBTITLE_DOCUMENT",
          payload: { url: "https://www.netflix.com/subtitle.vtt", text: vtt },
        },
      });
      // Diagnostics are buffered for half a second before they are flushed.
      await this.settle(560);
    },
    // Netflix rewriting the title bar is what asks for a fresh look at the
    // episode's name.
    async fireTitleMutation() {
      const observer = observers[0];
      assert.ok(
        observer,
        `the title observer should be observing: ${JSON.stringify(consoleMessages)}`,
      );
      // Netflix rewriting the title node is what this stands in for, so the
      // mutation carries an element node the observer's selector test accepts.
      observer.callback([
        {
          target: { nodeType: 1, closest: () => true },
          addedNodes: [],
        },
      ]);
      await sleep(120);
      // The observer debounces, and diagnostics are flushed half a second later.
      await this.settle(560);
    },
    async pageStatus() {
      const handler = runtimeListeners.get("message");
      assert.ok(handler, "content.js should answer page messages");
      return new Promise((resolve) => {
        handler({ type: "GET_PAGE_STATUS" }, {}, resolve);
      });
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

{
  // The player's own title UI is enough; nothing else has to be fetched.
  const harness = createHarness({
    pageTitle: "Watch The Night Agent | Netflix Official Site",
    selectorMap: {
      '[data-uia="series-title"]': ["The Night Agent"],
      '[data-uia="episode-title"]': ["Season 1 Episode 5"],
      '[data-uia="video-title"]': [
        { parts: ["The Night Agent", "Season 1 Episode 5"] },
      ],
    },
  });
  await harness.start();
  await harness.fireTitleMutation();

  const status = await harness.pageStatus();
  assert.equal(status.status.showName, "The Night Agent");
  assert.equal(status.status.episodeName, "Season 1 · Episode 5");

  const resolved = harness.eventsNamed("episode-name-resolved");
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].category, "episode");
  assert.equal(resolved[0].details.showNameKind, "specific");
  assert.equal(resolved[0].details.episodeNameKind, "specific");
  assert.equal(resolved[0].details.episodeMarkerShape, "season-episode");
  assert.equal(resolved[0].details.episodeMarkerReason, "season-episode-marker");
  assert.equal(resolved[0].details.episodeNameFrom, "page");
  assert.equal(resolved[0].details.lookupSource, "player");
  assert.equal(harness.fetchRequests.length, 0, "no metadata page was needed");

  // The event log stays free of the names it is describing.
  const serialized = JSON.stringify(harness.debugEvents());
  assert.doesNotMatch(serialized, /The Night Agent/);
  assert.doesNotMatch(serialized, /Season 1/);
}

{
  // Nothing named is on the page, so the episode page is asked, and the answer
  // is adopted.
  const harness = createHarness({
    pageTitle: "Netflix",
    episodePageHtml:
      '<html><head><title>Example Show | Netflix Official Site</title></head>' +
      '<body><script>window.__data = ' +
      '{"videoId":80100172,"title":"The Beginning","number":5};' +
      "</script></body></html>",
  });
  await harness.start();

  const reconcile = harness.messagesOfType("CACHE_RECONCILE_FALLBACK");
  assert.ok(reconcile.length >= 1, "the page should report cache metadata");
  assert.equal(reconcile[0].metadata.showName, "Netflix");
  assert.equal(reconcile[0].metadata.episodeName, "Episode 80100172");

  const written = harness.messagesOfType("CACHE_SET");
  assert.equal(written.length, 1);
  assert.equal(written[0].cacheId, "80100172:test-model:English");
  assert.equal(written[0].metadata.showName, "Example Show");
  assert.equal(written[0].metadata.episodeName, "Episode 5 · The Beginning");
  assert.equal(written[0].metadata.sourceCueCount, 1);
  assert.equal(harness.fetchRequests.filter((url) => url.startsWith("/title/")).length, 1);

  const resolved = harness.eventsNamed("episode-name-resolved");
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].details.lookupSource, "episode-page");
  assert.equal(resolved[0].details.lookupReason, "ok");
  assert.equal(resolved[0].details.episodeNameKind, "specific");
  assert.equal(resolved[0].details.episodeMarkerShape, "none");

  const status = await harness.pageStatus();
  assert.equal(status.status.showName, "Example Show");
  assert.equal(status.status.episodeName, "Episode 5 · The Beginning");

  const serialized = JSON.stringify(harness.debugEvents());
  assert.doesNotMatch(serialized, /Example Show/);
  assert.doesNotMatch(serialized, /The Beginning/);
}

{
  // The episode page does not describe this video, so what is left is a stated
  // reason and the placeholder that names the video id.
  const harness = createHarness({
    pageTitle: "Netflix",
    episodePageHtml: "<html><head><title>Netflix</title></head><body></body></html>",
  });
  await harness.start();
  await harness.fireTitleMutation();

  const empty = harness.eventsNamed("episode-metadata-lookup-empty");
  assert.equal(empty.length, 1);
  assert.equal(empty[0].category, "episode");
  assert.equal(empty[0].details.reason, "video-id-not-found");
  assert.equal(empty[0].details.videoId, "80100172");

  const unresolved = harness.eventsNamed("episode-name-unresolved");
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].details.showNameKind, "placeholder");
  assert.equal(unresolved[0].details.showNameReason, "netflix-brand-only");
  assert.equal(unresolved[0].details.episodeNameKind, "placeholder");
  assert.equal(unresolved[0].details.episodeNameReason, "video-id-placeholder");

  assert.equal(harness.messagesOfType("CACHE_SET").length, 0);
  const status = await harness.pageStatus();
  assert.equal(status.status.showName, "Netflix");
  assert.equal(status.status.episodeName, "Episode 80100172");
  assert.equal(identity.isSpecificName(status.status.episodeName), false);
}

{
  // The episode page names the episode but not its number, and a wrong-language
  // or partial block is still reported rather than guessed at.
  const harness = createHarness({
    pageTitle: "Netflix",
    episodePageHtml:
      '<html><head><title>Example Show</title></head><body><script>' +
      '{"videoId":80100172,"title":"Only A Title"}' +
      "</script></body></html>",
  });
  await harness.start();

  const written = harness.messagesOfType("CACHE_SET");
  assert.equal(written.length, 1);
  assert.equal(written[0].metadata.episodeName, "Only A Title");
  assert.equal(written[0].metadata.showName, "Example Show");
  assert.equal(
    harness.eventsNamed("episode-name-resolved")[0].details.lookupReason,
    "episode-number-missing",
  );
}

{
  // A page whose episode is not being cached cannot be given a name either, and
  // that is reported once per reason rather than passing silently.
  const harness = createHarness({ pageTitle: "Netflix", cachedEntries: {} });
  await harness.start();
  await harness.fireTitleMutation();
  const skipped = harness.eventsNamed("episode-metadata-refresh-skipped");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].category, "episode");
  assert.equal(skipped[0].details.reason, "nothing-cached");
  assert.equal(harness.messagesOfType("CACHE_SET").length, 0);
  assert.equal(harness.eventsNamed("episode-name-resolved").length, 0);
  await harness.fireTitleMutation();
  assert.equal(
    harness.eventsNamed("episode-metadata-refresh-skipped").length,
    1,
    "the same reason should not be reported twice",
  );
}

// The page must not be able to hand the popup a name the popup then treats as
// real: both ask the same module.
{
  const harness = createHarness({ pageTitle: "Netflix" });
  await harness.start();
  await harness.fireTitleMutation();
  const status = await harness.pageStatus();
  assert.equal(status.status.showName, "Netflix");
  assert.equal(identity.preferredName(status.status.showName, "Netflix").name, "Netflix");
  assert.equal(identity.isSpecificName(status.status.showName), false);
  assert.equal(harness.eventsNamed("episode-name-unresolved").length, 1);
}

// The manifest has to load the module everywhere it is used, and before the
// files that read it.
{
  const manifest = JSON.parse(
    await fs.readFile(new URL("../manifest.json", import.meta.url), "utf8"),
  );
  const backgroundScripts = manifest.background?.scripts || [];
  assert.ok(backgroundScripts.includes("episode-identity.js"));
  assert.ok(
    backgroundScripts.indexOf("episode-identity.js") <
      backgroundScripts.indexOf("background.js"),
  );
  const contentScripts = (manifest.content_scripts || [])
    .filter((entry) => entry.world !== "MAIN")
    .flatMap((entry) => entry.js || []);
  assert.ok(contentScripts.includes("episode-identity.js"));
  assert.ok(
    contentScripts.indexOf("episode-identity.js") < contentScripts.indexOf("content.js"),
  );

  const backgroundSource = await fs.readFile(
    new URL("../background.js", import.meta.url),
    "utf8",
  );
  // The module is loaded by importScripts before the file that reads it, and a
  // broken load order degrades into a stated reason instead of an exception.
  assert.match(
    backgroundSource,
    /importScripts\([\s\S]{0,200}"episode-identity\.js"/,
  );
  assert.ok(
    backgroundSource.indexOf('"playback-site.js"') <
      backgroundSource.indexOf('"episode-identity.js"'),
    "playback-site.js must be imported before episode-identity.js",
  );
  assert.doesNotMatch(backgroundSource, /isGenericCacheName/);
  for (const page of ["../popup.html", "../options.html", "../setup.html"]) {
    const html = await fs.readFile(new URL(page, import.meta.url), "utf8");
    assert.match(
      html,
      /<script src="playback-site\.js"><\/script>/,
      `${page} does not load the playback-site adapter`,
    );
  }
}

// --- Episode keys ------------------------------------------------------------
//
// An episode key names one episode of one service and nothing else, so an
// imported subtitle file stays attached to its episode when the viewer changes
// the translation model or the target language — both of which change the cache
// id. It uses the cache id's namespace rule, so the two cannot disagree about
// which service an id belongs to.

{
  const netflixKey = identity.encodeEpisodeKey({ videoId: "8123", siteId: "netflix" });
  assert.equal(netflixKey, "8123", "Netflix keeps its un-namespaced spelling");
  assert.equal(
    identity.encodeEpisodeKey({ videoId: "B0B6GZ954Y", siteId: "primevideo" }),
    "primevideo~B0B6GZ954Y",
  );
  assert.equal(
    identity.encodeEpisodeKey({ videoId: "amzn1.dv.gti.abc-123", siteId: "primevideo" }),
    "primevideo~amzn1.dv.gti.abc-123",
  );
  // An id that is not a known shape has no episode key, because an import filed
  // under a placeholder would be handed to whichever video came next.
  assert.equal(identity.encodeEpisodeKey({ videoId: "unknown", siteId: "netflix" }), "");
  assert.equal(identity.encodeEpisodeKey({ videoId: "", siteId: "netflix" }), "");
  assert.equal(identity.encodeEpisodeKey({ videoId: "not an id", siteId: "netflix" }), "");
  assert.equal(identity.encodeEpisodeKey({}), "");
  // An unknown service is not namespaced onto the default one.
  assert.equal(
    identity.encodeEpisodeKey({ videoId: "8123", siteId: "somewhere" }),
    "8123",
    "an unknown service is not a namespace",
  );

  const decoded = identity.decodeEpisodeKey("primevideo~B0B6GZ954Y");
  assert.equal(decoded.videoId, "B0B6GZ954Y");
  assert.equal(decoded.siteId, "primevideo");
  assert.equal(decoded.namespace, "site");
  assert.equal(decoded.reason, "ok");

  const legacyKey = identity.decodeEpisodeKey("8123");
  assert.equal(legacyKey.videoId, "8123");
  assert.equal(legacyKey.siteId, "netflix");
  assert.equal(legacyKey.namespace, "legacy", "an un-namespaced key is Netflix's");
  assert.equal(legacyKey.reason, "ok");

  assert.deepEqual(
    JSON.parse(JSON.stringify(identity.decodeEpisodeKey("somewhere~8123"))),
    { videoId: "", siteId: "", namespace: "unknown", reason: "unknown-site-namespace" },
  );
  assert.equal(identity.decodeEpisodeKey("").reason, "empty-episode-key");
  // A cache id is not an episode key: the extra fields are refused, not read as
  // part of the video id.
  assert.equal(
    identity.decodeEpisodeKey("8123:qwen3%3A8b:English").reason,
    "unrecognized-video-id",
  );
  assert.equal(
    identity.decodeEpisodeKey("primevideo~not-an-id").reason,
    "unrecognized-video-id",
  );

  // An episode key round-trips to the service the cache id names.
  for (const [videoId, siteId] of [
    ["8123", "netflix"],
    ["B0B6GZ954Y", "primevideo"],
  ]) {
    const key = identity.encodeEpisodeKey({ videoId, siteId });
    const decodedKey = identity.decodeEpisodeKey(key);
    assert.equal(decodedKey.videoId, videoId);
    assert.equal(decodedKey.siteId, siteId);
    const cache = identity.decodeCacheId(
      identity.encodeCacheId({
        videoId,
        siteId,
        provider: "ollama",
        model: "qwen3:8b",
        targetLanguage: "English",
      }),
    );
    assert.equal(
      cache.siteId,
      decodedKey.siteId,
      "a cache id and an episode key must agree about the service",
    );
    assert.equal(
      cache.videoId,
      decodedKey.videoId,
      "a cache id and an episode key must agree about the episode",
    );
  }
}

// --- The show key --------------------------------------------------------------
//
// An imported file is keyed by episode, but what LST learned *about a show* —
// what Jimaku holds for it — belongs to every episode of that show and is keyed
// by the show instead. The services state no show id on a watch page, so the key
// is made from the name they do state.
{
  const identity = identityContext.LSTEpisodeIdentity;
  const key = (showName, siteId) => identity.encodeShowKey({ showName, siteId });

  assert.equal(key("The Witcher", "netflix"), "the-witcher");
  assert.equal(key("The Witcher", "primevideo"), "primevideo~the-witcher",
    "the service namespace rule is the cache id's rule");
  assert.equal(key("Mobile Suit Gundam: The Witch from Mercury", "netflix"),
    "mobile-suit-gundam-the-witch-from-mercury");
  assert.equal(key("  The   Witcher  ", "netflix"), "the-witcher",
    "spacing is not a different show");
  assert.equal(key("The Witcher", "primevideo"), key("the witcher", "primevideo"),
    "case is not a different show");
  assert.equal(key("鬼滅の刃", "netflix"), "鬼滅の刃",
    "a name that is not written in Latin letters is still a name");
  assert.equal(key("Épisode Spécial", "netflix"), "épisode-spécial");

  // A placeholder states no show, and a name with nothing to key on cannot be a
  // key. A fact filed under either would be found on every page of the service.
  for (const placeholder of ["Netflix", "Prime Video", "Episode 5", "", "   ", "!!!"]) {
    assert.equal(key(placeholder, "netflix"), "", `${JSON.stringify(placeholder)} names no show`);
  }
  assert.equal(key("Netflix", "netflix"), "");
  assert.equal(key(undefined, "netflix"), "");
  assert.equal(key("The Witcher"), "the-witcher", "an unknown service is the default one");
  assert.equal(key("The Witcher", "no-such-service"), "the-witcher",
    "a service LST does not know cannot namespace a key");

  // A long name is cut to a length a storage key can carry, without a trailing
  // separator left behind by the cut.
  const long = key("A".repeat(200), "netflix");
  assert.equal(long.length, 80);
  assert.equal(/^a+$/.test(long), true);
  assert.equal(key(`${"Show ".repeat(40)}`, "netflix").endsWith("-"), false);
  assert.equal(identity.showKeyShape("The Witcher"), "the-witcher");
}

console.log("Episode identity and cache metadata checks passed.");
