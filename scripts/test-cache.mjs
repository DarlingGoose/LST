import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const values = {};
let messageHandler;
let installedHandler;
const fetchRequests = [];

// What the two subtitle sources answer. The search proxy is anonymous; the
// Jimaku API and its downloads are keyed by the request URL.
const subtitleFiles = [
  {
    url: "https://jimaku.cc/entry/1811/download/%5BJudas%5D%20Show%20-%20S01E01.ja.srt",
    name: "[Judas] Show - S01E01.ja.srt",
    size: 30974,
    last_modified: "2025-02-28T21:58:34Z",
  },
];
const subtitleFileText = [
  "1",
  "00:00:09,000 --> 00:00:11,000",
  "\u96e8\u304c\u964d\u3063\u3066\u3082",
  "",
].join("\n");

async function mockFetch(url, init = {}) {
  fetchRequests.push({ url, init });

  if (url.startsWith("https://www.subtitlebot.com/api/jimaku/search")) {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      async json() {
        return [
          {
            id: 1811,
            name: "Kidou Senshi Gundam: Suisei no Majo",
            flags: { anime: true, movie: false, external: true, unverified: false, adult: false },
            last_modified: "2025-02-28T21:58:34Z",
            anilist_id: 139274,
            notes: "Netflix files originally numbered E02-13",
            english_name: "Mobile Suit Gundam: The Witch from Mercury",
            japanese_name: "\u6a5f\u52d5\u6226\u58eb\u30ac\u30f3\u30c0\u30e0 \u6c34\u661f\u306e\u9b54\u5973",
          },
        ];
      },
    };
  }

  if (url.startsWith("https://jimaku.cc/api/entries/")) {
    const authorized = init?.headers?.Authorization === "test-jimaku-key";
    return {
      ok: authorized,
      status: authorized ? 200 : 401,
      statusText: authorized ? "OK" : "Unauthorized",
      async json() {
        return subtitleFiles;
      },
    };
  }

  if (url.startsWith("https://jimaku.cc/entry/")) {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      async text() {
        return subtitleFileText;
      },
    };
  }

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
vm.runInContext(
  await fs.readFile(new URL("../episode-identity.js", import.meta.url), "utf8"),
  context,
  { filename: "episode-identity.js" },
);
vm.runInContext(
  await fs.readFile(new URL("../subtitle-import.js", import.meta.url), "utf8"),
  context,
  { filename: "subtitle-import.js" },
);
vm.runInContext(
  await fs.readFile(new URL("../translation-context.js", import.meta.url), "utf8"),
  context,
  { filename: "translation-context.js" },
);
vm.runInContext(
  await fs.readFile(new URL("../structured-response.js", import.meta.url), "utf8"),
  context,
  { filename: "structured-response.js" },
);
vm.runInContext(source, context, { filename: "background.js" });

await installedHandler();
assert.equal(values.model, "translategemma:4b");
assert.equal(values.showQuickPills, true);
assert.equal(values.showTranscriptSidebar, false);
assert.equal(values.useTranslationContext, false);
// The amount of surrounding context defaults to the level the module calls its
// own default, so an install that never opens the setting sends what it always
// sent and the two files cannot disagree about which level that is.
assert.equal(values.contextLevel, context.LSTTranslationContext.CONTEXT_LEVEL_DEFAULT);

// --- Settings: the renamed key, the per-service map, and the HUD position ----

// A preference saved before the rename survives it. `??` and not `||`: a stored
// `false` is a real answer and the default must not replace it.
delete values.hideNativeSubtitles;
values.hideNetflixSubtitles = false;
let settingsResponse = await send({ type: "GET_SETTINGS" });
assert.equal(settingsResponse.settings.hideNativeSubtitles, false, "a legacy false survives the rename");

values.hideNetflixSubtitles = true;
delete values.hideNativeSubtitles;
settingsResponse = await send({ type: "GET_SETTINGS" });
assert.equal(settingsResponse.settings.hideNativeSubtitles, true);

// The new key wins when both are stored.
values.hideNativeSubtitles = false;
values.hideNetflixSubtitles = true;
settingsResponse = await send({ type: "GET_SETTINGS" });
assert.equal(settingsResponse.settings.hideNativeSubtitles, false);

// Saving writes the neutral key and removes the legacy one.
delete values.hideNativeSubtitles;
values.hideNetflixSubtitles = false;
await send({ type: "SAVE_SETTINGS", settings: { hideNativeSubtitles: true } });
assert.equal(values.hideNativeSubtitles, true, "the neutral key is the one written");
assert.equal(values.hideNetflixSubtitles, undefined, "the legacy key is cleaned up");

// Both services are enabled by default and the HUD corner is the viewer's to
// choose, so a fresh install is described by the defaults rather than by a
// per-service special case.
assert.deepEqual(
  JSON.parse(JSON.stringify(values.enabledSites)),
  { netflix: true, primevideo: true },
);
assert.equal(values.hudPosition, "");
assert.equal((await send({ type: "GET_SETTINGS" })).settings.hudPosition, "");

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

// A Prime Video cache is namespaced in its key, and the service the key names is
// what the library groups it under — not whatever a page reported.
const primeCacheId = "primevideo~B0B6GZ954Y:qwen3%3A8b:English";
await send({
  type: "CACHE_SET",
  cacheId: primeCacheId,
  entries: { "0:1000:こんにちは": "Hello" },
  metadata: { videoId: "B0B6GZ954Y", sourceCueCount: 12 },
});
response = await send({ type: "LIST_TRANSLATION_CACHES" });
assert.equal(response.caches.length, 1);
assert.equal(response.caches[0].cacheId, primeCacheId);
assert.equal(response.caches[0].siteId, "primevideo");
assert.equal(response.caches[0].showName, "Prime Video");
assert.equal(response.caches[0].episodeName, "Episode B0B6GZ954Y");
assert.equal(response.caches[0].title, "Prime Video episode B0B6GZ954Y");

// A page claiming Netflix cannot move a Prime Video cache's service.
await send({
  type: "CACHE_SET",
  cacheId: primeCacheId,
  entries: {},
  metadata: { videoId: "B0B6GZ954Y", siteId: "netflix", showName: "Some Show" },
});
response = await send({ type: "LIST_TRANSLATION_CACHES" });
assert.equal(response.caches[0].siteId, "primevideo", "the cache id owns the service");
assert.equal(response.caches[0].showName, "Some Show", "a real name still wins");
await send({ type: "DELETE_TRANSLATION_CACHE", cacheId: primeCacheId });
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

// --- Imported subtitles ------------------------------------------------------
//
// A viewer attaches a subtitle file from Jimaku for one episode. The search is
// anonymous, listing an entry's files needs the viewer's own Jimaku key, and the
// file itself is downloaded from the URL the listing published.

{
  // The search asks the anonymous proxy, and only the query and flags travel.
  const search = await send({ type: "IMPORT_SEARCH", query: "The Witch from Mercury" });
  assert.equal(search.ok, true);
  assert.equal(search.entries.length, 1);
  assert.equal(search.entries[0].entryId, 1811);
  assert.equal(
    search.entries[0].displayName,
    "Mobile Suit Gundam: The Witch from Mercury",
    "the English name is offered first",
  );
  assert.equal(search.entries[0].pageUrl, "https://jimaku.cc/entry/1811");
  const searchRequest = fetchRequests.find((request) =>
    request.url.startsWith("https://www.subtitlebot.com/api/jimaku/search"),
  );
  assert.equal(
    searchRequest.url,
    "https://www.subtitlebot.com/api/jimaku/search?query=The+Witch+from+Mercury&limit=50&anime=true",
  );
  assert.equal(
    searchRequest.init.headers,
    undefined,
    "the search carries no account and no key",
  );

  // Nothing is downloaded before a show is chosen.
  const empty = await send({ type: "IMPORT_SEARCH", query: "   " });
  assert.match(empty.error, /show name/);

  // Listing an entry's files needs the viewer's own Jimaku key.
  assert.equal((await send({ type: "GET_IMPORT_KEY_STATUS" })).configured, false);
  const withoutKey = await send({ type: "IMPORT_LIST_FILES", entryId: 1811 });
  assert.equal(withoutKey.ok, false);
  assert.match(withoutKey.error, /API key/);

  await send({ type: "SET_IMPORT_KEY", key: "test-jimaku-key" });
  assert.equal((await send({ type: "GET_IMPORT_KEY_STATUS" })).configured, true);
  const files = await send({ type: "IMPORT_LIST_FILES", entryId: 1811, episode: 1 });
  assert.equal(files.ok, true);
  assert.equal(files.files.length, 1);
  assert.equal(files.files[0].episode, 1);
  assert.equal(files.files[0].language, "Japanese");
  assert.equal(files.files[0].supported, true);
  const filesRequest = fetchRequests.find((request) =>
    request.url.startsWith("https://jimaku.cc/api/entries/"),
  );
  assert.equal(filesRequest.url, "https://jimaku.cc/api/entries/1811/files?episode=1");
  assert.equal(filesRequest.init.headers.Authorization, "test-jimaku-key");

  // A file that names another host is refused rather than fetched.
  const offOrigin = await send({
    type: "IMPORT_TRACK",
    episodeKey: "primevideo~B0B6GZ954Y",
    file: { name: "Show.srt", url: "https://example.invalid/Show.srt" },
  });
  assert.equal(offOrigin.ok, false);
  assert.match(offOrigin.error, /not served by Jimaku/);
  // So is a format LST cannot read.
  const archive = await send({
    type: "IMPORT_TRACK",
    episodeKey: "primevideo~B0B6GZ954Y",
    file: { name: "Show Batch.zip", url: subtitleFiles[0].url },
  });
  assert.equal(archive.ok, false);
  assert.match(archive.error, /cannot be read yet/);

  // Importing the real file: the language in the file name decides that this
  // track has to be translated for a viewer reading English.
  const entry = search.entries[0];
  const imported = await send({
    type: "IMPORT_TRACK",
    episodeKey: "primevideo~B0B6GZ954Y",
    entry,
    file: files.files[0],
  });
  assert.equal(imported.ok, true);
  assert.equal(imported.track.fileName, "[Judas] Show - S01E01.ja.srt");
  assert.equal(imported.track.translate, true);
  assert.equal(imported.track.translateReason, "track-language-differs");
  assert.equal(imported.track.cueCount, 1);
  assert.equal(imported.track.hasText, true);
  assert.equal(
    Object.prototype.hasOwnProperty.call(imported.track, "text"),
    false,
    "a summary never carries the subtitle text",
  );
  const download = fetchRequests.find((request) =>
    request.url.startsWith("https://jimaku.cc/entry/"),
  );
  assert.equal(download.init.headers, undefined, "a download needs no key");

  // The player asks for the track and gets the text it needs to render.
  const forPlayer = await send({ type: "GET_IMPORTED_TRACK", episodeKey: "primevideo~B0B6GZ954Y" });
  assert.equal(forPlayer.reason, "ok");
  assert.equal(forPlayer.track.text, subtitleFileText);
  assert.equal(forPlayer.track.translate, true);

  // Another episode has no import, and that is not an error.
  const otherEpisode = await send({ type: "GET_IMPORTED_TRACK", episodeKey: "primevideo~B0B6GZ954R" });
  assert.equal(otherEpisode.track, null);
  assert.equal(otherEpisode.reason, "not-imported");
  assert.equal((await send({ type: "GET_IMPORTED_TRACK", episodeKey: "" })).reason, "no-episode-key");

  // A viewer reading Japanese needs nothing translated, and the same file is
  // therefore stored with the opposite decision.
  await send({ type: "SAVE_SETTINGS", settings: { targetLanguage: "Japanese" } });
  await send({ type: "IMPORT_TRACK", episodeKey: "8123", entry, file: files.files[0] });
  const asJapanese = await send({ type: "GET_IMPORTED_TRACK", episodeKey: "8123" });
  assert.equal(asJapanese.track.translate, false);
  assert.equal(asJapanese.track.translateReason, "track-already-in-target-language");

  // A viewer can overrule the decision.
  await send({
    type: "IMPORT_TRACK",
    episodeKey: "8123",
    entry,
    file: files.files[0],
    translate: true,
  });
  const overruled = await send({ type: "GET_IMPORTED_TRACK", episodeKey: "8123" });
  assert.equal(overruled.track.translate, true);
  assert.equal(overruled.track.translateReason, "viewer-choice");

  // Imports are listed so storage stays visible, and can be removed.
  const listed = await send({ type: "LIST_IMPORTED_TRACKS" });
  assert.equal(listed.tracks.length, 2);
  assert.ok(listed.bytes > 0);
  assert.equal(listed.limit > 0, true);
  assert.equal(
    listed.tracks.every((track) => !Object.prototype.hasOwnProperty.call(track, "text")),
    true,
    "the interface lists tracks without their text",
  );
  const removed = await send({ type: "DELETE_IMPORTED_TRACK", episodeKey: "8123" });
  assert.equal(removed.removed, true);
  assert.equal((await send({ type: "GET_IMPORTED_TRACK", episodeKey: "8123" })).track, null);
  assert.equal((await send({ type: "LIST_IMPORTED_TRACKS" })).tracks.length, 1);
  assert.equal(
    (await send({ type: "DELETE_IMPORTED_TRACK", episodeKey: "8123" })).removed,
    false,
    "removing what is not there is not an error",
  );

  // The Jimaku key is stored like a provider key: never in the settings, never
  // written by a settings save, and never reported back to a page.
  const settings = await send({ type: "GET_SETTINGS" });
  assert.equal(Object.prototype.hasOwnProperty.call(settings.settings, "jimakuApiKey"), false);
  await send({ type: "SAVE_SETTINGS", settings: { jimakuApiKey: "stolen", targetLanguage: "English" } });
  assert.equal(values.jimakuApiKey, "test-jimaku-key", "a settings save cannot replace the key");
  await send({ type: "SET_IMPORT_KEY", key: "" });
  assert.equal(values.jimakuApiKey, undefined);
  assert.equal((await send({ type: "GET_IMPORT_KEY_STATUS" })).configured, false);
}

// --- What Jimaku held for a show ---------------------------------------------
//
// The player says what Jimaku holds for a show on arrival, and it does that from
// a note rather than from a request: a page that is only opened must not tell
// anyone which shows are being watched. The note is written here, by the one
// thing that is allowed to ask — the search the viewer ran.

{
  const showKey = "primevideo~mobile-suit-gundam-the-witch-from-mercury";
  // Nothing is known about a show nobody asked about, and that is not an error.
  const unknown = await send({ type: "GET_JIMAKU_FINDING", showKey });
  assert.equal(unknown.ok, true);
  assert.equal(unknown.finding, null);
  assert.equal(unknown.reason, "no-finding-yet");
  assert.equal((await send({ type: "GET_JIMAKU_FINDING", showKey: "" })).reason, "no-show-key");

  // A search the viewer ran is the note. The show is named by the caller,
  // because only the page knows which show is on screen.
  const searched = await send({
    type: "IMPORT_SEARCH",
    query: "The Witch from Mercury",
    showKey,
    showName: "Mobile Suit Gundam: The Witch from Mercury",
    siteId: "primevideo",
  });
  assert.equal(searched.finding.showKey, showKey);
  assert.equal(searched.finding.entryCount, 1);
  assert.equal(searched.finding.fileCount, null, "a search lists no files");
  assert.equal(values.jimakuFindings[showKey].entryCount, 1);
  const stored = await send({ type: "GET_JIMAKU_FINDING", showKey });
  assert.equal(stored.reason, "ok");
  assert.equal(stored.finding.showName, "Mobile Suit Gundam: The Witch from Mercury");

  // A search nobody identified is not filed under a guessed show.
  const anonymous = await send({ type: "IMPORT_SEARCH", query: "The Witch from Mercury" });
  assert.equal(anonymous.finding, null);
  assert.equal(Object.keys(values.jimakuFindings).length, 1);

  // Listing an entry's files sharpens the note: it is the difference between
  // "Jimaku knows this show" and "there is a file for this episode".
  await send({ type: "SET_IMPORT_KEY", key: "test-jimaku-key" });
  const listed = await send({
    type: "IMPORT_LIST_FILES",
    entryId: 1811,
    episode: 1,
    showKey,
    entryName: "Mobile Suit Gundam: The Witch from Mercury",
  });
  assert.equal(listed.finding.fileCount, 1);
  assert.equal(listed.finding.episode, 1);
  assert.equal(listed.finding.entryId, 1811);
  assert.equal(values.jimakuFindings[showKey].fileCount, 1);
  // A listing for a show nobody searched for cannot invent a note from nothing.
  const listingOnly = await send({
    type: "IMPORT_LIST_FILES",
    entryId: 1811,
    episode: 1,
    showKey: "netflix~some-other-show",
  });
  assert.equal(listingOnly.finding, null);
  assert.equal(values.jimakuFindings["netflix~some-other-show"], undefined);

  // A note that has gone stale is not an answer: it would send the viewer to a
  // listing that has changed.
  values.jimakuFindings[showKey].checkedAt = new Date(
    Date.now() - 90 * 24 * 60 * 60 * 1000,
  ).toISOString();
  assert.equal((await send({ type: "GET_JIMAKU_FINDING", showKey })).finding, null);
  assert.equal(
    values.jimakuFindings[showKey],
    undefined,
    "a note that expired is dropped rather than kept",
  );

  // An unreadable note is dropped too, and never handed over as an answer.
  values.jimakuFindings[showKey] = { showName: "No time, no key" };
  assert.equal((await send({ type: "GET_JIMAKU_FINDING", showKey })).finding, null);
  assert.equal(values.jimakuFindings[showKey], undefined);

  // The viewer can drop what LST remembers about a show.
  await send({
    type: "IMPORT_SEARCH",
    query: "The Witch from Mercury",
    showKey,
    showName: "Mobile Suit Gundam: The Witch from Mercury",
    siteId: "primevideo",
  });
  assert.equal((await send({ type: "DELETE_JIMAKU_FINDING", showKey })).removed, true);
  assert.equal((await send({ type: "GET_JIMAKU_FINDING", showKey })).finding, null);
  assert.equal((await send({ type: "DELETE_JIMAKU_FINDING", showKey })).removed, false);
  await send({ type: "SET_IMPORT_KEY", key: "" });
}

// --- A subtitle file already on the device -----------------------------------
//
// The viewer downloaded the file themselves and picked it from their own disk.
// Nothing is fetched, no host permission is involved, and the Jimaku key is
// irrelevant to it — but the same questions still have to be answered: what
// format the file is, what language it is in, and whether it needs translating.

{
  const deviceSrt = [
    "1",
    "00:00:03,087 --> 00:00:04,964",
    "\u7de8\u5165\u624b\u7d9a\u304d\u3088\u3057",
    "",
    "2",
    "00:00:05,297 --> 00:00:06,632",
    "\u5236\u670d\u3088\u3057",
    "",
  ].join("\n");

  // No Jimaku key is saved at this point, and none is needed.
  assert.equal(values.jimakuApiKey, undefined);

  const requestsBefore = fetchRequests.length;
  const local = await send({
    type: "IMPORT_TRACK_TEXT",
    episodeKey: "8123",
    fileName: "[Judas] Show - S01E04.ja.srt",
    size: deviceSrt.length,
    text: deviceSrt,
    episode: 4,
  });
  assert.equal(local.ok, true);
  assert.equal(
    fetchRequests.length,
    requestsBefore,
    "importing a file from this device makes no request at all",
  );
  assert.equal(local.track.source, "local-file");
  assert.equal(local.track.fileUrl, "", "there is no address to report");
  assert.equal(local.track.entryId, 0);
  assert.equal(local.track.entryName, "");
  assert.equal(local.track.format, "srt");
  assert.equal(local.track.cueCount, 2);
  assert.equal(local.track.language, "Japanese");
  assert.equal(local.track.translate, true);
  assert.equal(local.track.translateReason, "track-language-differs");
  assert.equal(local.track.episodeMatch.reason, "episode-match");
  assert.equal(local.track.hasText, true);
  assert.equal(
    Object.prototype.hasOwnProperty.call(local.track, "text"),
    false,
    "a summary never carries the subtitle text",
  );

  // The player can read it without anyone having been asked for anything.
  const forPlayer = await send({ type: "GET_IMPORTED_TRACK", episodeKey: "8123" });
  assert.equal(forPlayer.reason, "ok");
  assert.equal(forPlayer.track.text, deviceSrt);
  assert.equal(forPlayer.track.source, "local-file");
  assert.equal(forPlayer.track.translate, true);

  // The viewer's own instruction outranks the file's language, and the decision
  // is stored as theirs.
  await send({
    type: "IMPORT_TRACK_TEXT",
    episodeKey: "8123",
    fileName: "[Judas] Show - S01E04.ja.srt",
    text: deviceSrt,
    episode: 4,
    translate: false,
  });
  const shownAsItIs = await send({ type: "GET_IMPORTED_TRACK", episodeKey: "8123" });
  assert.equal(shownAsItIs.track.translate, false);
  assert.equal(shownAsItIs.track.translateReason, "viewer-choice");

  // A file naming another episode is reported rather than refused: the viewer
  // chose it, and a service may number its episodes its own way.
  const mismatched = await send({
    type: "IMPORT_TRACK_TEXT",
    episodeKey: "8123",
    fileName: "[Judas] Show - S01E07.ja.srt",
    text: deviceSrt,
    episode: 4,
  });
  assert.equal(mismatched.ok, true);
  assert.equal(mismatched.track.episodeMatch.reason, "episode-mismatch");
  assert.equal(mismatched.track.episodeMatch.fileEpisode, 7);
  assert.equal(mismatched.track.episodeMatch.targetEpisode, 4);

  // What LST cannot read is refused with a reason, and nothing is stored.
  const beforeRefusals = (await send({ type: "LIST_IMPORTED_TRACKS" })).tracks.length;
  const refusals = [
    [
      { fileName: "Show Batch.zip", text: deviceSrt },
      /cannot be read yet/,
      "an archive has to be unpacked first",
    ],
    [
      { fileName: "Show - S01E04.ass", text: deviceSrt },
      /cannot be read yet/,
      "ASS is named and unreadable",
    ],
    [{ fileName: "Show - S01E04", text: deviceSrt }, /subtitle format/, "no extension at all"],
    [{ fileName: "Show - S01E04.srt", text: "   " }, /empty/, "an empty file"],
    [
      { fileName: "Show - S01E04.srt", text: "this file is not a subtitle at all" },
      /no readable SubRip cues/,
      "prose named as SubRip",
    ],
    [
      { fileName: "Show - S01E04.vtt", text: "Just some prose about a show." },
      /no subtitle timings/,
      "prose named as WebVTT",
    ],
    [
      { fileName: "Show - S01E04.srt", text: "x".repeat(8 * 1024 * 1024 + 1) },
      /larger than LST will store/,
      "a file too large to keep",
    ],
    [{ text: deviceSrt }, /Choose a subtitle file/, "a file with no name"],
  ];
  for (const [message, expected, why] of refusals) {
    const refused = await send({
      type: "IMPORT_TRACK_TEXT",
      episodeKey: "8123",
      episode: 4,
      ...message,
    });
    assert.equal(refused.ok, false, why);
    assert.match(refused.error, expected, why);
    assert.equal(
      Object.prototype.hasOwnProperty.call(refused, "track"),
      false,
      `${why}: a refused file leaves nothing behind`,
    );
  }
  assert.equal(
    (await send({ type: "LIST_IMPORTED_TRACKS" })).tracks.length,
    beforeRefusals,
    "a refusal must not store a track",
  );

  // Without a playback episode there is nowhere to file the file.
  const nowhere = await send({
    type: "IMPORT_TRACK_TEXT",
    episodeKey: "",
    fileName: "Show - S01E04.srt",
    text: deviceSrt,
  });
  assert.equal(nowhere.ok, false);
  assert.match(nowhere.error, /playback page/);

  // The import is listed like any other, and says where it came from.
  const listed = await send({ type: "LIST_IMPORTED_TRACKS" });
  const stored = listed.tracks.find((item) => item.episodeKey === "8123");
  assert.equal(stored.source, "local-file");
  assert.equal(
    Object.prototype.hasOwnProperty.call(stored, "text"),
    false,
    "listing a track never returns its text",
  );
  assert.ok(listed.bytes >= deviceSrt.length);
  await send({ type: "DELETE_IMPORTED_TRACK", episodeKey: "8123" });
  assert.equal((await send({ type: "GET_IMPORTED_TRACK", episodeKey: "8123" })).track, null);
}

console.log("Translation cache management checks passed.");
