// LST playback site adapter.
//
// One owner for every site-specific fact: which service a page belongs to, what
// that service's playback pages look like, which <video> element is the one the
// viewer is watching, how the service renders a subtitle line, where it shows
// the title, how its own document title is worded, and how its native captions
// are hidden.
//
// The questions used to be answered in content.js and page-hook.js with one
// service's vocabulary baked in: `/watch/<digits>`, `[data-uia=…]` selectors,
// `document.querySelector("video")`, and a Netflix-shaped subtitle URL
// heuristic. A second service could only be added by scattering conditionals
// through both files. The facts live here instead, once, and every answer
// carries the reason it was given. A question this file cannot answer — an
// unknown host, a page that is not a playback page, a caption container with no
// captions in it — is reported rather than guessed at.
//
// Nothing here touches the network, browser storage, or a timer. It is pure: it
// takes a `location`, a `document`, and a `url` as arguments and returns
// records. The background, the page-world hook, and the content script all load
// it, so all three agree on what a page is.

(() => {
  const UNKNOWN_VIDEO_ID = "unknown";

  // The language LST looks for first in that listing. LST's viewer is watching
  // Japanese content, and a title that offers several tracks rarely offers the
  // Japanese one alone. A listing with no Japanese track is still usable: the
  // first track in it is captured, and the answer says which rule decided.
  const PRIME_SOURCE_LANGUAGE_PREFERENCE = Object.freeze(["ja"]);

  // The class content.js toggles on <html> when the viewer asks LST to hide the
  // service's own captions. Each adapter lists the elements to hide, and the
  // scoped selector is derived from that list rather than written twice.
  const NATIVE_SUBTITLE_CLASS = "lst-hide-native-subtitles";

  function scopedNativeSubtitleSelector(selectors) {
    return selectors
      .map((selector) => `html.${NATIVE_SUBTITLE_CLASS} ${selector}`)
      .join(", ");
  }

  const CAPTION_REASONS = Object.freeze({
    noContainer: "no-caption-container",
    captionsEmpty: "captions-empty",
    spansMissing: "no-caption-spans",
  });

  function normalizeText(value) {
    return String(value ?? "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();
  }

  function elementText(element) {
    if (!element) return "";
    return normalizeText(element.innerText || element.textContent || "");
  }

  function queryAll(root, selectors) {
    const elements = [];
    if (!root?.querySelectorAll) return elements;
    for (const selector of selectors) {
      for (const element of root.querySelectorAll(selector)) {
        if (!elements.includes(element)) elements.push(element);
      }
    }
    return elements;
  }

  // Prime renders several <video> elements (main playback plus ad and preview
  // slots), and the one that wins at startup is not always the one that keeps
  // playing. Area is the documented tie-break; when layout is unavailable the
  // intrinsic video size stands in for it.
  function videoArea(video) {
    const rect = video?.getBoundingClientRect?.();
    const width = Number(rect?.width) || 0;
    const height = Number(rect?.height) || 0;
    if (width > 0 && height > 0) return width * height;
    const intrinsicWidth = Number(video?.videoWidth) || 0;
    const intrinsicHeight = Number(video?.videoHeight) || 0;
    return intrinsicWidth * intrinsicHeight;
  }

  function activeVideo(document) {
    const videos = document?.querySelectorAll
      ? [...document.querySelectorAll("video")]
      : [];
    if (!videos.length) return { video: null, reason: "no-video-element" };
    if (videos.length === 1) {
      return { video: videos[0], reason: "only-video-element" };
    }
    let best = null;
    let bestArea = -1;
    for (const video of videos) {
      const area = videoArea(video);
      if (area > bestArea) {
        bestArea = area;
        best = video;
      }
    }
    return {
      video: best,
      reason: bestArea > 0 ? "largest-video-element" : "video-size-unknown",
    };
  }

  // Whether a player is actually in use on this page. A playback *path* is not
  // the same question: a Prime Video detail page is a storefront with a trailer
  // on it until the viewer presses play, and painting LST's overlay over a
  // storefront is exactly what this question exists to prevent.
  function videoHasStarted(video) {
    if (!video) return false;
    // Metadata loaded, or time moving, or a known duration. Any of these means a
    // player is in use rather than merely present in the markup.
    return (
      Number(video.readyState) >= 1 ||
      Number(video.currentTime) > 0 ||
      Number(video.duration) > 0
    );
  }

  function applyPageTitleRules(value, prefixes, suffixes) {
    let title = normalizeText(value);
    for (const pattern of prefixes) title = title.replace(pattern, "");
    for (const pattern of suffixes) title = title.replace(pattern, "");
    return normalizeText(title);
  }

  // A playback page is decided by the path. `search` and `host` are passed
  // through so an adapter can use them without changing the call shape.
  function playbackPathTest(patterns, hostField) {
    return ({ pathname, search, host }) => {
      const path = String(pathname ?? "");
      for (const pattern of patterns) {
        if (pattern.test(path)) {
          return {
            ok: true,
            reason: `${hostField}-playback-page`,
            shape: String(pattern),
          };
        }
      }
      return {
        ok: false,
        reason: `${hostField}-not-a-playback-page`,
        shape: "",
        search: String(search ?? ""),
        host: String(host ?? ""),
      };
    };
  }

  function videoIdFromPatterns(paths) {
    return ({ pathname }) => {
      const path = String(pathname ?? "");
      for (const pattern of paths) {
        const match = path.match(pattern);
        if (!match) continue;
        let candidate = String(match[1] || "");
        try {
          candidate = decodeURIComponent(candidate);
        } catch {
          // A malformed escape is still the id Amazon wrote; keep it as-is
          // rather than turning the whole page into an unidentifiable one.
        }
        if (!candidate || candidate.length > 128 || candidate.includes("/")) {
          return { videoId: "", kind: "", reason: "video-id-unrecognized" };
        }
        return { videoId: candidate, kind: "extracted", reason: "ok" };
      }
      return { videoId: "", kind: "", reason: "video-id-unrecognized" };
    };
  }

  // --- Reading a playback-resources listing ---------------------------------
  //
  // Everything below is pure: a parsed JSON document in, tracks out. It is read
  // in the page world, which owns the request and the cookies for it, so the
  // answer travels back to LST as data and never as a URL LST would fetch
  // itself.

  const TIMED_TEXT_TRACK_KIND = Object.freeze({
    subtitle: "subtitle",
    forcedNarrative: "forced-narrative",
  });

  // One entry of a listing, in any of the shapes Amazon has been seen to use: a
  // bare URL, an object naming one, or nothing usable at all.
  function normalizeTimedTextTrack(entry, kind) {
    if (typeof entry === "string") {
      return entry
        ? {
            url: entry,
            languageCode: "",
            language: "",
            kind,
            forced: kind === TIMED_TEXT_TRACK_KIND.forcedNarrative,
          }
        : null;
    }
    if (!entry || typeof entry !== "object") return null;
    const url = String(entry.url || entry.downloadUrl || entry.src || "");
    if (!url) return null;
    const languageCode = String(
      entry.languageCode || entry.isoCode || entry.language || "",
    ).toLowerCase();
    const forced = kind === TIMED_TEXT_TRACK_KIND.forcedNarrative || entry.forced === true;
    return {
      url,
      languageCode,
      language: String(entry.displayName || entry.languageDisplayName || entry.language || ""),
      kind: forced ? TIMED_TEXT_TRACK_KIND.forcedNarrative : kind,
      forced,
    };
  }

  // `ttDownloadables` is `{ ttml: { urls: [...] }, webvtt: { urls: [...] } }`:
  // the first URL of the first format offered is the one that exists.
  function urlFromDownloadables(downloadables) {
    if (!downloadables || typeof downloadables !== "object") return "";
    for (const value of Object.values(downloadables)) {
      const urls = Array.isArray(value?.urls) ? value.urls : [];
      for (const url of urls) {
        if (typeof url === "string" && url) return url;
      }
    }
    return "";
  }

  function timedTextTracksFromPlaybackResources(payload) {
    if (!payload || typeof payload !== "object") return [];
    const tracks = [];
    const push = (list, kind) => {
      if (!Array.isArray(list)) return;
      for (const entry of list) {
        const track = normalizeTimedTextTrack(entry, kind);
        if (track) tracks.push(track);
      }
    };

    // The envelope the player's own plan document uses, and the flatter spelling
    // of the same listing.
    const result =
      payload.timedTextUrls?.result && typeof payload.timedTextUrls.result === "object"
        ? payload.timedTextUrls.result
        : payload.timedTextUrls || payload;
    push(result.subtitleUrls, TIMED_TEXT_TRACK_KIND.subtitle);
    push(result.forcedNarrativeUrls, TIMED_TEXT_TRACK_KIND.forcedNarrative);

    // The delivery document's spelling of the same thing.
    if (Array.isArray(payload.timedtexttracks)) {
      for (const entry of payload.timedtexttracks) {
        const url = urlFromDownloadables(entry?.ttDownloadables);
        const track = normalizeTimedTextTrack(
          url ? { ...entry, url } : entry,
          TIMED_TEXT_TRACK_KIND.subtitle,
        );
        if (track) tracks.push(track);
      }
    }
    return tracks;
  }

  // Which of those tracks is the episode's source. A forced-narrative track
  // translates on-screen text — signs, songs, foreign speech — rather than the
  // dialogue, so it is never what LST captures: a viewer reading it would be
  // reading a fragment of the episode as though it were all of it. If the
  // listing holds nothing else, the answer is that there is no track, and the
  // reason says so.
  function chooseTimedTextTrack(tracks, options = {}) {
    const list = Array.isArray(tracks) ? tracks.filter((track) => track?.url) : [];
    if (!list.length) return { track: null, reason: "no-timed-text-tracks" };
    const eligible = list.filter((track) => !track.forced);
    if (!eligible.length) return { track: null, reason: "only-forced-narrative-track" };
    const preferred = Array.isArray(options.preferLanguages) && options.preferLanguages.length
      ? options.preferLanguages
      : PRIME_SOURCE_LANGUAGE_PREFERENCE;
    for (const code of preferred) {
      const wanted = String(code || "").toLowerCase();
      const match = eligible.find((track) => track.languageCode.startsWith(wanted));
      if (match) return { track: match, reason: `preferred-language:${wanted}` };
    }
    return { track: eligible[0], reason: "first-listed-track" };
  }

  // Which episode the listing is about. The same answer the player is handed
  // names the item it is about to play — Amazon's catalog entry for the episode,
  // its season, and the series the season belongs to — and that is the only
  // place a browser is told which episode a player holding one URL is showing.
  // On `amazon.<tld>` the path can stay on the series while the episode
  // advances, so the URL is not an answer to this question; the listing is.
  //
  // Everything is read defensively and said plainly: a field the listing does
  // not state is left empty with the reason in `reason`/`sources`, never filled
  // in from a guess, and a shape LST does not recognise answers
  // `no-catalog-metadata` rather than a partial record pretending to be whole.
  // The item's own id is returned unvalidated — the adapter reports what the
  // listing said, and `episode-identity.js` decides whether it is an id LST can
  // key a cache on.
  const CATALOG_ITEM_KEYS = Object.freeze(["catalogMetadata", "catalog"]);
  const SERIES_ANCESTOR_TYPES = Object.freeze([
    /^(?:tv\s*show|show|series|serie)$/i,
  ]);
  const SEASON_ANCESTOR_TYPES = Object.freeze([/^season$/i]);

  function catalogItemFromListing(payload) {
    if (!payload || typeof payload !== "object") return null;
    for (const key of CATALOG_ITEM_KEYS) {
      const holder = payload[key];
      if (!holder || typeof holder !== "object") continue;
      const item = key === "catalogMetadata" ? holder.catalog : holder;
      if (item && typeof item === "object") {
        return { item, family: holder.family, source: key };
      }
    }
    return null;
  }

  function catalogAncestors(holder) {
    const ancestors = holder?.family?.tvAncestors;
    return Array.isArray(ancestors) ? ancestors : [];
  }

  function ancestorTitle(holder, patterns) {
    for (const ancestor of catalogAncestors(holder)) {
      const catalog = ancestor?.catalog;
      if (!catalog || typeof catalog !== "object") continue;
      const type = String(catalog.type || "");
      if (!patterns.some((pattern) => pattern.test(type))) continue;
      const title = String(catalog.title || "").trim();
      if (title) return { title, catalog };
    }
    return null;
  }

  function positiveInteger(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
  }

  function episodeIdentityFromPlaybackResources(payload) {
    const found = catalogItemFromListing(payload);
    if (!found) {
      return {
        reason: "no-catalog-metadata",
        catalogSource: "",
        itemType: "",
        title: "",
        episodic: false,
        showName: "",
        showNameSource: "",
        videoId: "",
        videoIdSource: "",
        seasonNumber: null,
        episodeNumber: null,
      };
    }

    const { item, source } = found;
    const itemType = String(item.type || "").trim().toUpperCase();
    const title = String(item.title || "").trim();
    const episodeNumber = positiveInteger(item.episodeNumber);
    const episodic = itemType === "EPISODE" || episodeNumber != null;

    const season = ancestorTitle(found, SEASON_ANCESTOR_TYPES);
    const series = ancestorTitle(found, SERIES_ANCESTOR_TYPES);
    const showName = series?.title || season?.title || (episodic ? "" : title);
    const showNameSource = series
      ? "series-ancestor"
      : season
        ? "season-ancestor"
        : !episodic && title
          ? "item-title"
          : "";

    const rendition = payload?.returnedTitleRendition;
    const idCandidates = [
      ["catalog-id", item.id],
      ["rendition-title-id", rendition?.titleId],
      ["rendition-asin", rendition?.asin],
    ];
    const idEntry = idCandidates.find(
      ([, value]) => typeof value === "string" && value.trim(),
    );

    return {
      reason: "catalog-metadata",
      catalogSource: source,
      itemType,
      title,
      episodic,
      showName,
      showNameSource,
      videoId: idEntry ? idEntry[1].trim() : "",
      videoIdSource: idEntry ? idEntry[0] : "",
      seasonNumber:
        positiveInteger(item.seasonNumber) || positiveInteger(season?.catalog?.seasonNumber),
      episodeNumber,
    };
  }

  // Adapters register through one validated boundary. Keeping registration
  // explicit lets tests compare the adapter host list with the manifest's
  // intentionally narrow permissions.
  const SITES = Object.create(null);
  const SITE_IDS = [];
  const REQUIRED_ADAPTER_FUNCTIONS = Object.freeze([
    "isPlaybackPage",
    "videoIdFrom",
    "activeVideo",
    "playerPresence",
    "renderedSubtitleLines",
    "titleElements",
    "cleanPageTitle",
  ]);

  function registerSite(adapter) {
    if (!adapter || typeof adapter !== "object") {
      throw new TypeError("A playback-site adapter must be an object.");
    }
    const id = String(adapter.id || "").trim();
    if (!/^[a-z][a-z0-9-]*$/.test(id)) {
      throw new TypeError(`Invalid playback-site adapter id: ${id || "(empty)"}`);
    }
    if (SITES[id]) throw new Error(`Playback-site adapter already registered: ${id}`);
    if (!String(adapter.label || "").trim()) {
      throw new TypeError(`Playback-site adapter ${id} has no label.`);
    }
    if (!Array.isArray(adapter.matchPatterns) || !adapter.matchPatterns.length) {
      throw new TypeError(`Playback-site adapter ${id} has no match patterns.`);
    }
    if (!Array.isArray(adapter.nativeCaptionSelectors)) {
      throw new TypeError(`Playback-site adapter ${id} has no native-caption selectors.`);
    }
    if (!adapter.titleSelectors || typeof adapter.titleSelectors !== "object") {
      throw new TypeError(`Playback-site adapter ${id} has no title-selector contract.`);
    }
    for (const name of REQUIRED_ADAPTER_FUNCTIONS) {
      if (typeof adapter[name] !== "function") {
        throw new TypeError(`Playback-site adapter ${id} is missing ${name}().`);
      }
    }
    if (
      !adapter.timedText ||
      !String(adapter.timedText.capture || "") ||
      !Array.isArray(adapter.timedText.urlPatterns) ||
      !Array.isArray(adapter.timedText.contentTypes)
    ) {
      throw new TypeError(`Playback-site adapter ${id} has no timed-text contract.`);
    }
    for (const existingId of SITE_IDS) {
      const overlap = adapter.matchPatterns.find((pattern) =>
        SITES[existingId].matchPatterns.includes(pattern));
      if (overlap) {
        throw new Error(
          `Playback-site adapters ${existingId} and ${id} both claim ${overlap}`,
        );
      }
    }
    SITES[id] = Object.freeze(adapter);
    SITE_IDS.push(id);
    return SITES[id];
  }

  function patternToRegExp(pattern) {
    const parts = String(pattern ?? "")
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`^${parts.join(".*")}$`);
  }

  const PATTERN_REGEXPS = new Map();
  function cachedPatternRegExp(pattern) {
    if (!PATTERN_REGEXPS.has(pattern)) {
      PATTERN_REGEXPS.set(pattern, patternToRegExp(pattern));
    }
    return PATTERN_REGEXPS.get(pattern);
  }

  function locationHref(location) {
    if (!location) return "";
    if (typeof location.href === "string" && location.href) return location.href;
    const host = location.host || location.hostname || "";
    if (!host) return "";
    const protocol = location.protocol || "https:";
    return `${protocol}//${host}${location.pathname || "/"}${location.search || ""}`;
  }

  function locationView(location) {
    const href = locationHref(location);
    let pathname = location?.pathname == null ? "" : String(location.pathname);
    if (!pathname && href) {
      try {
        pathname = new URL(href).pathname;
      } catch {
        pathname = "";
      }
    }
    return {
      href,
      pathname,
      search: String(location?.search ?? ""),
      host: String(location?.host || location?.hostname || ""),
    };
  }

  // Which service is this page? `site` is null when the answer is "none of
  // them", and the reason says which question failed: an unusable location, or
  // a host no adapter claims.
  function detect(location) {
    const view = locationView(location);
    if (!view.href) {
      return {
        site: null,
        siteId: "",
        matchPattern: "",
        view,
        reason: "location-unavailable",
      };
    }
    for (const siteId of SITE_IDS) {
      const site = SITES[siteId];
      for (const pattern of site.matchPatterns) {
        if (cachedPatternRegExp(pattern).test(view.href)) {
          return { site, siteId, matchPattern: pattern, view, reason: "site-detected" };
        }
      }
    }
    return {
      site: null,
      siteId: "",
      matchPattern: "",
      view,
      reason: "site-unsupported",
    };
  }

  function current() {
    return detect(globalThis.location);
  }

  function labelFor(siteId) {
    return SITES[siteId]?.label || "";
  }

  function siteFor(siteId) {
    return SITES[siteId] || null;
  }

  function defaultHudPosition(siteId) {
    return SITES[siteId]?.defaultHudPosition || "top-right";
  }

  // What each service can actually do, told once, so the settings page, the
  // player status and the documentation cannot describe behaviour this file
  // does not implement.
  function describeSupport() {
    return SITE_IDS.map((siteId) => {
      const site = SITES[siteId];
      return {
        id: site.id,
        label: site.label,
        homeUrl: site.homeUrl,
        hosts: [...site.matchPatterns],
        nativeCaptionSelector: site.nativeSubtitleSelector,
        nativeCaptionSelectors: [...site.nativeCaptionSelectors],
        hudPosition: site.defaultHudPosition,
        timedTextCapture: site.timedText.capture,
        timedTextReason: site.timedText.reason,
      };
    });
  }

  const api = {
    UNKNOWN_VIDEO_ID,
    NATIVE_SUBTITLE_CLASS,
    SITES,
    SITE_IDS,
    activeVideo,
    videoHasStarted,
    defaultHudPosition,
    describeSupport,
    detect,
    labelFor,
    siteFor,
    current,
    normalizeText,
    episodeIdentityFromPlaybackResources,
    registerSite,
  };

  // Classic content scripts cannot import ES modules. Adapter scripts load
  // immediately after this registry and receive only the pure helpers and
  // constants required to construct their records.
  globalThis.LSTPlaybackSiteInternals = Object.freeze({
    CAPTION_REASONS,
    scopedNativeSubtitleSelector,
    elementText,
    queryAll,
    activeVideo,
    videoHasStarted,
    applyPageTitleRules,
    playbackPathTest,
    videoIdFromPatterns,
    timedTextTracksFromPlaybackResources,
    chooseTimedTextTrack,
    episodeIdentityFromPlaybackResources,
  });
  globalThis.LSTPlaybackSite = api;
  if (typeof module !== "undefined" && module?.exports) {
    module.exports = api;
  }
})();
