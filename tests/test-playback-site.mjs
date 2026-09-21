import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { repositoryPath } from "./helpers/repository-path.mjs";

// Layer 1 — the adapter on its own. Everything here is pure: a location, a
// document, a url in, records out.

const read = (name) => fs.readFile(new URL(repositoryPath(name), import.meta.url), "utf8");
const playbackSiteSource = await read("playback-site.js");
const netflixSiteSource = await read("netflix.js");
const primeVideoSiteSource = await read("prime-video.js");

const context = vm.createContext({});
vm.runInContext(playbackSiteSource, context, { filename: "playback-site.js" });
vm.runInContext(netflixSiteSource, context, { filename: "netflix.js" });
vm.runInContext(primeVideoSiteSource, context, { filename: "prime-video.js" });
const site = context.LSTPlaybackSite;

assert.deepEqual([...site.SITE_IDS], ["netflix", "primevideo"]);

// Registration is the only extension point for another service. It validates
// the common contract immediately, before a malformed adapter can reach the
// page hook or player runtime.
{
  const registryContext = vm.createContext({});
  vm.runInContext(playbackSiteSource, registryContext, {
    filename: "playback-site.js",
  });
  vm.runInContext(netflixSiteSource, registryContext, { filename: "netflix.js" });
  vm.runInContext(primeVideoSiteSource, registryContext, {
    filename: "prime-video.js",
  });
  const registry = registryContext.LSTPlaybackSite;
  const method = () => ({});
  const adapter = {
    id: "example",
    label: "Example",
    matchPatterns: ["https://video.example/*"],
    isPlaybackPage: method,
    videoIdFrom: method,
    activeVideo: method,
    playerPresence: method,
    renderedSubtitleLines: method,
    titleElements: method,
    cleanPageTitle: method,
    nativeCaptionSelectors: [],
    titleSelectors: {},
    timedText: { capture: "example", urlPatterns: [], contentTypes: [] },
  };
  assert.equal(registry.registerSite(adapter).id, "example");
  assert.equal(registry.siteFor("example").label, "Example");
  assert.throws(() => registry.registerSite(adapter), /already registered/);
  assert.throws(
    () => registry.registerSite({ ...adapter, id: "broken", activeVideo: null }),
    /missing activeVideo/,
  );
  assert.throws(
    () => registry.registerSite({
      ...adapter,
      id: "overlap",
      matchPatterns: ["https://www.netflix.com/*"],
    }),
    /both claim/,
  );
}

// --- Host detection ---------------------------------------------------------

const detection = [
  // [url, expected site id, reason]
  ["https://www.netflix.com/watch/80100172", "netflix", "site-detected"],
  [
    "https://www.amazon.co.jp/-/en/gp/video/detail/B0B6GZ954Y",
    "primevideo",
    "site-detected",
  ],
  [
    "https://www.amazon.co.jp/gp/video/detail/B0B6GZ954Y?ref_=atv_dp_share",
    "primevideo",
    "site-detected",
  ],
  [
    "https://www.amazon.co.jp/-/ja/gp/video/detail/amzn1.dv.gti.3a1b2c3d",
    "primevideo",
    "site-detected",
  ],
  ["https://www.amazon.com/gp/video/watch/B0B6GZ954Y", "primevideo", "site-detected"],
  ["https://www.primevideo.com/detail/0ABCDEFGHIJK", "primevideo", "site-detected"],
  // Not Netflix, not Amazon, and not primevideo.com.
  ["https://www.netflix.example.com/watch/1", "", "site-unsupported"],
  ["https://www.amazon.de/gp/video/detail/B0B6GZ954Y", "", "site-unsupported"],
  ["https://www.netflix.com.evil.example/watch/1", "", "site-unsupported"],
  ["https://atv-ps.amazon.com/cdp/catalog/GetPlaybackResources", "", "site-unsupported"],
];

for (const [url, expectedId, expectedReason] of detection) {
  const result = site.detect({ href: url });
  assert.equal(result.siteId, expectedId, `${url} should resolve to ${expectedId}`);
  assert.equal(result.reason, expectedReason, `${url} reason`);
  assert.equal(result.site?.id || "", expectedId, `${url} adapter`);
}

// A malformed location never resolves to a service, because an unknown page is
// not a page LST may run on.
assert.equal(site.detect({}).reason, "location-unavailable");
assert.equal(site.detect(null).site, null);
assert.equal(site.detect({ href: "not a url" }).reason, "site-unsupported");

// The matched pattern is reported, so a marketplace added to the adapter can be
// traced to the rule that admitted it.
assert.equal(
  site.detect({ href: "https://www.amazon.co.jp/-/en/gp/video/detail/B0B6GZ954Y" })
    .matchPattern,
  "https://www.amazon.co.jp/*",
);

// --- Playback pages ---------------------------------------------------------

const playbackPages = [
  // [site id, pathname, ok]
  ["netflix", "/watch/80100172", true],
  ["netflix", "/watch/80100172/title", true],
  ["netflix", "/browse", false],
  ["netflix", "/search", false],
  ["netflix", "/title/80100172", false],
  // The Japan detail page keeps the id in the path, in both locale forms.
  ["primevideo", "/-/en/gp/video/detail/B0B6GZ954Y", true],
  ["primevideo", "/-/ja/gp/video/detail/B0B6GZ954Y", true],
  ["primevideo", "/gp/video/detail/B0B6GZ954Y", true],
  ["primevideo", "/gp/video/watch/B0B6GZ954Y", true],
  ["primevideo", "/detail/0ABCDEFGHIJK", true],
  // A browse page is not a playback page, which is what keeps LST idle there.
  ["primevideo", "/", false],
  ["primevideo", "/dp/B0B6GZ954Y", false],
  ["primevideo", "/gp/video/storefront", false],
  ["primevideo", "/-/en/gp/video/storefront", false],
];

for (const [siteId, pathname, ok] of playbackPages) {
  const result = site.SITES[siteId].isPlaybackPage({ pathname, search: "", host: "" });
  assert.equal(result.ok, ok, `${siteId} ${pathname}`);
  assert.ok(result.reason, `${siteId} ${pathname} must carry a reason`);
}

// --- Video ids --------------------------------------------------------------

const videoIds = [
  ["netflix", "/watch/80100172", "80100172"],
  ["netflix", "/browse", ""],
  ["primevideo", "/-/en/gp/video/detail/B0B6GZ954Y", "B0B6GZ954Y"],
  ["primevideo", "/gp/video/detail/B0B6GZ954Y/ref=atv_share", "B0B6GZ954Y"],
  ["primevideo", "/detail/0ABCDEFGHIJK", "0ABCDEFGHIJK"],
  ["primevideo", "/gp/video/detail/amzn1.dv.gti.3a1b2c3d", "amzn1.dv.gti.3a1b2c3d"],
  ["primevideo", "/gp/video/storefront", ""],
];

for (const [siteId, pathname, expected] of videoIds) {
  const result = site.SITES[siteId].videoIdFrom({ pathname, host: "" });
  assert.equal(result.videoId, expected, `${siteId} ${pathname}`);
  assert.ok(result.reason, `${siteId} ${pathname} must carry a reason`);
  if (!expected) assert.equal(result.reason, "video-id-unrecognized");
}

// --- The video element ------------------------------------------------------

function fakeVideo(width, height, extra = {}) {
  return {
    width,
    height,
    getBoundingClientRect() {
      return { width, height, top: 0, left: 0, right: width, bottom: height };
    },
    ...extra,
  };
}

function fakeDocument(videos, containers = []) {
  return {
    querySelectorAll(selector) {
      if (selector === "video") return videos;
      if (selector === ".atvwebplayersdk-captions-text") {
        return containers.filter((entry) => entry.kind === "span");
      }
      return [];
    },
    querySelector(selector) {
      return containers.find((entry) => entry.selector === selector) || null;
    },
  };
}

{
  // Prime renders an ad slot and a preview alongside the real player, and the
  // winner is the largest by area rather than the first in document order.
  const ad = fakeVideo(320, 180);
  const preview = fakeVideo(640, 360);
  const main = fakeVideo(1920, 1080);
  const picked = site.activeVideo(fakeDocument([ad, preview, main]));
  assert.equal(picked.video, main);
  assert.equal(picked.reason, "largest-video-element");
}

{
  const only = fakeVideo(1280, 720);
  const picked = site.activeVideo(fakeDocument([only]));
  assert.equal(picked.video, only);
  assert.equal(picked.reason, "only-video-element");
}

assert.deepEqual(
  JSON.parse(JSON.stringify(site.activeVideo(fakeDocument([])))),
  { video: null, reason: "no-video-element" },
);
assert.equal(site.activeVideo(undefined).reason, "no-video-element");

// --- Is a player actually in use? -------------------------------------------

// A playback path is not the same question as "something is playing". Netflix's
// watch page is the player; Prime Video's detail page is a storefront with a
// trailer on it until the player mounts and starts.
{
  assert.equal(site.SITES.netflix.playerPresence().present, true);
  assert.equal(
    site.SITES.netflix.playerPresence().reason,
    "netflix-watch-page-is-the-player",
  );

  const noContainer = site.SITES.primevideo.playerPresence(fakeDocument([]));
  assert.equal(noContainer.present, false);
  assert.equal(noContainer.reason, "prime-player-container-absent");

  const withContainer = (video) => ({
    querySelector(selector) {
      return selector === ".atvwebplayersdk-player-container" ? { id: "p" } : null;
    },
    querySelectorAll(selector) {
      return selector === "video" ? [video] : [];
    },
  });

  const dormant = site.SITES.primevideo.playerPresence(
    withContainer({ readyState: 0, currentTime: 0, duration: NaN }),
  );
  assert.equal(dormant.present, false, "a container with a dormant video is not playing");
  assert.match(dormant.reason, /^prime-player-not-in-use/);

  const started = site.SITES.primevideo.playerPresence(
    withContainer({ readyState: 4, currentTime: 0, duration: 1500 }),
  );
  assert.equal(started.present, true);
  assert.equal(started.reason, "prime-player-in-use");

  const seeking = site.SITES.primevideo.playerPresence(
    withContainer({ readyState: 1, currentTime: 12.5, duration: 1500 }),
  );
  assert.equal(seeking.present, true);

  assert.equal(site.videoHasStarted(null), false);
  assert.equal(site.videoHasStarted({}), false);
assert.equal(site.videoHasStarted({ readyState: 1 }), true);
}

// Prime exposes the service-provided episode name in the player heading. The
// adapter owns both the private selector and the complete text, including its
// leading list number and Japanese episode wording.
{
  const heading = { id: "episode-heading" };
  const document = {
    querySelectorAll(selector) {
      return selector === "h3.hGJxLu" ? [heading] : [];
    },
  };
  const prime = site.SITES.primevideo;
  assert.ok(
    prime.titleSelectors.episode.includes(
      "h3.hGJxLu > span._36qUej.hGJxLu",
    ),
  );
  assert.deepEqual([...prime.titleElements(document).elements], [heading]);
}

// --- How a service renders a subtitle line ----------------------------------

{
  // Netflix puts a whole cue in one timed-text container.
  const container = {
    selector: ".player-timedtext",
    innerText: "First line\nSecond line",
  };
  const result = site.SITES.netflix.renderedSubtitleLines(fakeDocument([], [container]));
  assert.equal(result.text, "First line\nSecond line");
  assert.deepEqual([...result.lines], ["First line", "Second line"]);
  assert.ok(result.reason);
  assert.equal(
    site.SITES.netflix.renderedSubtitleLines(fakeDocument([])).reason,
    "no-caption-container",
  );
}

{
  // Prime renders one span per line and reuses them, so the lines are read one
  // span at a time and joined — never from the container, which also holds
  // player chrome and control SVGs.
  const first = { kind: "span", innerText: "彼は行く" };
  const second = { kind: "span", innerText: "しかし雨だ" };
  const result = site.SITES.primevideo.renderedSubtitleLines(
    fakeDocument([], [first, second]),
  );
  assert.equal(result.text, "彼は行く\nしかし雨だ");
  assert.deepEqual([...result.lines], ["彼は行く", "しかし雨だ"]);
  assert.equal(result.source, "prime-caption-spans");

  // Between cues the spans exist but carry nothing, which is the same "no line"
  // state Netflix reports.
  first.innerText = "";
  second.innerText = "";
  const between = site.SITES.primevideo.renderedSubtitleLines(
    fakeDocument([], [first, second]),
  );
  assert.equal(between.text, "");
  assert.deepEqual([...between.lines], []);
  assert.equal(between.reason, "captions-empty");

  // No spans at all is reported as such, and never as the container's text.
  const titleContainer = {
    kind: "container",
    innerText: "Some Show · 12:34",
  };
  const none = site.SITES.primevideo.renderedSubtitleLines(
    fakeDocument([], [titleContainer]),
  );
  assert.equal(none.text, "", "a container read would harvest player chrome");
  assert.equal(none.reason, "no-caption-spans");
}

// A Prime cue written in place reads as the new line, and the span count stays 1.
{
  const span = { kind: "span", innerText: "「おはよう」" };
  const document = fakeDocument([], [span]);
  assert.equal(site.SITES.primevideo.renderedSubtitleLines(document).text, "「おはよう」");
  span.innerText = "「おやすみ」";
  assert.equal(site.SITES.primevideo.renderedSubtitleLines(document).text, "「おやすみ」");
  assert.equal(site.SITES.primevideo.renderedSubtitleLines(document).lines.length, 1);
}

// --- Prime's playback-resources listing --------------------------------------

// The listing the player asks for before it plays anything. It is read as data
// by the adapter, and the page world does the fetching, so nothing here touches
// the network.
const primeResources = site.SITES.primevideo.playbackResources;
assert.ok(primeResources, "the Prime adapter must own the listing it reads");

{
  // The envelope the player's own plan document uses. A forced-narrative track
  // is listed beside the subtitle tracks and is never mistaken for one.
  const tracks = primeResources.tracks({
    timedTextUrls: {
      result: {
        subtitleUrls: [
          { languageCode: "en", displayName: "English", url: "https://aiv-cdn.net/en.ttml" },
          { languageCode: "ja", displayName: "日本語", url: "https://aiv-cdn.net/ja.ttml" },
        ],
        forcedNarrativeUrls: [
          { languageCode: "ja", displayName: "日本語", url: "https://aiv-cdn.net/ja-forced.ttml" },
        ],
      },
    },
  });
  assert.equal(tracks.length, 3);
  assert.deepEqual(
    [...tracks.map((track) => track.languageCode)],
    ["en", "ja", "ja"],
  );
  assert.equal(tracks[0].forced, false);
  assert.equal(tracks[2].forced, true);
  assert.equal(tracks[2].kind, "forced-narrative");
  assert.equal(tracks[1].language, "日本語");

  // Japanese wins even though it is not the first track listed, and the answer
  // says which rule decided.
  const choice = primeResources.chooseTrack(tracks);
  assert.equal(choice.track.url, "https://aiv-cdn.net/ja.ttml");
  assert.equal(choice.reason, "preferred-language:ja");

  // A listing with no Japanese track is still usable: the first subtitle track
  // is captured rather than nothing.
  const englishOnly = primeResources.tracks({
    subtitleUrls: [
      { languageCode: "en", url: "https://x/en.ttml" },
      { languageCode: "de", url: "https://x/de.ttml" },
    ],
  });
  const fallback = primeResources.chooseTrack(englishOnly);
  assert.equal(fallback.track.url, "https://x/en.ttml");
  assert.equal(fallback.reason, "first-listed-track");

  // A listing of nothing but forced narrative is refused: signs and songs shown
  // as though they were the whole episode would be worse than waiting.
  const forcedOnly = primeResources.chooseTrack(
    primeResources.tracks({
      forcedNarrativeUrls: [{ languageCode: "en", url: "https://x/forced.ttml" }],
    }),
  );
  assert.equal(forcedOnly.track, null);
  assert.equal(forcedOnly.reason, "only-forced-narrative-track");

  // The delivery document's spelling of the same listing.
  const delivery = primeResources.tracks({
    timedtexttracks: [
      {
        languageCode: "ja",
        displayName: "日本語",
        ttDownloadables: { ttml: { urls: ["https://x/ja.ttml"] } },
      },
    ],
  });
  assert.equal(delivery.length, 1);
  assert.equal(delivery[0].url, "https://x/ja.ttml");
  assert.equal(delivery[0].languageCode, "ja");

  // A bare URL is a track, and an empty entry is not.
  const bare = primeResources.tracks({ subtitleUrls: ["https://x/bare.ttml"] });
  assert.equal(bare.length, 1);
  assert.equal(bare[0].url, "https://x/bare.ttml");
  assert.deepEqual([...primeResources.tracks({ subtitleUrls: [{ languageCode: "ja" }] })], []);

  // A listing that names nothing, and documents that are not listings at all:
  // an answer of "no track" rather than an exception.
  assert.deepEqual([...primeResources.tracks({})], []);
  assert.deepEqual([...primeResources.tracks(null)], []);
  assert.deepEqual([...primeResources.tracks("nope")], []);
  assert.deepEqual([...primeResources.tracks({ timedTextUrls: { result: {} } })], []);
  assert.equal(primeResources.chooseTrack([]).track, null);
  assert.equal(primeResources.chooseTrack([]).reason, "no-timed-text-tracks");
  assert.equal(
    primeResources.chooseTrack([{ languageCode: "ja" }]).reason,
    "no-timed-text-tracks",
    "a track with no URL is not a track",
  );
}

// --- Which episode the listing is about -------------------------------------

// The listing names the item the player is about to play: Amazon's catalog
// entry for the episode, its season, and the series the season belongs to. The
// shape below is a real response — `catalogMetadata.catalog` is the episode
// itself (`id` is its own GTI, `title` the episode's name, `episodeNumber` its
// number), `family.tvAncestors` walks up to the season and then the series, and
// `returnedTitleRendition` repeats the id under the rendition's own names.
{
  const listingIdentity = site.SITES.primevideo.playbackResources.identity;
  assert.equal(typeof listingIdentity, "function", "the adapter must name the episode");

  const episodeListing = {
    catalogMetadata: {
      catalog: {
        entityType: "TV Show",
        episodeNumber: 1,
        id: "amzn1.dv.gti.e4b2f72f-8a6e-405e-44fe-bedba416d622",
        runtimeSeconds: 3321,
        synopsis: "Months after the dramatic events…",
        title: "The Smile",
        type: "EPISODE",
        version: "1.0",
      },
      family: {
        tvAncestors: [
          {
            catalog: {
              id: "amzn1.dv.gti.32b2ec9d-5d43-4fe0-7e4f-c4d5e9a31052",
              seasonNumber: 2,
              title: "Homeland - Season 2",
              type: "SEASON",
              version: "1.0",
            },
            version: "1",
          },
          {
            catalog: {
              id: "amzn1.dv.gti.c8b2d812-7ea7-6b33-ae74-08abb760fe3c",
              title: "Homeland",
              type: "SHOW",
              version: "1.0",
            },
            version: "1",
          },
        ],
        version: "1.0",
      },
      version: "1",
    },
    returnedTitleRendition: {
      asin: "amzn1.dv.gti.e4b2f72f-8a6e-405e-44fe-bedba416d622",
      contentId: "amzn1.dv.vcid.50606e95-747d-4d52-a27f-4143d0317088",
      titleId: "amzn1.dv.gti.e4b2f72f-8a6e-405e-44fe-bedba416d622",
      videoMaterialType: "Feature",
    },
  };

  const episode = listingIdentity(episodeListing);
  assert.equal(episode.reason, "catalog-metadata");
  assert.equal(episode.itemType, "EPISODE");
  assert.equal(episode.title, "The Smile");
  assert.equal(episode.episodic, true);
  assert.equal(episode.episodeNumber, 1);
  assert.equal(episode.seasonNumber, 2, "the season number comes from the season ancestor");
  // The series is the show, spelled the way the service spells it; the season
  // ancestor's own title is only a fallback.
  assert.equal(episode.showName, "Homeland");
  assert.equal(episode.showNameSource, "series-ancestor");
  // The episode's own id, not the season's and not the series': this is what
  // makes the next episode a different episode on a page whose URL never moves.
  assert.equal(episode.videoId, "amzn1.dv.gti.e4b2f72f-8a6e-405e-44fe-bedba416d622");
  assert.equal(episode.videoIdSource, "catalog-id");
  assert.ok(episode.videoId !== episodeListing.catalogMetadata.family.tvAncestors[0].catalog.id);

  // A season whose ancestors stop at the season names the show with the season's
  // own title; naming trims the season out of it, not the adapter.
  const seasonOnly = listingIdentity({
    catalogMetadata: {
      catalog: { episodeNumber: 3, id: "B0B6GZ954Y", title: "第3話", type: "EPISODE" },
      family: { tvAncestors: [{ catalog: { seasonNumber: 1, title: "機動戦士ガンダム 水星の魔女 シーズン1", type: "SEASON" } }] },
    },
  });
  assert.equal(seasonOnly.showName, "機動戦士ガンダム 水星の魔女 シーズン1");
  assert.equal(seasonOnly.showNameSource, "season-ancestor");
  assert.equal(seasonOnly.episodeNumber, 3);
  assert.equal(seasonOnly.seasonNumber, 1);

  // A film is not an episode: the item's own title is the show, and there is no
  // episode to name.
  const movie = listingIdentity({
    catalogMetadata: {
      catalog: { entityType: "Movie", id: "B0B6GZ954Y", title: "Example Film", type: "MOVIE" },
    },
  });
  assert.equal(movie.episodic, false);
  assert.equal(movie.episodeNumber, null);
  assert.equal(movie.showName, "Example Film");
  assert.equal(movie.showNameSource, "item-title");

  // The rendition's id is used when the catalog states none, and the reason says
  // which of the two answered. The id is handed over as it arrived — whether it
  // is an id LST may key a cache on is episode-identity.js's decision.
  const renditionOnly = listingIdentity({
    catalogMetadata: { catalog: { type: "EPISODE", title: "Pilot" } },
    returnedTitleRendition: { asin: "B0B6GZ954Y", titleId: "amzn1.dv.gti.abcdef" },
  });
  assert.equal(renditionOnly.videoId, "amzn1.dv.gti.abcdef");
  assert.equal(renditionOnly.videoIdSource, "rendition-title-id");
  assert.equal(renditionOnly.showName, "", "an episode with no ancestor states no show");

  const asinOnly = listingIdentity({
    catalogMetadata: { catalog: { type: "EPISODE" } },
    returnedTitleRendition: { asin: "B0B6GZ954Y" },
  });
  assert.equal(asinOnly.videoId, "B0B6GZ954Y");
  assert.equal(asinOnly.videoIdSource, "rendition-asin");

  // A listing LST cannot read is reported, never half-read: a document that is
  // not an object, one with no catalog, and one whose catalog is not an object.
  for (const unusable of [null, undefined, "nope", 42, [], {}, { catalogMetadata: {} }, { catalogMetadata: { catalog: "nope" } }]) {
    const answer = listingIdentity(unusable);
    assert.equal(answer.reason, "no-catalog-metadata", `${JSON.stringify(unusable)}`);
    assert.equal(answer.videoId, "");
    assert.equal(answer.showName, "");
    assert.equal(answer.episodic, false);
    assert.equal(answer.episodeNumber, null);
  }

  // The flatter spelling of the same answer, which is what the listing's own
  // inner object looks like when it arrives without its envelope.
  const flat = listingIdentity({ catalog: { id: "B0B6GZ954Y", title: "Example Film", type: "MOVIE" } });
  assert.equal(flat.reason, "catalog-metadata");
  assert.equal(flat.catalogSource, "catalog");
  assert.equal(flat.showName, "Example Film");
}

// The listing is a fact about the service that has one, and Netflix is not it.
assert.equal(site.SITES.netflix.playbackResources, undefined);
// The adapter's word for how Prime captures is what the interface explains.
assert.equal(site.SITES.primevideo.timedText.capture, "playback-resources");
assert.ok(
  site.SITES.primevideo.timedText.urlPatterns.every(
    (pattern) => !/GetPlaybackResources/.test(pattern),
  ),
  "the listing is not a subtitle document and must not be matched as one",
);

// --- Page titles ------------------------------------------------------------

// Amazon words its document title per marketplace and per locale; only the
// service's own boilerplate is removed, never part of a show's name.
const pageTitles = [
  [
    "primevideo",
    "Amazon.co.jp: Example Show : Prime Video",
    "Example Show",
  ],
  [
    "primevideo",
    "Amazon.co.jp：Example Showを視聴 | Prime Video",
    "Example Show",
  ],
  [
    "primevideo",
    "Watch Example Show - Prime Video",
    "Example Show",
  ],
  [
    "primevideo",
    "Amazon.co.jp: Example Show - Season 1 : Prime Video",
    "Example Show - Season 1",
  ],
  [
    "netflix",
    "Watch Example Show | Netflix Official Site",
    "Example Show",
  ],
  ["netflix", "Watch Example Show | Netflix", "Example Show"],
  // A name the service did not wrap in boilerplate is left alone.
  ["netflix", "Example Show", "Example Show"],
  ["primevideo", "Example Show", "Example Show"],
];

for (const [siteId, value, expected] of pageTitles) {
  assert.equal(
    site.SITES[siteId].cleanPageTitle(value),
    expected,
    `${siteId}: ${value}`,
  );
}
assert.equal(site.SITES.primevideo.cleanPageTitle(""), "");
assert.equal(site.SITES.primevideo.cleanPageTitle(null), "");

// --- Support, as the interface is told it -----------------------------------

const support = site.describeSupport();
assert.equal(support.length, 2);
for (const entry of support) {
  assert.ok(entry.id);
  assert.ok(entry.label);
  assert.ok(entry.hosts.length);
  assert.ok(entry.homeUrl.startsWith("https://"));
  assert.ok(entry.nativeCaptionSelector.includes("lst-hide-native-subtitles"));
  assert.ok(entry.hudPosition);
  assert.ok(entry.timedTextCapture);
  assert.ok(entry.timedTextReason);
}
assert.equal(site.labelFor("primevideo"), "Prime Video");
assert.equal(site.labelFor("netflix"), "Netflix");
assert.equal(site.labelFor("unknown"), "");

// --- No page text ever leaves in a report -----------------------------------

// Every reason an adapter reports while reading a page is compared against the
// page's own text. The caption itself is the *answer* to "what is on screen" and
// is returned on purpose; what must never carry it is the report around it,
// because that is what the event log stores.
{
  const caption = "これは秘密の字幕です";
  const title = "Secret Show Title";
  const document = fakeDocument(
    [fakeVideo(1920, 1080)],
    [{ kind: "span", innerText: caption }],
  );
  const reports = [];
  for (const siteId of site.SITE_IDS) {
    const adapter = site.SITES[siteId];
    const lines = adapter.renderedSubtitleLines(document);
    reports.push({
      reason: lines.reason,
      source: lines.source,
      lineCount: lines.lines.length,
      textLength: lines.text.length,
    });
    const titles = adapter.titleElements(document);
    reports.push({ reason: titles.reason, elementCount: titles.elements.length });
    reports.push(adapter.isPlaybackPage({ pathname: "/", search: "", host: "" }));
    reports.push(adapter.videoIdFrom({ pathname: "/", host: "" }));
    reports.push({ cleanedTitleLength: adapter.cleanPageTitle(title).length });
  }
  const serialized = JSON.stringify(reports);
  assert.ok(!serialized.includes(caption), "a report contained caption text");
  assert.ok(!serialized.includes(title), "a report contained a title");
  // The observation itself is still there, measured and not quoted.
  assert.ok(
    reports.some((report) => report.textLength === caption.length),
    "the adapter must actually report what it saw",
  );
}

// --- Drift guards: the adapter and everything that names it ------------------

const manifest = JSON.parse(await read("manifest.json"));
const prepareBrowser = await read("scripts/prepare-browser.mjs");
const verifyPackage = await read("scripts/verify-package.mjs");
const packageJson = await read("package.json");
const styles = await read("styles.css");
const optionsHtml = await read("options.html");
const optionsJs = await read("options.js");
const setupHtml = await read("setup.html");
const setupJs = await read("setup.js");
const readme = await read("README.md");
const contentSource = await read("content.js");
const pageHookSource = await read("page-hook.js");
const backgroundSource = await read("background.js");

// Runtime consumers ask the adapter; they do not recognize a service from its
// hostname or private DOM vocabulary themselves.
for (const [name, source] of [
  ["content.js", contentSource],
  ["page-hook.js", pageHookSource],
  ["background.js", backgroundSource],
]) {
  assert.doesNotMatch(
    source,
    /www\.netflix\.com|www\.amazon\.co|www\.amazon\.com|primevideo\.com|data-uia|atvwebplayersdk/,
    `${name} contains a site-specific host or selector`,
  );
}

// The host list lives twice: once in the adapter, once in the manifest. A
// marketplace added to only one of them fails here, naming the pattern.
const adapterPatterns = new Set(
  site.SITE_IDS.flatMap((siteId) => site.SITES[siteId].matchPatterns),
);
const contentScriptMatches = new Set();
for (const entry of manifest.content_scripts) {
  for (const pattern of entry.matches) contentScriptMatches.add(pattern);
}

for (const pattern of adapterPatterns) {
  assert.ok(
    contentScriptMatches.has(pattern),
    `manifest.json content_scripts is missing ${pattern} — add it to both matches arrays`,
  );
}
for (const pattern of contentScriptMatches) {
  assert.ok(
    adapterPatterns.has(pattern),
    `manifest.json matches ${pattern}, which no adapter claims`,
  );
}

// Both worlds get the adapter, and the isolated world gets it before content.js.
assert.equal(manifest.content_scripts.length, 2);
const siteModules = [
  "sites/playback-site.js",
  "sites/netflix.js",
  "sites/prime-video.js",
];
for (const entry of manifest.content_scripts) {
  for (const module of siteModules) {
    assert.ok(entry.js.includes(module), `a content script entry is missing ${module}`);
  }
  const reader = entry.js.includes("content/index.js")
    ? "content/index.js"
    : "page/page-hook.js";
  for (const module of siteModules) {
    assert.ok(
      entry.js.indexOf(module) < entry.js.indexOf(reader),
      `${module} must load before ${reader}`,
    );
  }
}
const isolatedScripts = manifest.content_scripts.find((entry) =>
  entry.js.includes("content/index.js"),
)?.js || [];
assert.ok(isolatedScripts.includes("content/capture-bridge.js"));
assert.ok(isolatedScripts.includes("shared/playback-policy.js"));
assert.ok(
  isolatedScripts.indexOf("content/capture-bridge.js") < isolatedScripts.indexOf("content/index.js"),
  "capture-bridge.js must listen before content.js initializes",
);
assert.ok(
  isolatedScripts.indexOf("shared/playback-policy.js") < isolatedScripts.indexOf("content/index.js"),
  "playback-policy.js must load before content.js",
);
for (const module of siteModules) {
  assert.ok(manifest.background.scripts.includes(module));
  assert.ok(
    manifest.background.scripts.indexOf(module) <
      manifest.background.scripts.indexOf("background/index.js"),
    `${module} must load before background.js`,
  );
}
assert.match(
  readme,
  /Prime Video/,
  "the README must name both services the extension supports",
);

// Every way the adapter says it finds a track has a sentence in the settings and
// setup pages, so a service cannot arrive at a new capture and be described to
// the viewer as something else.
for (const siteId of site.SITE_IDS) {
  const captureWord = site.SITES[siteId].timedText.capture;
  for (const [name, source] of [["options.js", optionsJs], ["setup.js", setupJs]]) {
    assert.ok(
      source.includes(`"${captureWord}"`) || source.includes(`${captureWord}:`),
      `${name} does not explain the capture the adapter declares: ${captureWord}`,
    );
  }
}

// Packaging copies the source tree and verifies the adapter entry explicitly.
assert.match(prepareBrowser, /readdir\("src"\)/);
assert.match(verifyPackage, /"sites\/playback-site\.js"/);
assert.match(verifyPackage, /"sites\/netflix\.js"/);
assert.match(verifyPackage, /"sites\/prime-video\.js"/);
assert.match(
  packageJson,
  /node scripts\/check-syntax\.mjs/,
  "the syntax check does not cover the module",
);

// One shared hide class, one rule per service, and every selector the adapter
// claims is actually hidden. A selector named by the adapter but missing here
// would leave a viewer's native captions visible.
assert.equal(site.NATIVE_SUBTITLE_CLASS, "lst-hide-native-subtitles");
assert.ok(
  contentSource.includes(`"${site.NATIVE_SUBTITLE_CLASS}"`),
  "content.js does not toggle the class the stylesheet hides captions with",
);
for (const siteId of site.SITE_IDS) {
  for (const selector of site.SITES[siteId].nativeCaptionSelectors) {
    assert.ok(
      styles.includes(`html.${site.NATIVE_SUBTITLE_CLASS} ${selector}`),
      `styles.css does not hide ${selector}`,
    );
  }
  // The scoped selector is derived from that list, so the two cannot disagree.
  const expected = site.SITES[siteId].nativeCaptionSelectors
    .map((selector) => `html.${site.NATIVE_SUBTITLE_CLASS} ${selector}`)
    .join(", ");
  assert.equal(site.SITES[siteId].nativeSubtitleSelector, expected);
}
assert.ok(
  !styles.includes("lst-hide-netflix-subtitles"),
  "the old site-specific hide class is still in the stylesheet",
);

// The interface is built from describeSupport(), so a service added there
// appears in the settings and setup pages without a second edit.
for (const source of [optionsJs, setupHtml]) {
  assert.match(source, /describeSupport|serviceList|serviceLinks/);
}
assert.match(optionsJs, /describeSupport/);
assert.match(optionsHtml, /id="serviceList"/);
assert.match(setupHtml, /id="serviceList"/);
assert.match(setupHtml, /id="serviceLinks"/);

// The renamed setting: the neutral key is the one written, and the legacy
// spelling survives only as a read-through.
const writers = [
  optionsJs,
  setupHtml,
  await read("setup.js"),
  await read("popup.js"),
  await read("content.js"),
  await read("background.js"),
];
for (const source of writers) {
  assert.ok(
    !/hideNetflixSubtitles\s*:/.test(source),
    "a file still writes the legacy hide-subtitles key",
  );
}
for (const source of [
  await read("content.js"),
  optionsJs,
  await read("setup.js"),
  await read("popup.js"),
]) {
  assert.match(
    source,
    /hideNativeSubtitles/,
    "a file does not know the neutral hide-subtitles key",
  );
}
const settingsSchema = await read("settings-schema.js");
assert.match(settingsSchema, /hideNativeSubtitles/);
assert.match(settingsSchema, /hideNetflixSubtitles/);
assert.match(await read("background.js"), /settingsSchema\.normalizeStored/);

console.log("Playback site adapter checks passed.");
