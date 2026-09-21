// Prime Video playback-site adapter. All private player selectors and capture
// behavior stay here rather than leaking into runtime consumers.
(() => {
  const registry = globalThis.LSTPlaybackSite;
  const h = globalThis.LSTPlaybackSiteInternals;
  if (!registry || !h) {
    throw new Error("playback-site.js must load before prime-video.js");
  }

  const SUBTITLE_URL = String.raw`(?:timedtext|subtitle|dfxp|\.ttml(?:\?|$)|\.dfxp(?:\?|$)|\.vtt(?:\?|$)|(?:aiv-cdn|aiv-delivery|pv-cdn)\.net)`;
  const PLAYBACK_RESOURCES_URL = String.raw`(?:GetVodPlaybackResources|GetPlaybackResources)`;
  const TITLE_CONTAINERS = [
    "[data-automation-id='title']",
    ".atvwebplayersdk-title-text",
    ".atvwebplayersdk-content-title",
    "h3.hGJxLu",
  ];
  // Prime's episode list/player heading currently renders, for example,
  // `1. 第1話 魔女と花嫁` in this span. Keep the full service-provided wording as
  // the episode name; episode-identity.js independently decides whether any
  // part of it is a recognizable episode marker.
  const EPISODE_TITLE_SELECTORS = [
    "h3.hGJxLu > span._36qUej.hGJxLu",
    "h3.hGJxLu > span.hGJxLu",
  ];
  const PAGE_TITLE_PREFIXES = [
    /^Amazon(?:\.[a-z]{2,3})?(?:\.[a-z]{2})?\s*[:：]\s*/i,
    /^Watch\s+/i,
  ];
  const PAGE_TITLE_SUFFIXES = [
    /\s*(?:\||[:：]|·|-|–|—)\s*Prime Video.*$/i,
    /\s*を視聴.*$/,
    /\s*の視聴.*$/,
    /\s*を見る.*$/,
    /\s*[:：]\s*Amazon(?:\.[a-z]{2,3})?(?:\.[a-z]{2})?\s*$/i,
  ];
  const PLAYBACK_PATHS = [
    /^\/(?:-\/[a-z]{2}(?:-[A-Z]{2})?\/)?gp\/video\/(?:detail|watch)\//,
    /^\/detail\//,
  ];
  const VIDEO_ID_PATHS = [
    /\/(?:gp\/video\/)?(?:detail|watch)\/([^/?#]+)/,
  ];

  const adapter = {
    id: "primevideo",
    label: "Prime Video",
    shortLabel: "Prime",
    matchPatterns: Object.freeze([
      "https://www.amazon.co.jp/*",
      "https://www.amazon.com/*",
      "https://www.primevideo.com/*",
    ]),
    homeUrl: "https://www.primevideo.com/",
    defaultHudPosition: "top-right",
    isPlaybackPage: h.playbackPathTest(PLAYBACK_PATHS, "prime"),
    videoIdFrom: h.videoIdFromPatterns(VIDEO_ID_PATHS),
    activeVideo: h.activeVideo,
    playerPresence(document) {
      const container = document?.querySelector?.(
        ".atvwebplayersdk-player-container",
      );
      if (!container) {
        return { present: false, reason: "prime-player-container-absent" };
      }
      const { video, reason } = h.activeVideo(document);
      if (!video) return { present: false, reason: "prime-no-video-element" };
      return h.videoHasStarted(video)
        ? { present: true, reason: "prime-player-in-use" }
        : { present: false, reason: `prime-player-not-in-use:${reason}` };
    },
    renderedSubtitleLines(document) {
      const spans = document?.querySelectorAll
        ? [...document.querySelectorAll(".atvwebplayersdk-captions-text")]
        : [];
      if (!spans.length) {
        return {
          lines: [],
          text: "",
          source: "prime-caption-spans",
          reason: h.CAPTION_REASONS.spansMissing,
        };
      }
      const lines = spans.map(h.elementText).filter(Boolean);
      return {
        lines,
        text: lines.join("\n"),
        source: "prime-caption-spans",
        reason: lines.length
          ? "caption-spans-have-text"
          : h.CAPTION_REASONS.captionsEmpty,
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
      show: Object.freeze([]),
      showAttributes: Object.freeze([]),
      episode: Object.freeze(EPISODE_TITLE_SELECTORS),
      episodeAttributes: Object.freeze([]),
    }),
    cleanPageTitle(value) {
      return h.applyPageTitleRules(
        value,
        PAGE_TITLE_PREFIXES,
        PAGE_TITLE_SUFFIXES,
      );
    },
    nativeCaptionSelectors: Object.freeze([
      ".atvwebplayersdk-captions-text",
    ]),
    nativeSubtitleSelector: h.scopedNativeSubtitleSelector([
      ".atvwebplayersdk-captions-text",
    ]),
    timedText: Object.freeze({
      capture: "playback-resources",
      urlPatterns: Object.freeze([SUBTITLE_URL]),
      contentTypes: Object.freeze(["ttml", "vtt", "xml", "text/plain"]),
      reason: "prime-playback-resources-listing",
    }),
    playbackResources: Object.freeze({
      urlPatterns: Object.freeze([PLAYBACK_RESOURCES_URL]),
      tracks: h.timedTextTracksFromPlaybackResources,
      chooseTrack: h.chooseTimedTextTrack,
      identity: h.episodeIdentityFromPlaybackResources,
    }),
  };

  registry.registerSite(adapter);
})();
