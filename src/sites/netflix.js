// Netflix playback-site adapter. Loaded after playback-site.js establishes the
// registry and shared pure helpers.
(() => {
  const registry = globalThis.LSTPlaybackSite;
  const h = globalThis.LSTPlaybackSiteInternals;
  if (!registry || !h) throw new Error("playback-site.js must load before netflix.js");

  const SUBTITLE_URL = String.raw`(?:subtitle|timedtext|caption|dfxp|webvtt|\.vtt(?:\?|$)|\.xml(?:\?|$)|\?o=)`;
  const TITLE_CONTAINERS = [
    '[data-uia="video-title"]',
    '[data-uia="player-title"]',
    '[data-uia*="video-title"]',
    ".watch-video--player-view .video-title",
    ".player-status",
  ];
  const SHOW_SELECTORS = [
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
  const SHOW_ATTRIBUTES = [
    '[data-uia="video-title"] img[alt]',
    ".watch-video--player-view .video-title img[alt]",
  ];
  const EPISODE_SELECTORS = [
    '[data-uia="video-title"] [data-uia="episode-title"]',
    '[data-uia="episode-title"]',
    '[data-uia*="video-title"] [data-uia*="episode-title"]',
    '[data-uia*="episode-title"]',
    ".watch-video--player-view .video-title .episode-title",
    ".player-status-subtitle",
  ];
  const EPISODE_ATTRIBUTES = [
    '[data-uia*="episode"][aria-label*="Episode"]',
    '[data-uia*="episode"][aria-label*="episode"]',
    '[aria-label^="Episode "]',
    '[aria-label^="episode "]',
  ];
  const PAGE_TITLE_PREFIXES = [/^Watch\s+/i];
  const PAGE_TITLE_SUFFIXES = [
    /\s*(?:\||-|–|—)\s*Netflix(?: Official Site)?.*$/i,
  ];
  const PLAYBACK_PATHS = [/^\/watch\/\d+(?:\/|$)/];
  const VIDEO_ID_PATHS = [/\/watch\/(\d+)/];

  const adapter = {
    id: "netflix",
    label: "Netflix",
    shortLabel: "Netflix",
    matchPatterns: Object.freeze(["https://www.netflix.com/*"]),
    homeUrl: "https://www.netflix.com/",
    defaultHudPosition: "top-right",
    isPlaybackPage: h.playbackPathTest(PLAYBACK_PATHS, "netflix"),
    videoIdFrom: h.videoIdFromPatterns(VIDEO_ID_PATHS),
    activeVideo: h.activeVideo,
    playerPresence() {
      return { present: true, reason: "netflix-watch-page-is-the-player" };
    },
    renderedSubtitleLines(document) {
      const containers = [
        ".player-timedtext",
        '[data-uia="player-subtitle-text"]',
        ".player-timedtext-text-container",
      ]
        .map((selector) => document?.querySelector?.(selector))
        .filter(Boolean);
      for (const container of containers) {
        const text = h.elementText(container);
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
          ? h.CAPTION_REASONS.captionsEmpty
          : h.CAPTION_REASONS.noContainer,
      };
    },
    titleElements(document) {
      const elements = h.queryAll(document, TITLE_CONTAINERS);
      return {
        elements,
        reason: elements.length ? "title-elements-found" : "no-title-elements",
      };
    },
    titleSelectors: Object.freeze({
      containers: Object.freeze(TITLE_CONTAINERS),
      show: Object.freeze(SHOW_SELECTORS),
      showAttributes: Object.freeze(SHOW_ATTRIBUTES),
      episode: Object.freeze(EPISODE_SELECTORS),
      episodeAttributes: Object.freeze(EPISODE_ATTRIBUTES),
    }),
    cleanPageTitle(value) {
      return h.applyPageTitleRules(
        value,
        PAGE_TITLE_PREFIXES,
        PAGE_TITLE_SUFFIXES,
      );
    },
    nativeCaptionSelectors: Object.freeze([
      ".player-timedtext",
      ".player-timedtext-text-container",
      '[data-uia="player-subtitle-text"]',
    ]),
    nativeSubtitleSelector: h.scopedNativeSubtitleSelector([
      ".player-timedtext",
      ".player-timedtext-text-container",
      '[data-uia="player-subtitle-text"]',
    ]),
    timedText: Object.freeze({
      capture: "url-heuristic",
      urlPatterns: Object.freeze([SUBTITLE_URL]),
      contentTypes: Object.freeze(["ttml", "vtt", "xml", "text/plain"]),
      reason: "netflix-delivers-timed-text-as-a-document",
    }),
  };

  registry.registerSite(adapter);
})();
