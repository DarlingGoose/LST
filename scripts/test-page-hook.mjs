import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const read = (name) => fs.readFile(new URL(`../${name}`, import.meta.url), "utf8");
const playbackSiteSource = await read("playback-site.js");
const pageHookSource = await read("page-hook.js");
const contentSource = await read("content.js");
const identitySource = await read("episode-identity.js");
const translationContextSource = await read("translation-context.js");

const NETFLIX_TTML = `<?xml version="1.0"?>
<tt xmlns="http://www.w3.org/ns/ttml"><body><div>
<p begin="00:00:01.000" end="00:00:03.000">Hello from Netflix.</p>
</div></body></tt>`;

const PRIME_TTML = `<?xml version="1.0"?>
<tt xmlns="http://www.w3.org/ns/ttml"><body><div>
<p begin="00:00:01.000" end="00:00:03.000">こんにちは。</p>
</div></body></tt>`;

const VTT = `WEBVTT

00:00:01.000 --> 00:00:03.000
Hello there`;

// Prime's playback-resources listing: the request names the title and the
// answer names every timed-text track it carries. The Japanese track is listed
// second on purpose, so a capture that took the first track would be caught.
const PRIME_JA_URL = "https://aiv-cdn.net/ttml/B0B6GZ954Y.ja.ttml";
const PRIME_EN_URL = "https://aiv-cdn.net/ttml/B0B6GZ954Y.en.ttml";
// The same answer names the episode the player is about to show: Amazon's own
// catalog entry for it, its season, and the series the season belongs to.
const PRIME_EPISODE_ID = "amzn1.dv.gti.e4b2f72f-8a6e-405e-44fe-bedba416d622";
const PRIME_SERIES_ID = "amzn1.dv.gti.c8b2d812-7ea7-6b33-ae74-08abb760fe3c";
const PRIME_LISTING = JSON.stringify({
  catalogMetadata: {
    catalog: {
      entityType: "TV Show",
      episodeNumber: 1,
      id: PRIME_EPISODE_ID,
      title: "The Smile",
      type: "EPISODE",
      version: "1.0",
    },
    family: {
      tvAncestors: [
        { catalog: { seasonNumber: 2, title: "Homeland - Season 2", type: "SEASON" } },
        { catalog: { id: PRIME_SERIES_ID, title: "Homeland", type: "SHOW" } },
      ],
    },
  },
  timedTextUrls: {
    result: {
      subtitleUrls: [
        { languageCode: "en", displayName: "English", url: PRIME_EN_URL },
        { languageCode: "ja", displayName: "日本語", url: PRIME_JA_URL },
      ],
    },
  },
});

const PLAYBACK_RESOURCES = JSON.stringify({
  timedtexttracks: [{ ttDownloadables: { ttml: { urls: ["https://x.ttml"] } } }],
});

// --- Section 1: what the page hook publishes, and what it refuses ------------

function locationFor(href) {
  const url = new URL(href);
  return {
    href,
    pathname: url.pathname,
    search: url.search,
    host: url.host,
  };
}

class MockXHR {
  constructor() {
    this.listeners = new Map();
    this.responseType = "";
    this.responseText = "";
    this.responseURL = "";
    this.headers = {};
  }
  open(method, url) {
    this.requestUrl = String(url);
  }
  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }
  getResponseHeader(name) {
    return this.headers[String(name).toLowerCase()] ?? null;
  }
  send() {
    // The request is already complete by the time the hook listens for load.
    for (const handler of this.listeners.get("load") || []) handler.call(this);
  }
}

function responseFor({ url, contentType, body }) {
  return {
    url,
    ok: true,
    status: 200,
    headers: {
      get(name) {
        if (name === "content-type") return contentType;
        if (name === "content-length") return String(body.length);
        return null;
      },
    },
    // The response the page world reads when it fetches a track itself, and the
    // copy the observer reads on its way past.
    async text() { return body; },
    async json() { return JSON.parse(body); },
    clone() {
      return {
        async text() { return body; },
        async json() { return JSON.parse(body); },
      };
    },
  };
}

function createPageHarness(href) {
  const messages = [];
  // The hook captures window.fetch when it loads, so the response a call gets
  // back is supplied here rather than by replacing the function afterwards.
  let nextResponse = { url: "", contentType: "text/plain", body: "" };
  // Responses served by their own URL. The hook fetches a subtitle document
  // from the listing it read, so the page world's own request has to be
  // answerable here and not by whatever was fetched last.
  const servedResponses = new Map();
  const context = vm.createContext({
    XMLHttpRequest: MockXHR,
    console,
    setTimeout,
    clearTimeout,
    URL,
    fetch: async (url) => {
      const served = servedResponses.get(String(url));
      if (served?.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, served.delayMs));
      }
      return served ? responseFor(served) : responseFor(nextResponse);
    },
    postMessage: (message) => messages.push(message),
  });
  vm.runInContext("globalThis.window = globalThis", context);
  context.location = locationFor(href);
  vm.runInContext(playbackSiteSource, context, { filename: "playback-site.js" });
  vm.runInContext(pageHookSource, context, { filename: "page-hook.js" });

  return {
    messages,
    async goTo(nextHref) {
      context.location = locationFor(nextHref);
    },
    async fetch(url, contentType, body) {
      nextResponse = { url, contentType, body };
      await context.fetch(url);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    // A response the page world can find by its URL alone, as a CDN serves one.
    serve(url, body, contentType = "text/xml") {
      servedResponses.set(String(url), { url, contentType, body });
    },
    // The same, but slow, so a check can prove that LST's own fetch of a track
    // never holds up the player's request that led to it.
    serveSlowly(url, body, delayMs = 20, contentType = "text/xml") {
      servedResponses.set(String(url), { url, contentType, body, delayMs });
    },
    async xhr(url, contentType, body) {
      const xhr = new MockXHR();
      xhr.open("GET", url);
      xhr.responseURL = url;
      xhr.responseText = body;
      xhr.headers = { "content-type": contentType };
      xhr.send();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    published() {
      return messages.filter((message) => message.type === "SUBTITLE_DOCUMENT");
    },
    notes() {
      return messages.filter((message) => message.type === "SUBTITLE_CAPTURE");
    },
    // Which episode the listing said it was about. It travels as its own
    // message because it is not a subtitle document.
    identities() {
      return messages.filter((message) => message.type === "EPISODE_IDENTITY");
    },
  };
}

const captureCases = [
  // [name, href, transport, url, contentType, body, expected site id or ""]
  [
    "Netflix browse page",
    "https://www.netflix.com/browse",
    "fetch",
    "https://www.netflix.com/subtitle.vtt",
    "text/vtt",
    VTT,
    "",
  ],
  [
    "Netflix search page",
    "https://www.netflix.com/search?q=x",
    "fetch",
    "https://www.netflix.com/subtitle.vtt",
    "text/vtt",
    VTT,
    "",
  ],
  [
    "Netflix watch page, WEBVTT",
    "https://www.netflix.com/watch/80100172",
    "fetch",
    "https://www.netflix.com/subtitle.vtt",
    "text/vtt",
    VTT,
    "netflix",
  ],
  [
    "Netflix watch page, the ?o= timed-text shape",
    "https://www.netflix.com/watch/80100172",
    "fetch",
    "https://www.netflix.com/api/timedtext?o=123",
    "text/xml",
    NETFLIX_TTML,
    "netflix",
  ],
  [
    "Netflix watch page, an unrelated JSON response",
    "https://www.netflix.com/watch/80100172",
    "fetch",
    "https://www.netflix.com/api/metadata",
    "application/json",
    PLAYBACK_RESOURCES,
    "",
  ],
  [
    "Netflix watch page, a subtitle URL with a non-subtitle body",
    "https://www.netflix.com/watch/80100172",
    "fetch",
    "https://www.netflix.com/subtitle.vtt",
    "text/vtt",
    "<html><body>Not a subtitle.</body></html>",
    "",
  ],
  [
    "Prime browse page (a product page)",
    "https://www.amazon.co.jp/dp/B0B6GZ954Y",
    "fetch",
    "https://aiv-cdn.net/subtitle.ttml",
    "text/xml",
    PRIME_TTML,
    "",
  ],
  [
    "Prime storefront",
    "https://www.primevideo.com/",
    "fetch",
    "https://aiv-cdn.net/subtitle.ttml",
    "text/xml",
    PRIME_TTML,
    "",
  ],
  [
    "Japan detail page, a CDN TTML",
    "https://www.amazon.co.jp/-/en/gp/video/detail/B0B6GZ954Y",
    "fetch",
    "https://aiv-delivery.net/ttml/B0B6GZ954Y.ttml",
    "text/xml",
    PRIME_TTML,
    "primevideo",
  ],
  [
    "Japan detail page, a WEBVTT asset",
    "https://www.amazon.co.jp/gp/video/detail/B0B6GZ954Y",
    "fetch",
    "https://pv-cdn.net/subtitle.vtt",
    "text/vtt",
    VTT,
    "primevideo",
  ],
  [
    "primevideo.com detail page",
    "https://www.primevideo.com/detail/0ABCDEFGHIJK",
    "fetch",
    "https://aiv-cdn.net/x.dfxp",
    "text/xml",
    PRIME_TTML,
    "primevideo",
  ],
  [
    // The listing is not a subtitle document: it is read for the names of the
    // ones that exist. A listing whose track cannot be read publishes nothing —
    // and says why, which the next section checks.
    "Japan detail page, a playback-resources listing naming an unreadable track",
    "https://www.amazon.co.jp/-/en/gp/video/detail/B0B6GZ954Y",
    "fetch",
    "https://atv-ps.amazon.com/cdp/catalog/GetPlaybackResources",
    "application/json",
    PLAYBACK_RESOURCES,
    "",
  ],
  [
    "Japan detail page over XHR",
    "https://www.amazon.co.jp/-/en/gp/video/detail/B0B6GZ954Y",
    "xhr",
    "https://aiv-cdn.net/ttml/B0B6GZ954Y.ttml",
    "text/xml",
    PRIME_TTML,
    "primevideo",
  ],
  [
    "Prime browse page over XHR",
    "https://www.amazon.co.jp/gp/video/storefront",
    "xhr",
    "https://aiv-cdn.net/ttml/B0B6GZ954Y.ttml",
    "text/xml",
    PRIME_TTML,
    "",
  ],
  [
    // A document is tagged with the page it was captured on, never with the
    // shape of its URL, so a track from one service can never be adopted by the
    // other. content.js enforces the same rule from the other side.
    "a Netflix-shaped document captured on Prime Video",
    "https://www.primevideo.com/detail/0ABCDEFGHIJK",
    "fetch",
    "https://www.netflix.com/api/timedtext?o=123",
    "text/xml",
    NETFLIX_TTML,
    "primevideo",
  ],
];

for (const [name, href, transport, url, contentType, body, expected] of captureCases) {
  const harness = createPageHarness(href);
  await harness[transport](url, contentType, body);
  const published = harness.published();
  if (!expected) {
    assert.equal(published.length, 0, `${name}: nothing should be published`);
    continue;
  }
  assert.equal(published.length, 1, `${name}: one document should be published`);
  assert.equal(published[0].source, "lst-local-subtitle-translate");
  assert.equal(published[0].payload.site, expected, `${name}: site tag`);
  assert.equal(published[0].payload.url, url, `${name}: the url travels with it`);
  assert.ok(published[0].payload.text.includes("00:00:01"), `${name}: the document travels with it`);
}

// --- Prime's playback-resources listing --------------------------------------
//
// Prime hands its player a listing rather than a document, so the hook reads the
// listing, takes the track the adapter names, fetches that one document in the
// page world, and publishes it exactly as a Netflix document is published. The
// request carries the page's own origin and cookies and no extension permission,
// which is why the fetching happens here rather than in the background.

const PRIME_DETAIL = "https://www.amazon.co.jp/-/en/gp/video/detail/B0B6GZ954Y";
const PRIME_LISTING_URL =
  "https://atv-ps.amazon.com/cdp/catalog/GetPlaybackResources";

{
  const harness = createPageHarness(PRIME_DETAIL);
  harness.serve(PRIME_JA_URL, PRIME_TTML);
  harness.serve(PRIME_EN_URL, PRIME_TTML);
  await harness.fetch(PRIME_LISTING_URL, "application/json", PRIME_LISTING);

  const published = harness.published();
  assert.equal(published.length, 1, "one whole track is published from the listing");
  assert.equal(published[0].payload.site, "primevideo");
  assert.equal(
    published[0].payload.url,
    PRIME_JA_URL,
    "the Japanese track is the one captured, though it is listed second",
  );
  assert.equal(published[0].payload.language, "ja");
  assert.equal(published[0].payload.capture, "playback-resources");
  assert.equal(published[0].payload.reason, "preferred-language:ja");
  assert.ok(
    published[0].payload.text.includes("こんにちは"),
    "the whole document travels, not a line of it",
  );
  assert.ok(
    harness
      .notes()
      .some((note) => note.payload.event === "playback-resources-track-captured"),
    "the capture reports what it captured and why",
  );
}

// The listing also names the episode, and that answer is published beside the
// document. It is what tells the player which episode it is showing when the
// page's URL does not, so it is published even when the listing names no track
// LST can use — a title with no subtitles still has a name.
{
  const harness = createPageHarness(PRIME_DETAIL);
  harness.serve(PRIME_JA_URL, PRIME_TTML);
  harness.serve(PRIME_EN_URL, PRIME_TTML);
  await harness.fetch(PRIME_LISTING_URL, "application/json", PRIME_LISTING);
  const identities = harness.identities();
  assert.equal(identities.length, 1, "one listing, one identity");
  assert.equal(identities[0].payload.site, "primevideo");
  assert.equal(identities[0].payload.reason, "catalog-metadata");
  assert.equal(identities[0].payload.videoId, PRIME_EPISODE_ID);
  assert.equal(identities[0].payload.title, "The Smile");
  assert.equal(identities[0].payload.showName, "Homeland");
  assert.equal(identities[0].payload.episodeNumber, 1);
  assert.equal(identities[0].payload.seasonNumber, 2);
  assert.equal(identities[0].payload.episodic, true);
  assert.ok(
    harness.messages.indexOf(identities[0]) <
      harness.messages.indexOf(harness.published()[0]),
    "the identity is published before the document that shares its listing",
  );

  // The same listing read again says the same thing again: it is an answer about
  // state, not a resource that is spent.
  await harness.fetch(PRIME_LISTING_URL, "application/json", PRIME_LISTING);
  assert.equal(harness.identities().length, 2);
}

// A listing with no usable track still names the episode: the answer about which
// episode this is does not depend on there being subtitles to capture.
{
  const harness = createPageHarness(PRIME_DETAIL);
  await harness.fetch(
    PRIME_LISTING_URL,
    "application/json",
    JSON.stringify({
      catalogMetadata: {
        catalog: { episodeNumber: 4, id: "B0B6GZ954Y", title: "第4話", type: "EPISODE" },
        family: { tvAncestors: [{ catalog: { title: "機動戦士ガンダム 水星の魔女", type: "SHOW" } }] },
      },
      forcedNarrativeUrls: [{ languageCode: "ja", url: "https://aiv-cdn.net/forced.ttml" }],
    }),
  );
  assert.equal(
    harness.published().length,
    0,
    "nothing is captured from a forced-narrative listing",
  );
  assert.equal(harness.identities().length, 1);
  assert.equal(harness.identities()[0].payload.showName, "機動戦士ガンダム 水星の魔女");
  assert.equal(harness.identities()[0].payload.episodeNumber, 4);
}

// A listing LST cannot read names nothing, and says so rather than publishing a
// half-identity.
{
  const harness = createPageHarness(PRIME_DETAIL);
  await harness.fetch(
    PRIME_LISTING_URL,
    "application/json",
    JSON.stringify({ subtitleUrls: [{ languageCode: "ja", url: PRIME_JA_URL }] }),
  );
  const identities = harness.identities();
  assert.equal(identities.length, 1);
  assert.equal(identities[0].payload.reason, "no-catalog-metadata");
  assert.equal(identities[0].payload.videoId, "");
  assert.equal(identities[0].payload.showName, "");
  assert.equal(identities[0].payload.episodic, false);
}

// Netflix has no listing, so no identity is read there, and a page that is not a
// player publishes none either.
{
  const netflix = createPageHarness("https://www.netflix.com/watch/80100172");
  await netflix.fetch(PRIME_LISTING_URL, "application/json", PRIME_LISTING);
  assert.equal(netflix.identities().length, 0);

  const storefront = createPageHarness("https://www.amazon.co.jp/gp/video/storefront");
  await storefront.fetch(PRIME_LISTING_URL, "application/json", PRIME_LISTING);
  assert.equal(storefront.identities().length, 0);
}

// The identity travels over XHR too, because that is how the listing arrives on
// some builds.
{
  const harness = createPageHarness(PRIME_DETAIL);
  harness.serve(PRIME_JA_URL, PRIME_TTML);
  harness.serve(PRIME_EN_URL, PRIME_TTML);
  await harness.xhr(PRIME_LISTING_URL, "application/json", PRIME_LISTING);
  assert.equal(harness.identities().length, 1);
  assert.equal(harness.identities()[0].payload.videoId, PRIME_EPISODE_ID);
  assert.equal(harness.published().length, 1);
}

// The same listing again — a quality change, a resume, an ad break — must not
// fetch and hand over the same track twice.
{
  const harness = createPageHarness(PRIME_DETAIL);
  harness.serve(PRIME_JA_URL, PRIME_TTML);
  harness.serve(PRIME_EN_URL, PRIME_TTML);
  await harness.fetch(PRIME_LISTING_URL, "application/json", PRIME_LISTING);
  await harness.fetch(PRIME_LISTING_URL, "application/json", PRIME_LISTING);
  assert.equal(harness.published().length, 1, "the same track is captured once");
}

// Fetching a whole episode's document takes as long as it takes, and none of
// that time is taken from the player: the request that led to the listing comes
// back first, and the track arrives when it arrives.
{
  const harness = createPageHarness(PRIME_DETAIL);
  harness.serveSlowly(PRIME_JA_URL, PRIME_TTML);
  harness.serve(PRIME_EN_URL, PRIME_TTML);
  await harness.fetch(PRIME_LISTING_URL, "application/json", PRIME_LISTING);
  assert.equal(
    harness.published().length,
    0,
    "the player's own request must not wait for LST's fetch of the track",
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(harness.published().length, 1, "the track is published once it arrives");
  assert.equal(harness.published()[0].payload.url, PRIME_JA_URL);
}

// A listing with no Japanese track is still usable: the first subtitle track is
// captured, and the reason says which rule decided.
{
  const harness = createPageHarness(PRIME_DETAIL);
  harness.serve(PRIME_EN_URL, PRIME_TTML);
  await harness.fetch(
    PRIME_LISTING_URL,
    "application/json",
    JSON.stringify({ subtitleUrls: [{ languageCode: "en", url: PRIME_EN_URL }] }),
  );
  const published = harness.published();
  assert.equal(published.length, 1);
  assert.equal(published[0].payload.url, PRIME_EN_URL);
  assert.equal(published[0].payload.reason, "first-listed-track");
}

// Forced narrative is not the episode's dialogue, so a listing holding nothing
// else leaves LST waiting rather than showing signs and songs as subtitles.
{
  const harness = createPageHarness(PRIME_DETAIL);
  await harness.fetch(
    PRIME_LISTING_URL,
    "application/json",
    JSON.stringify({
      forcedNarrativeUrls: [{ languageCode: "ja", url: "https://aiv-cdn.net/forced.ttml" }],
    }),
  );
  assert.equal(harness.published().length, 0);
  const note = harness
    .notes()
    .find((entry) => entry.payload.event === "playback-resources-no-track");
  assert.ok(note, "a listing with no usable track says so");
  assert.equal(note.payload.reason, "only-forced-narrative-track");
  assert.equal(note.payload.trackCount, 1);
}

// The listing arrives over XHR on some builds, so the same reading happens there.
{
  const harness = createPageHarness(PRIME_DETAIL);
  harness.serve(PRIME_JA_URL, PRIME_TTML);
  harness.serve(PRIME_EN_URL, PRIME_TTML);
  await harness.xhr(PRIME_LISTING_URL, "application/json", PRIME_LISTING);
  const published = harness.published();
  assert.equal(published.length, 1);
  assert.equal(published[0].payload.url, PRIME_JA_URL);
  assert.equal(published[0].payload.site, "primevideo");
}

// Nothing about a listing is read on a page that is not playing, and Netflix —
// which has no such listing — never treats one as timed text.
{
  const storefront = createPageHarness("https://www.amazon.co.jp/gp/video/storefront");
  storefront.serve(PRIME_JA_URL, PRIME_TTML);
  await storefront.fetch(PRIME_LISTING_URL, "application/json", PRIME_LISTING);
  assert.equal(storefront.published().length, 0);
  assert.equal(storefront.notes().length, 0);

  const netflix = createPageHarness("https://www.netflix.com/watch/80100172");
  await netflix.fetch(PRIME_LISTING_URL, "application/json", PRIME_LISTING);
  assert.equal(netflix.published().length, 0);
}

// Navigating between services on the same tab re-detects per response, so a
// route change is never served by the previous service's rules.
{
  const harness = createPageHarness("https://www.netflix.com/browse");
  await harness.fetch("https://www.netflix.com/subtitle.vtt", "text/vtt", VTT);
  assert.equal(harness.published().length, 0);
  await harness.goTo("https://www.amazon.co.jp/-/en/gp/video/detail/B0B6GZ954Y");
  await harness.fetch("https://aiv-cdn.net/ttml/B0B6GZ954Y.ttml", "text/xml", PRIME_TTML);
  assert.equal(harness.published().length, 1);
  assert.equal(harness.published()[0].payload.site, "primevideo");
  await harness.goTo("https://www.netflix.com/watch/80100172");
  await harness.fetch("https://www.netflix.com/subtitle.vtt", "text/vtt", VTT);
  assert.equal(harness.published().length, 2);
  assert.equal(harness.published()[1].payload.site, "netflix");
}

// --- Section 2: which pages content.js stays idle on -------------------------

function createElementStub(tagName) {
  const node = {
    tagName: String(tagName).toUpperCase(),
    children: [],
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    isConnected: true,
    hidden: false,
    textContent: "",
    innerText: "",
    id: "",
    set innerHTML(value) { this._html = value; },
    get innerHTML() { return this._html || ""; },
    appendChild(child) { this.children.push(child); return child; },
    append(...children) { for (const child of children) this.appendChild(child); },
    prepend(child) { this.children.unshift(child); return child; },
    replaceChildren(...children) { this.children = children; },
    remove() {},
    setAttribute() {},
    removeAttribute() {},
    getAttribute() { return null; },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    scrollIntoView() {},
    matches() { return false; },
    closest() { return null; },
    contains() { return false; },
    querySelector() { return createElementStub("div"); },
    querySelectorAll() { return []; },
    cloneNode() { return createElementStub(tagName); },
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  };
  return node;
}

function createContentHarness(href, { player = false } = {}) {
  // The player can appear after the page is created, which is exactly the
  // state a capture can beat: Prime starts playing on its own, and LST notices.
  let playerPresent = player;
  let storageReads = 0;
  let domCalls = 0;
  const intervals = [];
  // A started player: metadata loaded and a duration known.
  const videoElement = {
    currentTime: 0,
    paused: true,
    duration: 1500,
    readyState: 4,
    isConnected: true,
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect() {
      return { width: 1920, height: 1080, top: 0, left: 0, bottom: 1080, right: 1920 };
    },
  };
  const playerContainer = { id: "" };
  const document = {
    title: "",
    documentElement: createElementStub("html"),
    body: createElementStub("body"),
    head: createElementStub("head"),
    fullscreenElement: null,
    createElement: (tagName) => createElementStub(tagName),
    createDocumentFragment: () => createElementStub("#fragment"),
    addEventListener() {},
    removeEventListener() {},
    querySelector(selector) {
      domCalls++;
      if (selector === "video") return playerPresent ? videoElement : null;
      if (selector === ".atvwebplayersdk-player-container") {
        return playerPresent ? playerContainer : null;
      }
      return null;
    },
    querySelectorAll(selector) {
      domCalls++;
      if (selector === "video") return playerPresent ? [videoElement] : [];
      return [];
    },
  };
  class MutationObserverStub {
    observe() {}
    disconnect() {}
  }
  const sentMessages = [];
  const windowListeners = new Map();
  const context = vm.createContext({
    document,
    location: locationFor(href),
    performance,
    console: { log() {}, info() {}, warn() {}, error() {} },
    URL,
    setTimeout,
    clearTimeout,
    setInterval(callback) { intervals.push(callback); return intervals.length; },
    clearInterval() {},
    requestAnimationFrame() { return 1; },
    cancelAnimationFrame() {},
    MutationObserver: MutationObserverStub,
    Node: { ELEMENT_NODE: 1 },
    DOMParser: class {},
    fetch: async () => ({ ok: false, status: 404, async text() { return ""; } }),
    browser: {
      runtime: {
        onMessage: { addListener() {} },
        getManifest() { return { version: "0.0.0-test" }; },
        async sendMessage(message) {
          storageReads++;
          sentMessages.push(message);
          return { ok: true, settings: {} };
        },
      },
      storage: { local: { async get() { return {}; }, async set() {} } },
    },
  });
  context.addEventListener = (type, handler) => {
    const handlers = windowListeners.get(type) || [];
    handlers.push(handler);
    windowListeners.set(type, handlers);
  };
  vm.runInContext("globalThis.window = globalThis", context);
  const windowRef = vm.runInContext("globalThis", context);
  vm.runInContext(playbackSiteSource, context, { filename: "playback-site.js" });
  vm.runInContext(identitySource, context, { filename: "episode-identity.js" });
  vm.runInContext(translationContextSource, context, { filename: "translation-context.js" });
  vm.runInContext(contentSource, context, { filename: "content.js" });

  return {
    domCalls: () => domCalls,
    drawnElements: () => document.documentElement.children.length,
    storageReads: () => storageReads,
    route: () => intervals[0](),
    setPlayer(value) { playerPresent = value; },
    sent: () => sentMessages,
    // A message the page world posted, delivered to the content script the way
    // the browser would: same window, the hook's own source tag.
    deliver(payload, type = "SUBTITLE_DOCUMENT") {
      for (const handler of windowListeners.get("message") || []) {
        handler({
          source: windowRef,
          data: { source: "lst-local-subtitle-translate", type, payload },
        });
      }
    },
  };
}

const idlePages = [
  "https://www.netflix.com/browse",
  "https://www.netflix.com/search?q=x",
  "https://www.netflix.com/title/80100172",
  "https://www.amazon.co.jp/dp/B0B6GZ954Y",
  "https://www.amazon.co.jp/-/en/gp/video/storefront",
  "https://www.primevideo.com/",
];

for (const href of idlePages) {
  const harness = createContentHarness(href);
  await harness.route();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    harness.storageReads(),
    0,
    `${href}: a page that cannot play must not read settings`,
  );
  assert.equal(harness.domCalls(), 0, `${href}: a page that cannot play must stay off the DOM`);
}

// A supported playback page does ask for settings — and then draws nothing at
// all, because a Prime Video detail page is a storefront with a trailer on it
// until its player is mounted and in use.
{
  const harness = createContentHarness(
    "https://www.amazon.co.jp/-/en/gp/video/detail/B0B6GZ954Y",
  );
  await harness.route();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(harness.storageReads() >= 1, "a playback page is where settings are first read");
  assert.equal(
    harness.drawnElements(),
    0,
    "a Prime Video detail page with no player must stay completely untouched",
  );
}

// With a player mounted and in use, Prime Video is a page LST serves: the
// overlay and the control pill appear.
{
  const harness = createContentHarness(
    "https://www.amazon.co.jp/-/en/gp/video/detail/B0B6GZ954Y",
    { player: true },
  );
  await harness.route();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(harness.storageReads() >= 1);
  assert.ok(
    harness.drawnElements() > 0,
    "a playing Prime Video episode must get LST's overlay and controls",
  );
}

// Prime's player asks for its resources the moment it starts, and LST notices a
// player on its next pass — so a whole track can be captured before LST is
// serving the page. It is held and adopted then rather than dropped, because the
// request that carried it is not repeated on demand.
{
  const captured = [
    "WEBVTT",
    "",
    "00:00:01.000 --> 00:00:03.000",
    "こんにちは。",
    "",
    "00:00:04.000 --> 00:00:06.000",
    "お元気ですか。",
  ].join("\n");

  const harness = createContentHarness(
    "https://www.amazon.co.jp/-/en/gp/video/detail/B0B6GZ954Y",
  );
  harness.deliver({
    url: "https://aiv-cdn.net/ttml/B0B6GZ954Y.ja.ttml",
    text: captured,
    site: "primevideo",
    capture: "playback-resources",
    language: "ja",
    reason: "preferred-language:ja",
  });
  await harness.route();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(
    !harness.sent().some((message) => message.type === "CACHE_RECONCILE_FALLBACK"),
    "a track captured on a page with nothing playing is not adopted",
  );

  harness.setPlayer(true);
  await harness.route();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const reconciled = harness
    .sent()
    .find((message) => message.type === "CACHE_RECONCILE_FALLBACK");
  assert.ok(reconciled, "the held track is adopted as soon as playback starts");
  assert.equal(reconciled.timedCues.length, 2, "every cue of the held document arrives");
  assert.equal(reconciled.timedCues[0].sourceText, "こんにちは。");
  assert.equal(reconciled.cacheId.includes("primevideo"), true);
  assert.equal(reconciled.metadata.siteId, "primevideo");
}

// A document from another service is refused, whether it arrives while the page
// is being served or is held for later.
{
  const harness = createContentHarness(
    "https://www.netflix.com/watch/80100172",
    { player: true },
  );
  harness.deliver({
    url: "https://aiv-cdn.net/ttml/B0B6GZ954Y.ja.ttml",
    text: "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nこんにちは。",
    site: "primevideo",
  });
  await harness.route();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(
    !harness.sent().some((message) => message.type === "CACHE_RECONCILE_FALLBACK"),
    "a Prime Video track is never adopted by a Netflix page",
  );
}

console.log("Page hook capture and route checks passed.");
