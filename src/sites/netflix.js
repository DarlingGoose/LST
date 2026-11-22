// Netflix playback-site adapter. Loaded after playback-site.js establishes the
// registry and shared pure helpers.
(() => {
  const registry = globalThis.LSTPlaybackSite;
  const h = globalThis.LSTPlaybackSiteInternals;
  if (!registry || !h) throw new Error("playback-site.js must load before netflix.js");

  const SUBTITLE_URL = String.raw`(?:subtitle|timedtext|textstream|caption|dfxp|ttml|\.ttml(?:\b|[?&]|$)|\.dfxp(?:\b|[?&]|$)|\.vtt(?:\b|[?&]|$)|\.xml(?:\b|[?&]|$)|[?&]o=)`;
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
    captionSelection(win, document) {
      try {
        const videoPlayer = win?.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
        const sessions = videoPlayer?.getAllPlayerSessionIds?.();
        const player = sessions?.length
          ? videoPlayer.getVideoPlayerBySessionId?.(sessions[sessions.length - 1])
          : null;
        const read = player?.getTimedTextTrack || player?.getCurrentTimedTextTrack;
        if (typeof read === "function") {
          const selected = read.call(player);
          if (selected === undefined) return { state: "unknown", reason: "selection-unavailable" };
          if (
            !selected ||
            selected === "off" ||
            selected === "none" ||
            selected?.isForced === true
          ) {
            return { state: "off", reason: "player-selection-off" };
          }
          return { state: "on", reason: "player-selection-on" };
        }
      } catch {}
      const tracks = h.activeVideo(document)?.textTracks;
      if (tracks?.length) {
        return Array.from(tracks).some((track) => track.mode === "showing")
          ? { state: "on", reason: "video-track-showing" }
          : { state: "off", reason: "video-tracks-disabled" };
      }
      return { state: "unknown", reason: "selection-unavailable" };
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
      contentTypes: Object.freeze([
        "ttml",
        "vtt",
        "xml",
        "text/plain",
        "application/xml",
        "application/ttml+xml",
      ]),
      reason: "netflix-delivers-timed-text-as-a-document",
    }),
    activeTimedTextTrack(win) {
      try {
        const videoPlayer = win?.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
        if (!videoPlayer) return null;
        const sessionIds = videoPlayer.getAllPlayerSessionIds?.();
        if (!sessionIds || !sessionIds.length) return null;
        const player = videoPlayer.getVideoPlayerBySessionId(sessionIds[sessionIds.length - 1]);
        if (!player) return null;

        let manifest = null;
        for (const method of ["getManifest", "getMovieManifest", "getPlaybackInfo"]) {
          try {
            if (typeof player[method] === "function") {
              manifest = player[method]();
              if (manifest && (manifest.timedtexttracks || manifest.textTracks)) break;
              manifest = null;
            }
          } catch {}
        }
        if (!manifest) {
          for (const key of Object.keys(player)) {
            const val = player[key];
            if (val && typeof val === "object" && (val.timedtexttracks || val.textTracks)) {
              manifest = val;
              break;
            }
          }
        }
        const tracks = manifest?.timedtexttracks || manifest?.textTracks || [];
        if (!tracks.length) return null;

        const currentTrack = player.getTimedTextTrack?.() || player.getCurrentTimedTextTrack?.();
        const currentTrackId = currentTrack?.trackId || currentTrack?.new_track_id;
        const currentLang = currentTrack?.bcp47 || currentTrack?.language;

        let target = null;
        if (currentTrackId) {
          target = tracks.find(
            (t) => t.trackId === currentTrackId || t.new_track_id === currentTrackId,
          );
        }
        if (!target && currentLang) {
          target = tracks.find(
            (t) => !t.isForced && (t.bcp47 === currentLang || t.language === currentLang),
          );
        }
        if (!target) {
          target = tracks.find((t) => !t.isForced) || tracks[0];
        }
        if (!target) return null;

        const dl =
          target.ttDownloadables ||
          target.downloadables ||
          target.downloadUrls ||
          target.urls;
        let url = "";
        if (dl && typeof dl === "object") {
          for (const format of ["ttml", "dfxp", "webvtt", "vtt"]) {
            const item = dl[format];
            if (typeof item === "string" && item) {
              url = item;
              break;
            }
            if (Array.isArray(item?.urls) && item.urls[0]) {
              const u = item.urls[0];
              url = typeof u === "string" ? u : u?.url || "";
              if (url) break;
            }
            if (item?.downloadUrls) {
              const first = Object.values(item.downloadUrls)[0];
              if (typeof first === "string" && first) {
                url = first;
                break;
              }
            }
          }
          if (!url) {
            for (const val of Object.values(dl)) {
              if (typeof val === "string" && val) {
                url = val;
                break;
              }
              if (Array.isArray(val?.urls) && val.urls[0]) {
                const u = val.urls[0];
                url = typeof u === "string" ? u : u?.url || "";
                if (url) break;
              }
            }
          }
        }
        return url ? { url, language: target.bcp47 || target.language || "" } : null;
      } catch {
        return null;
      }
    },
  };

  registry.registerSite(adapter);
})();
