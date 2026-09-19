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

  // A subtitle URL heuristic is only ever a hint that a response *might* be a
  // subtitle document. The document itself is still validated by
  // `isLikelySubtitleText` in page-hook.js before anything is published.
  const NETFLIX_SUBTITLE_URL = String.raw`(?:subtitle|timedtext|caption|dfxp|webvtt|\.vtt(?:\?|$)|\.xml(?:\?|$)|\?o=)`;

  // Prime Video serves timed text from its own CDNs, and the player asks for
  // the asset before it draws any of it. The document is captured in the page
  // world; the extension itself never asks a CDN for anything.
  const PRIME_SUBTITLE_URL = String.raw`(?:timedtext|subtitle|dfxp|\.ttml(?:\?|$)|\.dfxp(?:\?|$)|\.vtt(?:\?|$)|(?:aiv-cdn|aiv-delivery|pv-cdn)\.net)`;

  // The listing Prime's player asks for before it plays anything. The request
  // names the title and the answer names every asset it carries, timed text
  // among them, which is the only place a browser is ever told where the whole
  // subtitle document lives. It is not a subtitle document itself, so it has its
  // own owner here rather than being matched by the heuristic above.
  const PRIME_PLAYBACK_RESOURCES_URL = String.raw`(?:GetVodPlaybackResources|GetPlaybackResources)`;

  // The language LST looks for first in that listing. LST's viewer is watching
  // Japanese content, and a title that offers several tracks rarely offers the
  // Japanese one alone. A listing with no Japanese track is still usable: the
  // first track in it is captured, and the answer says which rule decided.
  const PRIME_SOURCE_LANGUAGE_PREFERENCE = Object.freeze(["ja"]);

  const NETFLIX_TITLE_CONTAINERS = [
    '[data-uia="video-title"]',
    '[data-uia="player-title"]',
    '[data-uia*="video-title"]',
    ".watch-video--player-view .video-title",
    ".player-status",
  ];

  const NETFLIX_EXPLICIT_SHOW_SELECTORS = [
    '[data-uia="video-title"] [data-uia="series-title"]',
    '[data-uia="series-title"]',
    '[data-uia*="video-title"] [data-uia*="series-title"]',
    '[data-uia*="series-title"]',
    '[data-uia="video-title"] h4',
    '[data-uia="player-title"] h4',
    '[data-uia*="video-title"] h1',
    '[data-uia*="video-title"] h2',
    '[data-uia*="video-title"] h3',
    '[data-uia*="video-title"] h4',
    ".watch-video--player-view .video-title h4",
    ".ellipsize-text h4",
    ".player-status-main-title",
  ];

  const NETFLIX_EXPLICIT_SHOW_ATTRIBUTES = [
    '[data-uia="video-title"] img[alt]',
    ".watch-video--player-view .video-title img[alt]",
  ];

  const NETFLIX_EXPLICIT_EPISODE_SELECTORS = [
    '[data-uia="video-title"] [data-uia="episode-title"]',
    '[data-uia="episode-title"]',
    '[data-uia*="video-title"] [data-uia*="episode-title"]',
    '[data-uia*="episode-title"]',
    ".watch-video--player-view .video-title .episode-title",
    ".player-status-subtitle",
  ];

  const NETFLIX_EXPLICIT_EPISODE_ATTRIBUTES = [
    '[data-uia*="episode"][aria-label*="Episode"]',
    '[data-uia*="episode"][aria-label*="episode"]',
    '[aria-label^="Episode "]',
    '[aria-label^="episode "]',
  ];

  // Prime shows its title in the player chrome. Only hooks that survive a build
  // change are listed, and Phase 0 of the Prime plan has not confirmed any of
  // them on the Japan detail page yet, so an empty result is an expected answer
  // rather than a failure: naming falls back to the site's document title and
  // then to "Prime Video episode <id>".
  const PRIME_TITLE_CONTAINERS = [
    "[data-automation-id='title']",
    ".atvwebplayersdk-title-text",
    ".atvwebplayersdk-content-title",
  ];

  // Amazon's own document titles are "<site>: <show> : Prime Video",
  // "<show> - Prime Video", and the Japanese "<show>を視聴 | Prime Video".
  // The parts below are boilerplate, never a name.
  const PRIME_PAGE_TITLE_PREFIXES = [
    /^Amazon(?:\.[a-z]{2,3})?(?:\.[a-z]{2})?\s*[:：]\s*/i,
    /^Watch\s+/i,
  ];
  const PRIME_PAGE_TITLE_SUFFIXES = [
    /\s*(?:\||[:：]|·|-|–|—)\s*Prime Video.*$/i,
    /\s*を視聴.*$/,
    /\s*の視聴.*$/,
    /\s*を見る.*$/,
    /\s*[:：]\s*Amazon(?:\.[a-z]{2,3})?(?:\.[a-z]{2})?\s*$/i,
  ];

  const NETFLIX_PAGE_TITLE_PREFIXES = [/^Watch\s+/i];
  const NETFLIX_PAGE_TITLE_SUFFIXES = [
    /\s*(?:\||-|–|—)\s*Netflix(?: Official Site)?.*$/i,
  ];

  // Every service's playback pages are recognised from the path alone. A Prime
  // *detail* page is a browse page until a player appears in it, so the gate
  // content.js applies on top of this is what keeps LST idle on a storefront, a
  // product page, and every other Amazon page that is not a watch page. (Whether
  // Prime's mini-player keeps or leaves this path is unverified; see
  // docs/prime-video-recon.md.)
  const PRIME_PLAYBACK_PATHS = [
    /^\/(?:-\/[a-z]{2}(?:-[A-Z]{2})?\/)?gp\/video\/(?:detail|watch)\//,
    /^\/detail\//,
  ];

  const NETFLIX_PLAYBACK_PATHS = [/^\/watch\/\d+(?:\/|$)/];

  // Where the video id sits inside a playback URL. Extraction is this file's
  // question; whether the extracted value is a *known* id shape is
  // episode-identity.js's question, so a genuinely unrecognised path is the
  // only thing reported here.
  const NETFLIX_VIDEO_ID_PATHS = [/\/watch\/(\d+)/];
  const PRIME_VIDEO_ID_PATHS = [
    /\/(?:gp\/video\/)?(?:detail|watch)\/([^/?#]+)/,
  ];

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

  const netflix = Object.freeze({
    id: "netflix",
    label: "Netflix",
    shortLabel: "Netflix",
    matchPatterns: Object.freeze(["https://www.netflix.com/*"]),
    // Where to send a viewer who has no watch page of their own yet.
    homeUrl: "https://www.netflix.com/",
    // Today's HUD is coordinated in the top-right corner, which is also the
    // corner Prime's own title UI does not use. Both services therefore start
    // there and a viewer who wants a different corner says so once.
    defaultHudPosition: "top-right",
    isPlaybackPage: playbackPathTest(NETFLIX_PLAYBACK_PATHS, "netflix"),
    videoIdFrom: videoIdFromPatterns(NETFLIX_VIDEO_ID_PATHS),
    activeVideo,
    // Netflix's watch page *is* the player: opening it is the intent to watch,
    // and LST has always started there. Nothing about this changes.
    playerPresence() {
      return { present: true, reason: "netflix-watch-page-is-the-player" };
    },
    // Netflix renders every line of a cue inside one timed-text container, so
    // reading that container is correct — and is what LST has always done.
    renderedSubtitleLines(document) {
      const containers = [
        ".player-timedtext",
        '[data-uia="player-subtitle-text"]',
        ".player-timedtext-text-container",
      ]
        .map((selector) => document?.querySelector?.(selector))
        .filter(Boolean);
      for (const container of containers) {
        const text = elementText(container);
        if (text) {
          return {
            lines: text.split("\n").filter(Boolean),
            text,
            source: "netflix-timed-text-container",
            reason: "container-has-text",
          };
        }
      }
      return {
        lines: [],
        text: "",
        source: "netflix-timed-text-container",
        reason: containers.length
          ? CAPTION_REASONS.captionsEmpty
          : CAPTION_REASONS.noContainer,
      };
    },
    titleElements(document) {
      const elements = queryAll(document, NETFLIX_TITLE_CONTAINERS);
      return {
        elements,
        reason: elements.length ? "title-elements-found" : "no-title-elements",
      };
    },
    titleSelectors: Object.freeze({
      containers: Object.freeze(NETFLIX_TITLE_CONTAINERS),
      show: Object.freeze(NETFLIX_EXPLICIT_SHOW_SELECTORS),
      showAttributes: Object.freeze(NETFLIX_EXPLICIT_SHOW_ATTRIBUTES),
      episode: Object.freeze(NETFLIX_EXPLICIT_EPISODE_SELECTORS),
      episodeAttributes: Object.freeze(NETFLIX_EXPLICIT_EPISODE_ATTRIBUTES),
    }),
    cleanPageTitle(value) {
      return applyPageTitleRules(
        value,
        NETFLIX_PAGE_TITLE_PREFIXES,
        NETFLIX_PAGE_TITLE_SUFFIXES,
      );
    },
    nativeCaptionSelectors: Object.freeze([
      ".player-timedtext",
      ".player-timedtext-text-container",
      '[data-uia="player-subtitle-text"]',
    ]),
    nativeSubtitleSelector: scopedNativeSubtitleSelector([
      ".player-timedtext",
      ".player-timedtext-text-container",
      '[data-uia="player-subtitle-text"]',
    ]),
    timedText: Object.freeze({
      capture: "url-heuristic",
      urlPatterns: Object.freeze([NETFLIX_SUBTITLE_URL]),
      contentTypes: Object.freeze(["ttml", "vtt", "xml", "text/plain"]),
      reason: "netflix-delivers-timed-text-as-a-document",
    }),
  });

  const primevideo = Object.freeze({
    id: "primevideo",
    label: "Prime Video",
    shortLabel: "Prime",
    matchPatterns: Object.freeze([
      "https://www.amazon.co.jp/*",
      "https://www.amazon.com/*",
      "https://www.primevideo.com/*",
    ]),
    // The global Prime Video storefront, which serves every marketplace.
    homeUrl: "https://www.primevideo.com/",
    defaultHudPosition: "top-right",
    isPlaybackPage: playbackPathTest(PRIME_PLAYBACK_PATHS, "prime"),
    videoIdFrom: videoIdFromPatterns(PRIME_VIDEO_ID_PATHS),
    activeVideo,
    // Prime Video's detail page is a storefront until the player mounts and
    // starts, so both are required. Whether Prime's detail page mounts the ATV
    // player container for its autoplaying trailer is unverified — see
    // docs/prime-video-recon.md — so the answer is reported as a reason rather
    // than assumed, and one adapter method is all that has to change once the
    // Japan page has been inspected.
    playerPresence(document) {
      const container = document?.querySelector?.(
        ".atvwebplayersdk-player-container",
      );
      if (!container) {
        return { present: false, reason: "prime-player-container-absent" };
      }
      const { video, reason } = activeVideo(document);
      if (!video) {
        return { present: false, reason: "prime-no-video-element" };
      }
      return videoHasStarted(video)
        ? { present: true, reason: "prime-player-in-use" }
        : { present: false, reason: `prime-player-not-in-use:${reason}` };
    },
    // Prime reuses a single caption span per line and rewrites its text in
    // place, and the caption container also holds control SVGs and player UI
    // text. Only the per-line spans may be read, and they are joined with \n so
    // a two-row cue keeps the shape subtitle-sync.js already folds.
    renderedSubtitleLines(document) {
      const spans = document?.querySelectorAll
        ? [...document.querySelectorAll(".atvwebplayersdk-captions-text")]
        : [];
      if (!spans.length) {
        return {
          lines: [],
          text: "",
          source: "prime-caption-spans",
          reason: CAPTION_REASONS.spansMissing,
        };
      }
      const lines = spans.map(elementText).filter(Boolean);
      return {
        lines,
        text: lines.join("\n"),
        source: "prime-caption-spans",
        reason: lines.length ? "caption-spans-have-text" : CAPTION_REASONS.captionsEmpty,
      };
    },
    titleElements(document) {
      const elements = queryAll(document, PRIME_TITLE_CONTAINERS);
      return {
        elements,
        reason: elements.length ? "title-elements-found" : "no-title-elements",
      };
    },
    titleSelectors: Object.freeze({
      containers: Object.freeze(PRIME_TITLE_CONTAINERS),
      show: Object.freeze([]),
      showAttributes: Object.freeze([]),
      episode: Object.freeze([]),
      episodeAttributes: Object.freeze([]),
    }),
    cleanPageTitle(value) {
      return applyPageTitleRules(
        value,
        PRIME_PAGE_TITLE_PREFIXES,
        PRIME_PAGE_TITLE_SUFFIXES,
      );
    },
    // Prime rewrites the caption element's inline style periodically, so hiding
    // native captions is a persistent rule with !important and never an inline
    // style.
    nativeCaptionSelectors: Object.freeze([
      ".atvwebplayersdk-captions-text",
    ]),
    nativeSubtitleSelector: scopedNativeSubtitleSelector([
      ".atvwebplayersdk-captions-text",
    ]),
    timedText: Object.freeze({
      // The whole track is reachable: the player asks for the title's assets
      // before it plays them, and the answer lists every timed-text track. The
      // page world reads that listing, captures the track LST wants, and hands
      // the document over as though the player had fetched it — so a Prime
      // episode precomputes and replays from cache like any other.
      capture: "playback-resources",
      urlPatterns: Object.freeze([PRIME_SUBTITLE_URL]),
      contentTypes: Object.freeze(["ttml", "vtt", "xml", "text/plain"]),
      reason: "prime-playback-resources-listing",
    }),
    // The listing itself. `urlPatterns`, not `capture`: what is read from it is
    // not a subtitle document but the names of the ones that exist.
    playbackResources: Object.freeze({
      urlPatterns: Object.freeze([PRIME_PLAYBACK_RESOURCES_URL]),
      tracks: timedTextTracksFromPlaybackResources,
      chooseTrack: chooseTimedTextTrack,
      // The same listing names the episode as well as its assets, which is what
      // lets LST recognize the next episode on a page whose URL never moves.
      identity: episodeIdentityFromPlaybackResources,
    }),
  });

  const SITES = Object.freeze({ netflix, primevideo });
  const SITE_IDS = Object.freeze(Object.keys(SITES));

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
  };

  globalThis.LSTPlaybackSite = api;
  if (typeof module !== "undefined" && module?.exports) {
    module.exports = api;
  }
})();
