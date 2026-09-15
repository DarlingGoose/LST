(() => {
  const ext = globalThis.browser || globalThis.chrome;
  const SOURCE = "lst-local-subtitle-translate";

  const DEFAULTS = {
    enabled: true,
    provider: "ollama",
    model: "translategemma:4b",
    targetLanguage: "English",
    hideNetflixSubtitles: true,
    showOriginal: false,
    showTranslated: true,
    minimumSubtitleDisplaySeconds: 2,
    maximumVisibleSubtitles: 2,
    showStatusMessages: true,
    autoTranslateAhead: true,
    useTranslationContext: false,
    lookAheadSeconds: 30,
    cacheWhilePaused: true,
    batchSize: 8,
    requestTimeoutSeconds: 75,
    showDebugPanel: false,
    debugPanelAlwaysOnTop: false,
    showQuickPills: true,
    showTranscriptSidebar: false,
    subtitleHorizontalPosition: "center",
    subtitleVerticalPosition: 9,
    subtitleMaxWidth: 92,
    translatedFontSize: 36,
    originalFontSize: 30,
    subtitleBackgroundOpacity: 58,
    subtitleTimingOffsetMs: 0,
  };
  const NETFLIX_SUBTITLE_STABILITY_MS = 90;
  const TIMED_TRACK_MISMATCH_GRACE_MS = 300;
  const DEBUG_FLUSH_MS = 500;

  let settings = { ...DEFAULTS };
  let cues = [];
  let cueSourceUrl = "";
  let cueVideoId = "";
  const titleMetadataByVideoId = new Map();
  const titleMetadataRequestsByVideoId = new Map();
  const storedTitleSignaturesByCacheId = new Map();

  let overlay;
  let subtitleStack;
  let statusLine;
  let hud;
  let quickPillsPanel;
  let quickPillsMenu;
  let quickPillsState;
  let debugPanel;
  let debugPanelBody;
  let transcriptPanel;
  let transcriptList;
  let transcriptActiveIndex = -1;
  let transcriptRowsByKey = new Map();
  let unifiedControlsStatus;
  let unifiedControlsStatusTimer;
  let statusMessageRequestedVisible = false;

  let lastRenderedCueKey = "";
  let renderedSubtitles = [];
  let lastFallbackText = "";
  let fallbackTimer = null;
  let netflixSubtitleCandidate = "";
  let netflixSubtitleCandidateSince = 0;
  let timedTrackSyncState = "unverified";
  let automaticCueTimeOffsetSeconds = 0;
  let lastNetflixSyncText = "";
  let timedTrackMismatchSince = 0;
  let lastTimedTrackMismatch = "";
  let timedTrackMismatchSequence = 0;
  let activeTimedTrackMismatchId = 0;
  let noTimedCueSince = 0;
  let lastTitleMetadataRefreshAt = 0;
  let titleMetadataRefreshTimer = null;

  let translationCoordinator;
  let knownCachedKeys = new Set();
  let knownCachedTranslations = new Map();
  let lookAheadQueued = new Set();
  let lookAheadNoticeShown = false;
  let lookAheadReadyNoticeShown = false;
  let precomputeInProgress = false;
  let precomputePromise = null;
  let precomputeCancelled = false;
  let pausedCachingPromise = null;
  let pausedCacheNoticeShown = false;
  let pausedCacheCompleteNoticeShown = false;
  let pausedCacheFailedKeys = new Set();
  let lastPlaybackWasPaused = false;
  let diagnosticEvents = [];
  let diagnosticFlushTimer = null;
  let diagnosticTextIds = new Map();
  let nextDiagnosticTextId = 1;
  let playbackActive = false;
  let playbackGeneration = 0;
  let cacheGeneration = 0;
  let stopTitleMetadataObserver = () => {};
  let stopFallbackObserver = () => {};

  let currentStatus = {
    captured: false,
    cueCount: 0,
    translatedCount: 0,
    remainingCueCount: 0,
    remainingTranslatedCount: 0,
    episodeProgressPercent: 0,
    cachedAheadSeconds: 0,
    failedCount: 0,
    precomputing: false,
    progressPercent: 0,
    currentBatch: 0,
    totalBatches: 0,
    currentRangeStart: 0,
    currentRangeEnd: 0,
    currentText: "",
    lastTranslatedText: "",
    lastError: "",
    batchStartedAt: 0,
    jobStartedAt: 0,
    playbackMode: "waiting",
    videoTime: 0,
    activeCueStart: null,
    activeCueEnd: null,
    requestState: "idle",
    lastRequestMs: 0,
    lastRequestRequested: 0,
    lastRequestTranslated: 0,
    lastRequestFailed: 0,
    lastOllamaMode: "",
    lastOllamaRaw: "",
    lastDiagnostics: [],
    message: "Waiting for Netflix subtitles…",
  };

  async function runtimeMessage(message) {
    const response = await ext.runtime.sendMessage(message);
    if (!response?.ok) {
      throw new Error(response?.error || "Extension request failed.");
    }
    return response;
  }

  function diagnosticCue(key) {
    const match = String(key || "").match(/^(-?\d+):(-?\d+):/);
    if (match) return `${match[1]}:${match[2]}`;
    return String(key || "").startsWith("fallback:") ? "fallback" : "";
  }

  function flushDiagnosticEvents() {
    clearTimeout(diagnosticFlushTimer);
    diagnosticFlushTimer = null;
    if (!diagnosticEvents.length) return;
    const events = diagnosticEvents.splice(0, diagnosticEvents.length);
    try {
      const pending = ext.runtime.sendMessage({ type: "APPEND_DEBUG_EVENTS", events });
      if (pending?.catch) pending.catch(() => {});
    } catch {}
  }

  function logDiagnostic(level, category, event, details = {}, key = "") {
    const videoTime = Number(document.querySelector("video")?.currentTime);
    diagnosticEvents.push({
      timestamp: Date.now(),
      level,
      category,
      event,
      videoId: getVideoId(),
      videoTime: Number.isFinite(videoTime) ? videoTime : null,
      cue: diagnosticCue(key),
      details,
    });
    if (diagnosticEvents.length >= 20) flushDiagnosticEvents();
    else if (!diagnosticFlushTimer) {
      diagnosticFlushTimer = setTimeout(flushDiagnosticEvents, DEBUG_FLUSH_MS);
    }
  }

  function getVideoId() {
    const match = location.pathname.match(/\/watch\/(\d+)/);
    return match ? match[1] : "unknown";
  }

  function isWatchPage() {
    return /^\/watch\/\d+(?:\/|$)/.test(location.pathname);
  }

  function normalizeText(text) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();
  }

  function comparableSubtitleText(text) {
    return normalizeText(text).replace(/\s+/g, " ");
  }

  function subtitleTextsMatch(left, right) {
    const comparableLeft = comparableSubtitleText(left);
    return Boolean(
      comparableLeft && comparableLeft === comparableSubtitleText(right),
    );
  }

  function simplifiedDiagnosticText(text) {
    return globalThis.LSTSubtitleSync.simplifySubtitleText(text);
  }

  function diagnosticTextId(text) {
    const normalized = comparableSubtitleText(text);
    if (!normalized) return "empty";
    if (!diagnosticTextIds.has(normalized)) {
      diagnosticTextIds.set(normalized, `text-${nextDiagnosticTextId++}`);
    }
    return diagnosticTextIds.get(normalized);
  }

  function truncate(text, max = 160) {
    const normalized = normalizeText(text);
    return normalized.length <= max
      ? normalized
      : `${normalized.slice(0, max - 1)}…`;
  }

  function cueKey(cue) {
    const text = normalizeText(cue.text);
    if (Number(cue.start) < 0 || Number(cue.end) < 0) {
      return `fallback:${text}`;
    }
    return `${Math.round(cue.start * 1000)}:${Math.round(cue.end * 1000)}:${text}`;
  }

  function fallbackCueForText(text) {
    // Stable key so repeated DOM updates for the same subtitle reuse the cache.
    return { start: -1, end: -1, text: normalizeText(text) };
  }

  function promoteFallbackEntries(entries) {
    if (!cues.length) return entries;

    const timedCuesByText = new Map();
    for (const cue of cues) {
      const text = comparableSubtitleText(cue.text);
      const matches = timedCuesByText.get(text) || [];
      matches.push(cue);
      timedCuesByText.set(text, matches);
    }

    const promoted = {};
    for (const [key, translation] of Object.entries(entries || {})) {
      if (!key.startsWith("fallback:")) {
        promoted[key] = translation;
        continue;
      }
      const matches = timedCuesByText.get(
        comparableSubtitleText(key.slice("fallback:".length)),
      );
      if (matches?.length === 1) {
        promoted[cueKey(matches[0])] = translation;
      } else {
        promoted[key] = translation;
      }
    }
    return promoted;
  }

  function cacheId() {
    const model = encodeURIComponent(
      settings.provider === "ollama"
        ? settings.model || "none"
        : `${settings.provider}/${settings.model || "none"}`
    );
    const language = encodeURIComponent(settings.targetLanguage || "English");
    return `${cueVideoId || getVideoId()}:${model}:${language}`;
  }

  function cleanNetflixPageTitle(value) {
    return normalizeText(value)
      .replace(/^Watch\s+/i, "")
      .replace(/\s*(?:\||-|–|—)\s*Netflix(?: Official Site)?.*$/i, "")
      .trim();
  }

  function metadataTexts(selectors, attribute = "") {
    const values = [];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const value = normalizeText(
          attribute
            ? element.getAttribute(attribute)
            : element.innerText || element.textContent,
        );
        if (value && !values.includes(value)) values.push(value);
      }
    }
    return values;
  }

  function isGenericNetflixTitle(value) {
    return (
      !value ||
      /^(?:Netflix(?:\s*[-–—|:].*)?|Netflix episode \S+|Unknown Netflix episode)$/i.test(
        value,
      )
    );
  }

  function fallbackEpisodeName(videoId) {
    return videoId && videoId !== "unknown"
      ? `Video ${videoId}`
      : "Episode details unavailable";
  }

  function isFallbackEpisodeName(value, videoId) {
    return (
      !value ||
      value === `Episode ${videoId}` ||
      value === fallbackEpisodeName(videoId)
    );
  }

  function episodeMarker(text) {
    const value = normalizeText(text);
    const seasonEpisode = value.match(
      /\bS(?:eason)?\s*(\d+)\s*[:·-]?\s*E(?:pisode)?\s*(\d+)\b/i,
    );
    if (seasonEpisode) {
      return `Season ${Number(seasonEpisode[1])} · Episode ${Number(seasonEpisode[2])}`;
    }
    const episode = value.match(/\bE(?:pisode)?\s*(\d+)\b/i);
    return episode ? `Episode ${Number(episode[1])}` : "";
  }

  function decodeEmbeddedMetadataText(value) {
    return normalizeText(value)
      .replace(/\\x20/g, " ")
      .replace(/\\n/g, " ")
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }

  function episodeMetadataFromHtml(html, videoId) {
    const normalizedHtml = String(html || "").replace(/\\"/g, '"');
    const match = normalizedHtml.match(
      new RegExp(
        `"videoId":${videoId},"title":"((?:\\\\.|[^"\\\\])*)"` +
          `[^}]{0,3000}?"number":(\\d+)`,
      ),
    );
    if (!match) return null;

    const parsed = new DOMParser().parseFromString(String(html), "text/html");
    const showName = cleanNetflixPageTitle(
      parsed.title || parsed.querySelector('meta[property="og:title"]')?.content,
    );
    const number = Number(match[2]);
    const title = decodeEmbeddedMetadataText(match[1]);
    return {
      showName: isGenericNetflixTitle(showName) ? "" : showName,
      episodeName: [`Episode ${number}`, title].filter(Boolean).join(" · "),
    };
  }

  function requestNetflixTitleMetadata(videoId) {
    if (
      !videoId ||
      videoId === "unknown" ||
      titleMetadataRequestsByVideoId.has(videoId)
    ) {
      return;
    }

    const request = fetch(`/title/${encodeURIComponent(videoId)}`, {
      credentials: "same-origin",
    })
      .then((response) => {
        if (!response.ok) throw new Error(`Netflix returned ${response.status}`);
        return response.text();
      })
      .then((html) => {
        const metadata = episodeMetadataFromHtml(html, videoId);
        if (!metadata?.episodeName) return;
        const previous = titleMetadataByVideoId.get(videoId) || {};
        titleMetadataByVideoId.set(videoId, {
          showName: metadata.showName || previous.showName || "Netflix",
          episodeName: metadata.episodeName,
        });
        persistImprovedCacheMetadata();
      })
      .catch((error) => {
        console.warn("[LST] Could not load Netflix episode details:", error);
      });
    titleMetadataRequestsByVideoId.set(videoId, request);
  }

  function netflixTitleMetadata() {
    const titleContainers = document.querySelectorAll(
      '[data-uia="video-title"], [data-uia="player-title"], ' +
        '[data-uia*="video-title"], .watch-video--player-view .video-title, ' +
        ".player-status",
    );
    const explicitShowCandidates = [
      ...metadataTexts([
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
      ]),
      ...metadataTexts(
        [
          '[data-uia="video-title"] img[alt]',
          ".watch-video--player-view .video-title img[alt]",
        ],
        "alt",
      ),
    ];
    const explicitEpisodeCandidates = metadataTexts([
      '[data-uia="video-title"] [data-uia="episode-title"]',
      '[data-uia="episode-title"]',
      '[data-uia*="video-title"] [data-uia*="episode-title"]',
      '[data-uia*="episode-title"]',
      ".watch-video--player-view .video-title .episode-title",
      ".player-status-subtitle",
      '[data-uia*="episode"][aria-label*="Episode"]',
      '[data-uia*="episode"][aria-label*="episode"]',
    ]);
    explicitEpisodeCandidates.push(
      ...metadataTexts(
        [
          '[data-uia*="episode"][aria-label*="Episode"]',
          '[data-uia*="episode"][aria-label*="episode"]',
        ],
        "aria-label",
      ),
      ...metadataTexts(
        ['[aria-label^="Episode "]', '[aria-label^="episode "]'],
        "aria-label",
      ),
    );
    const pageTitleCandidates = [
      document.title,
      ...metadataTexts(
        [
          'meta[property="og:title"]',
          'meta[name="twitter:title"]',
          'meta[name="title"]',
        ],
        "content",
      ),
    ]
      .map(cleanNetflixPageTitle)
      .filter((value) => !isGenericNetflixTitle(value));
    const parts = [...titleContainers]
      .flatMap((container) => [
        ...container.querySelectorAll("h1, h2, h3, h4, span"),
      ])
      .map((element) => normalizeText(element.innerText || element.textContent))
      .filter(
        (value, index, values) =>
          value &&
          values.indexOf(value) === index &&
          !/^\d+(?::\d+)+$/.test(value) &&
          !/^(?:HD|4K|HDR|UHD|AD|CC)$/i.test(value),
      );

    const markerSource = [...explicitEpisodeCandidates, ...parts].find(
      (value) => episodeMarker(value),
    );
    const normalizedEpisodeMarker = episodeMarker(markerSource);
    const usableExplicitShow = explicitShowCandidates.find(
      (value) =>
        !isGenericNetflixTitle(value) &&
        !episodeMarker(value) &&
        !explicitEpisodeCandidates.includes(value),
    );
    const usablePageTitle = pageTitleCandidates[0] || "";
    const showName =
      usableExplicitShow ||
      usablePageTitle ||
      parts.find(
        (value) =>
          !isGenericNetflixTitle(value) &&
          !episodeMarker(value) &&
          !explicitEpisodeCandidates.includes(value),
      ) ||
      "";
    const episodeTitle =
      explicitEpisodeCandidates.find(
        (value) => value !== showName && !episodeMarker(value),
      ) ||
      (normalizedEpisodeMarker
        ? parts
            .slice(Math.max(0, parts.indexOf(markerSource) + 1))
            .find(
              (value) =>
                value !== showName &&
                value !== usablePageTitle &&
                !episodeMarker(value),
            )
        : "") ||
      "";
    const episodeName = [
      ...new Set([normalizedEpisodeMarker, episodeTitle].filter(Boolean)),
    ].join(" · ");
    const videoId = getVideoId();
    const previous = titleMetadataByVideoId.get(videoId) || {};
    const previousEpisodeName = isFallbackEpisodeName(
      previous.episodeName,
      videoId,
    )
      ? ""
      : previous.episodeName;
    const discovered = {
      showName: showName || previous.showName || "Netflix",
      episodeName:
        episodeName || previousEpisodeName || fallbackEpisodeName(videoId),
    };

    const hasSpecificEpisode = !isFallbackEpisodeName(
      discovered.episodeName,
      videoId,
    );
    if (!hasSpecificEpisode) requestNetflixTitleMetadata(videoId);
    if (
      !isGenericNetflixTitle(discovered.showName) ||
      !previous.showName ||
      hasSpecificEpisode
    ) {
      titleMetadataByVideoId.set(videoId, discovered);
    }
    const remembered = titleMetadataByVideoId.get(videoId) || discovered;

    return {
      ...remembered,
      title: [remembered.showName, remembered.episodeName]
        .filter(Boolean)
        .join(" — "),
    };
  }

  function cacheMetadata() {
    const videoId = cueVideoId || getVideoId();
    const currentVideoId = getVideoId();
    const remembered = titleMetadataByVideoId.get(videoId);
    const titleMetadata =
      videoId === currentVideoId
        ? netflixTitleMetadata()
        : {
            showName: remembered?.showName || "Netflix",
            episodeName:
              remembered?.episodeName || fallbackEpisodeName(videoId),
            title:
              [remembered?.showName, remembered?.episodeName]
                .filter(Boolean)
                .join(" — ") || `Netflix episode ${videoId}`,
          };
    return {
      videoId,
      ...titleMetadata,
      url: location.href,
      provider: settings.provider || "ollama",
      model: settings.model || "Unknown model",
      targetLanguage: settings.targetLanguage || "English",
      sourceCueCount: cues.length,
    };
  }

  function persistImprovedCacheMetadata() {
    if (!cues.length || !knownCachedKeys.size || cueVideoId !== getVideoId())
      return;
    const metadata = cacheMetadata();
    if (!metadata.showName || metadata.showName === "Netflix") return;

    const signature = `${metadata.showName}|${metadata.episodeName}`;
    const currentCacheId = cacheId();
    if (storedTitleSignaturesByCacheId.get(currentCacheId) === signature)
      return;
    storedTitleSignaturesByCacheId.set(currentCacheId, signature);

    runtimeMessage({
      type: "CACHE_SET",
      cacheId: currentCacheId,
      entries: {},
      metadata,
    }).catch((error) => {
      storedTitleSignaturesByCacheId.delete(currentCacheId);
      console.warn("[LST] Could not refresh cached episode title:", error);
    });
  }

  function startTitleMetadataObserver() {
    const titleSelector =
      'title, [data-uia="video-title"], [data-uia="player-title"], ' +
      '[data-uia*="video-title"], [data-uia*="series-title"], ' +
      '[data-uia*="episode-title"], .video-title, .player-status';
    const observer = new MutationObserver((mutations) => {
      if (!playbackActive || !isWatchPage()) return;
      const titleChanged = mutations.some((mutation) => {
        const target =
          mutation.target.nodeType === Node.ELEMENT_NODE
            ? mutation.target
            : mutation.target.parentElement;
        if (target?.closest?.(titleSelector)) return true;
        return [...mutation.addedNodes].some(
          (node) =>
            node.nodeType === Node.ELEMENT_NODE &&
            (node.matches?.(titleSelector) || node.querySelector?.(titleSelector)),
        );
      });
      if (!titleChanged) return;

      clearTimeout(titleMetadataRefreshTimer);
      titleMetadataRefreshTimer = setTimeout(() => {
        netflixTitleMetadata();
        persistImprovedCacheMetadata();
      }, 50);
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => {
      observer.disconnect();
      clearTimeout(titleMetadataRefreshTimer);
      titleMetadataRefreshTimer = null;
    };
  }

  function updateProgress(videoTime) {
    const total = Math.max(0, currentStatus.cueCount || 0);
    const translated = Math.max(0, currentStatus.translatedCount || 0);
    currentStatus.episodeProgressPercent = total
      ? Math.min(100, Number(((translated / total) * 100).toFixed(1)))
      : 0;

    const video = document.querySelector("video");
    const rawTime = Number.isFinite(Number(videoTime))
      ? Number(videoTime)
      : Number(video?.currentTime);
    if (!Number.isFinite(rawTime) || !cues.length) {
      currentStatus.remainingCueCount = total;
      currentStatus.remainingTranslatedCount = translated;
      currentStatus.progressPercent = currentStatus.episodeProgressPercent;
      return;
    }

    const time = subtitleLookupTime(rawTime);
    const remainingCues = cues.filter((cue) => cue.end > time);
    const remainingTranslated = remainingCues.reduce(
      (count, cue) => count + (knownCachedKeys.has(cueKey(cue)) ? 1 : 0),
      0,
    );
    currentStatus.remainingCueCount = remainingCues.length;
    currentStatus.remainingTranslatedCount = remainingTranslated;
    currentStatus.progressPercent = remainingCues.length
      ? Math.min(
          100,
          Number(((remainingTranslated / remainingCues.length) * 100).toFixed(1)),
        )
      : 100;
  }

  function parseClock(value, tickRate = 10_000_000) {
    if (!value) return NaN;
    value = String(value).trim();

    if (/^\d+(?:\.\d+)?t$/.test(value)) {
      return Number(value.slice(0, -1)) / tickRate;
    }
    if (/^\d+(?:\.\d+)?ms$/.test(value)) {
      return Number(value.slice(0, -2)) / 1000;
    }
    if (/^\d+(?:\.\d+)?s$/.test(value)) {
      return Number(value.slice(0, -1));
    }
    if (/^\d+(?:\.\d+)?m$/.test(value)) {
      return Number(value.slice(0, -1)) * 60;
    }
    if (/^\d+(?:\.\d+)?h$/.test(value)) {
      return Number(value.slice(0, -1)) * 3600;
    }

    const match = value.match(/^(\d+):(\d{2}):(\d{2})(?:[.,](\d+))?$/);
    if (match) {
      const [, h, m, s, frac = "0"] = match;
      return (
        Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(`0.${frac}`)
      );
    }

    return Number(value);
  }

  function extractNodeText(node) {
    if (!node) return "";
    const clone = node.cloneNode(true);
    for (const br of clone.querySelectorAll("br")) {
      br.replaceWith("\n");
    }
    return normalizeText(clone.textContent || "");
  }

  function parseTtml(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.querySelector("parsererror")) return [];

    const tt = doc.documentElement;
    const tickRate = Number(
      tt.getAttribute("ttp:tickRate") ||
        tt.getAttribute("tickRate") ||
        10_000_000,
    );

    const nodes = [...doc.getElementsByTagNameNS("*", "p")];
    return nodes
      .map((node, index) => {
        const start = parseClock(node.getAttribute("begin"), tickRate);
        let end = parseClock(node.getAttribute("end"), tickRate);
        const duration = parseClock(node.getAttribute("dur"), tickRate);

        if (
          !Number.isFinite(end) &&
          Number.isFinite(start) &&
          Number.isFinite(duration)
        ) {
          end = start + duration;
        }

        return {
          id:
            node.getAttribute("xml:id") ||
            node.getAttribute("id") ||
            String(index),
          start,
          end,
          text: extractNodeText(node),
        };
      })
      .filter(
        (cue) =>
          Number.isFinite(cue.start) &&
          Number.isFinite(cue.end) &&
          cue.end > cue.start &&
          cue.text,
      );
  }

  function parseVttTimestamp(value) {
    const parts = value.trim().split(":").map(Number);
    if (parts.some(Number.isNaN)) return NaN;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return NaN;
  }

  function parseVtt(text) {
    const lines = text.replace(/\r/g, "").split("\n");
    const result = [];
    let i = 0;

    while (i < lines.length) {
      let line = lines[i].trim();

      if (!line || line === "WEBVTT" || line.startsWith("NOTE")) {
        i++;
        continue;
      }

      let id = "";
      if (
        !line.includes("-->") &&
        i + 1 < lines.length &&
        lines[i + 1].includes("-->")
      ) {
        id = line;
        i++;
        line = lines[i].trim();
      }

      const match = line.match(/^(\S+)\s+-->\s+(\S+)/);
      if (!match) {
        i++;
        continue;
      }

      const start = parseVttTimestamp(match[1].replace(",", "."));
      const end = parseVttTimestamp(match[2].replace(",", "."));
      i++;

      const payload = [];
      while (i < lines.length && lines[i].trim() !== "") {
        payload.push(lines[i]);
        i++;
      }

      const cueText = normalizeText(payload.join("\n").replace(/<[^>]+>/g, ""));

      if (Number.isFinite(start) && Number.isFinite(end) && cueText) {
        result.push({
          id: id || String(result.length),
          start,
          end,
          text: cueText,
        });
      }
    }

    return result;
  }

  function parseSubtitleDocument(text) {
    const trimmed = String(text || "").trim();
    if (/^WEBVTT\b/i.test(trimmed)) return parseVtt(trimmed);
    if (/<tt[\s>]/i.test(trimmed)) return parseTtml(trimmed);
    return [];
  }

  async function loadSettings() {
    try {
      settings = {
        ...DEFAULTS,
        ...(await runtimeMessage({ type: "GET_SETTINGS" })).settings,
      };
    } catch (error) {
      console.warn("[LST] Could not load settings:", error);
    }
  }

  function activeFullscreenElement() {
    return (
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement ||
      null
    );
  }

  function overlayHost() {
    const fullscreen = activeFullscreenElement();
    // Netflix normally fullscreens a player container. A native fullscreen
    // <video> cannot render arbitrary child overlays, so retain the regular
    // host in that uncommon browser-controlled mode.
    return fullscreen?.tagName !== "VIDEO"
      ? fullscreen || document.documentElement
      : document.documentElement;
  }

  function syncOverlayHost() {
    const host = overlayHost();
    for (const element of [overlay, hud, debugPanel, transcriptPanel]) {
      if (element?.isConnected && element.parentElement !== host) {
        host.appendChild(element);
      }
    }
  }

  function startFullscreenObserver() {
    const handleFullscreenChange = () => {
      if (!playbackActive) return;
      requestAnimationFrame(() => {
        ensureOverlay();
        syncOverlayHost();
        applySubtitleAppearance();
        renderSubtitleStack();
        positionDebugPanel();
      });
    };
    for (const eventName of [
      "fullscreenchange",
      "webkitfullscreenchange",
      "mozfullscreenchange",
      "MSFullscreenChange",
    ]) {
      document.addEventListener(eventName, handleFullscreenChange);
    }
  }

  function ensureOverlay() {
    if (!overlay?.isConnected) {
      overlay = document.createElement("div");
      overlay.id = "not-overlay";
      overlay.innerHTML = `<div id="lst-subtitle-stack"></div>`;
      document.documentElement.appendChild(overlay);

      subtitleStack = overlay.querySelector("#lst-subtitle-stack");
    }

    if (!hud?.isConnected) {
      hud = document.createElement("div");
      hud.id = "lst-hud";
      document.documentElement.appendChild(hud);
    }

    if (!statusLine?.isConnected) {
      statusLine = document.createElement("div");
      statusLine.id = "not-status";
      statusLine.setAttribute("role", "status");
      statusLine.setAttribute("aria-live", "polite");
      hud.appendChild(statusLine);
    }

    if (!quickPillsPanel?.isConnected) {
      quickPillsPanel = document.createElement("div");
      quickPillsPanel.id = "lst-quick-pills";
      quickPillsPanel.innerHTML = `
        <button id="lst-pill-trigger" type="button" data-pill-action="toggle" aria-expanded="false" aria-haspopup="true" aria-controls="lst-pill-menu">
          <span class="lst-pill-dot" aria-hidden="true"></span>
          <strong>LST</strong>
          <span id="lst-pill-state">Waiting</span>
          <span id="lst-pill-ahead" class="lst-pill-ahead"></span>
          <span class="lst-pill-controls-label">Controls</span>
        </button>
        <div id="lst-pill-menu" hidden>
          <div class="lst-pill-menu-header">
            <div>
              <strong>Subtitle controls</strong>
              <span id="lst-pill-panel-status">Waiting for subtitles</span>
            </div>
            <button type="button" data-pill-action="collapse">Collapse</button>
          </div>
          <section class="lst-pill-section" aria-labelledby="lst-visibility-heading">
            <h3 id="lst-visibility-heading">Visibility</h3>
            <label><span>Translation</span><span class="lst-pill-switch"><input data-pill-setting="showTranslated" type="checkbox" role="switch"><span class="lst-pill-switch-ui"></span></span></label>
            <label><span>Original text</span><span class="lst-pill-switch"><input data-pill-setting="showOriginal" type="checkbox" role="switch"><span class="lst-pill-switch-ui"></span></span></label>
            <label><span>Hide Netflix subtitles</span><span class="lst-pill-switch"><input data-pill-setting="hideNetflixSubtitles" type="checkbox" role="switch"><span class="lst-pill-switch-ui"></span></span></label>
            <label><span>Transcript sidebar</span><span class="lst-pill-switch"><input data-pill-setting="showTranscriptSidebar" type="checkbox" role="switch"><span class="lst-pill-switch-ui"></span></span></label>
          </section>
          <section class="lst-pill-section lst-pill-timing" aria-labelledby="lst-timing-heading">
            <span><h3 id="lst-timing-heading">Timing offset</h3><output id="lst-pill-timing-value">0 ms</output></span>
            <div>
              <button type="button" data-pill-action="earlier" aria-label="Show subtitles 100 milliseconds earlier">−100 ms</button>
              <button type="button" data-pill-action="timing-reset">Reset</button>
              <button type="button" data-pill-action="later" aria-label="Show subtitles 100 milliseconds later">+100 ms</button>
            </div>
          </section>
          <section class="lst-pill-section" aria-labelledby="lst-readability-heading">
            <h3 id="lst-readability-heading">Readability</h3>
            <div class="lst-pill-readability-grid">
              <label><span>Minimum display</span><select data-pill-setting="minimumSubtitleDisplaySeconds" data-number>
                <option value="0">Original timing</option>
                <option value="1">1 second</option>
                <option value="2">2 seconds</option>
                <option value="3">3 seconds</option>
                <option value="4">4 seconds</option>
                <option value="5">5 seconds</option>
                <option value="7">7 seconds</option>
                <option value="10">10 seconds</option>
              </select></label>
              <label><span>Subtitle stack</span><select data-pill-setting="maximumVisibleSubtitles" data-number>
                <option value="1">1 line</option>
                <option value="2">2 lines</option>
                <option value="3">3 lines</option>
                <option value="4">4 lines</option>
              </select></label>
            </div>
          </section>
          <div class="lst-pill-menu-footer">
            <span id="lst-pill-save-status" role="status" aria-live="polite"></span>
            <div>
              <button type="button" data-pill-action="settings">All settings</button>

            </div>
          </div>
        </div>
      `;
      hud.appendChild(quickPillsPanel);
      quickPillsMenu = quickPillsPanel.querySelector("#lst-pill-menu");
      quickPillsState = quickPillsPanel.querySelector("#lst-pill-state");
      unifiedControlsStatus = quickPillsPanel.querySelector(
        "#lst-pill-save-status",
      );
      bindQuickPills();
    }

    if (!debugPanel?.isConnected) {
      debugPanel = document.createElement("div");
      debugPanel.id = "lst-debug-panel";
      debugPanel.innerHTML = `
        <div id="lst-debug-header">
          <strong>LST</strong>
          <span id="lst-debug-version"></span>
        </div>
        <pre id="lst-debug-body"></pre>
      `;
      document.documentElement.appendChild(debugPanel);
      debugPanelBody = debugPanel.querySelector("#lst-debug-body");
      debugPanel.querySelector("#lst-debug-version").textContent =
        `v${ext.runtime.getManifest().version}`;
    }

    if (!transcriptPanel?.isConnected) {
      transcriptPanel = document.createElement("aside");
      transcriptPanel.id = "lst-transcript-panel";
      transcriptPanel.setAttribute("aria-label", "Episode transcript");
      transcriptPanel.innerHTML = `
        <header id="lst-transcript-header">
          <div><strong>Episode transcript</strong><span id="lst-transcript-count"></span></div>
          <button type="button" id="lst-transcript-close" aria-label="Hide transcript">×</button>
        </header>
        <div id="lst-transcript-list" tabindex="0"></div>
      `;
      document.documentElement.appendChild(transcriptPanel);
      transcriptList = transcriptPanel.querySelector("#lst-transcript-list");
      transcriptPanel.querySelector("#lst-transcript-close").addEventListener(
        "click",
        () => setTranscriptSidebarVisible(false),
      );
      renderTranscript();
    }

    syncOverlayHost();
    updateDebugPanel();
    applySubtitleAppearance();
    updateOverlayPanelVisibility();
    return overlay;
  }

  function clamp(value, min, max, fallback) {
    const number = Number(value);
    return Math.min(
      max,
      Math.max(min, Number.isFinite(number) ? number : fallback),
    );
  }

  function formatTranscriptTime(seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remainingSeconds = Math.floor(total % 60);
    return hours
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
      : `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
  }

  function updateTranscriptVisibility() {
    if (!transcriptPanel) return;
    const visible = Boolean(settings.enabled && settings.showTranscriptSidebar);
    const wasHidden = transcriptPanel.hidden;
    transcriptPanel.hidden = !visible;
    document.documentElement.classList.toggle("lst-transcript-open", visible);
    if (visible && wasHidden) {
      transcriptActiveIndex = -1;
      const video = document.querySelector("video");
      focusTranscriptCue(
        video ? findCueAt(subtitleLookupTime(video.currentTime)) : null,
      );
    }
  }

  function renderTranscript() {
    if (!transcriptList || !transcriptPanel) return;
    transcriptList.replaceChildren();
    transcriptRowsByKey = new Map();
    transcriptActiveIndex = -1;
    const count = transcriptPanel.querySelector("#lst-transcript-count");
    if (count) count.textContent = cues.length ? `${cues.length} cues` : "Waiting for track";

    if (!cues.length) {
      const empty = document.createElement("p");
      empty.className = "lst-transcript-empty";
      empty.textContent = "Turn on a Netflix subtitle track to load its transcript.";
      transcriptList.appendChild(empty);
      updateTranscriptVisibility();
      return;
    }

    const fragment = document.createDocumentFragment();
    cues.forEach((cue, index) => {
      const key = cueKey(cue);
      const row = document.createElement("article");
      row.className = "lst-transcript-cue";
      row.dataset.cueIndex = String(index);
      const time = document.createElement("time");
      time.textContent = formatTranscriptTime(cue.start);
      const text = document.createElement("div");
      text.className = "lst-transcript-text";
      const original = document.createElement("p");
      original.className = "lst-transcript-original";
      original.textContent = cue.text;
      const translated = document.createElement("p");
      translated.className = "lst-transcript-translated";
      const translation = knownCachedTranslations.get(key) || "";
      translated.textContent = translation || "Translation pending";
      translated.dataset.pending = translation ? "false" : "true";
      text.append(original, translated);
      row.append(time, text);
      fragment.appendChild(row);
      transcriptRowsByKey.set(key, row);
    });
    transcriptList.appendChild(fragment);
    updateTranscriptVisibility();
  }

  function updateTranscriptTranslations(entries) {
    for (const [key, translation] of Object.entries(entries || {})) {
      if (!translation) continue;
      const translated = transcriptRowsByKey
        .get(key)
        ?.querySelector(".lst-transcript-translated");
      if (!translated) continue;
      translated.textContent = translation;
      translated.dataset.pending = "false";
    }
  }

  function focusTranscriptCue(match) {
    const index = match?.index ?? -1;
    if (index === transcriptActiveIndex) return;
    if (transcriptActiveIndex >= 0) {
      transcriptList
        ?.querySelector(`[data-cue-index="${transcriptActiveIndex}"]`)
        ?.removeAttribute("data-current");
    }
    transcriptActiveIndex = index;
    if (index < 0 || !settings.showTranscriptSidebar) return;
    const row = transcriptList?.querySelector(`[data-cue-index="${index}"]`);
    if (!row) return;
    row.dataset.current = "true";
    row.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function setTranscriptSidebarVisible(visible) {
    settings.showTranscriptSidebar = Boolean(visible);
    updateTranscriptVisibility();
    updateQuickPills();
    if (visible) {
      const video = document.querySelector("video");
      focusTranscriptCue(
        video ? findCueAt(subtitleLookupTime(video.currentTime)) : null,
      );
    }
    logDiagnostic("info", "transcript", visible ? "sidebar-opened" : "sidebar-closed");
    runtimeMessage({
      type: "SAVE_SETTINGS",
      settings: { showTranscriptSidebar: settings.showTranscriptSidebar },
    }).catch((error) =>
      setStatus(`Could not save transcript setting: ${error.message}`, true),
    );
  }

  function applySubtitleAppearance() {
    if (!overlay || !subtitleStack) return;

    document.documentElement.classList.toggle(
      "lst-hide-netflix-subtitles",
      settings.enabled && settings.hideNetflixSubtitles,
    );

    const alignment = ["left", "center", "right"].includes(
      settings.subtitleHorizontalPosition,
    )
      ? settings.subtitleHorizontalPosition
      : "center";
    const opacity = clamp(settings.subtitleBackgroundOpacity, 0, 90, 58) / 100;

    overlay.style.bottom = `${clamp(settings.subtitleVerticalPosition, 4, 82, 9)}%`;
    overlay.style.width = `min(${clamp(settings.subtitleMaxWidth, 40, 96, 92)}vw, 1100px)`;
    overlay.style.textAlign = alignment;
    overlay.style.left =
      alignment === "center" ? "50%" : alignment === "left" ? "4vw" : "auto";
    overlay.style.right = alignment === "right" ? "4vw" : "auto";
    overlay.style.transform =
      alignment === "center" ? "translateX(-50%)" : "none";

    overlay.style.setProperty(
      "--lst-original-font-size",
      `${clamp(settings.originalFontSize, 14, 56, 30)}px`,
    );
    overlay.style.setProperty(
      "--lst-translated-font-size",
      `${clamp(settings.translatedFontSize, 18, 64, 36)}px`,
    );
    overlay.style.setProperty(
      "--lst-subtitle-background",
      `rgba(0, 0, 0, ${opacity})`,
    );
    overlay.dataset.alignment = alignment;

    trimRenderedSubtitles();
    renderSubtitleStack();
    statusLine.style.display =
      settings.showStatusMessages &&
      statusMessageRequestedVisible &&
      currentStatus.message
        ? "block"
        : "none";

    updateQuickPills();
    updateTranscriptVisibility();
  }

  function showUnifiedControlsStatus(message, isError = false) {
    if (!unifiedControlsStatus) return;
    unifiedControlsStatus.textContent = message;
    unifiedControlsStatus.dataset.error = isError ? "true" : "false";
    clearTimeout(unifiedControlsStatusTimer);
    unifiedControlsStatusTimer = setTimeout(() => {
      if (unifiedControlsStatus) unifiedControlsStatus.textContent = "";
    }, 1800);
  }

  function quickPillStatus() {
    if (pausedCachingPromise) return { label: "Caching", state: "buffering" };
    if (currentStatus.precomputing)
      return { label: "Precomputing", state: "buffering" };
    if (currentStatus.requestState === "running" || lookAheadQueued.size) {
      return { label: "Buffering", state: "buffering" };
    }
    if (
      currentStatus.captured &&
      currentStatus.cueCount > 0 &&
      currentStatus.translatedCount >= currentStatus.cueCount
    ) {
      return { label: "Completed", state: "completed" };
    }
    if (
      currentStatus.captured &&
      currentStatus.remainingCueCount >= 0 &&
      currentStatus.remainingTranslatedCount >= currentStatus.remainingCueCount
    ) {
      return { label: "Ready from here", state: "ready" };
    }
    if (currentStatus.requestState === "error")
      return { label: "Error", state: "error" };
    if (String(currentStatus.playbackMode).includes("realtime")) {
      return { label: "Realtime", state: "realtime" };
    }
    if (String(currentStatus.playbackMode).includes("cache")) {
      return { label: "Cached", state: "cached" };
    }
    if (currentStatus.captured) return { label: "Ready", state: "ready" };
    return { label: "Waiting", state: "waiting" };
  }

  function updateQuickPills() {
    if (!quickPillsPanel || !quickPillsState) return;
    quickPillsPanel.style.display = settings.showQuickPills ? "block" : "none";
    refreshCacheCoverage();
    const status = quickPillStatus();
    quickPillsPanel.dataset.state = status.state;
    quickPillsState.textContent = status.label;
    const panelStatus = quickPillsPanel.querySelector("#lst-pill-panel-status");
    const ahead = quickPillsPanel.querySelector("#lst-pill-ahead");
    const aheadLabel =
      currentStatus.cachedAheadSeconds > 0
        ? formatAheadDuration(currentStatus.cachedAheadSeconds)
        : "";
    if (ahead) {
      ahead.textContent = aheadLabel ? `· ${aheadLabel} cached` : "";
    }
    if (panelStatus) {
      panelStatus.textContent =
        status.state === "completed"
          ? "Completed · episode cached"
          : status.label === "Ready from here"
            ? "Ready from here · remaining subtitles cached"
          : `${status.label}${aheadLabel ? ` · ${aheadLabel} cached ahead` : ""}`;
      panelStatus.dataset.state = status.state;
    }
    for (const control of quickPillsPanel.querySelectorAll(
      "[data-pill-setting]",
    )) {
      const value = settings[control.dataset.pillSetting];
      if (control.type === "checkbox") control.checked = value !== false;
      else control.value = String(value);
    }
    const timing = clamp(settings.subtitleTimingOffsetMs, -2000, 2000, 0);
    const timingOutput = quickPillsPanel.querySelector(
      "#lst-pill-timing-value",
    );
    if (timingOutput)
      timingOutput.textContent = `${timing > 0 ? "+" : ""}${timing} ms`;
  }

  function bindQuickPills() {
    quickPillsPanel.addEventListener("click", (event) => {
      const action =
        event.target.closest("[data-pill-action]")?.dataset.pillAction;
      if (action === "toggle") {
        setQuickPillsMenu(quickPillsMenu.hidden);
      } else if (action === "collapse") {
        setQuickPillsMenu(false);
      } else if (["earlier", "timing-reset", "later"].includes(action)) {
        const current = clamp(settings.subtitleTimingOffsetMs, -2000, 2000, 0);
        settings.subtitleTimingOffsetMs =
          action === "timing-reset"
            ? 0
            : clamp(
                current + (action === "later" ? 100 : -100),
                -2000,
                2000,
                0,
              );
        applySubtitleAppearance();
        runtimeMessage({
          type: "SAVE_SETTINGS",
          settings: { subtitleTimingOffsetMs: settings.subtitleTimingOffsetMs },
        })
          .then(() => showUnifiedControlsStatus("Saved"))
          .catch((error) =>
            showUnifiedControlsStatus(`Could not save: ${error.message}`, true),
          );
      } else if (action === "settings") {
        setQuickPillsMenu(false);
        runtimeMessage({ type: "OPEN_OPTIONS" }).catch((error) => {
          setStatus(`Could not open settings: ${error.message}`, true);
        });
      } else if (action === "hide-overlay") {
        settings.showQuickPills = false;
        setQuickPillsMenu(false);
        updateOverlayPanelVisibility();
        runtimeMessage({
          type: "SAVE_SETTINGS",
          settings: { showQuickPills: false },
        }).catch((error) =>
          setStatus(`Could not hide LST controls: ${error.message}`, true),
        );
      }
    });

    quickPillsPanel.addEventListener("change", (event) => {
      const control = event.target.closest("[data-pill-setting]");
      if (!control) return;
      const key = control.dataset.pillSetting;
      settings[key] =
        control.type === "checkbox" ? control.checked : Number(control.value);
      applySubtitleAppearance();
      if (key === "showTranscriptSidebar") {
        logDiagnostic(
          "info",
          "transcript",
          settings.showTranscriptSidebar ? "sidebar-opened" : "sidebar-closed",
          { source: "player-controls" },
        );
      }
      runtimeMessage({
        type: "SAVE_SETTINGS",
        settings: { [key]: settings[key] },
      })
        .then(() => showUnifiedControlsStatus("Saved"))
        .catch((error) =>
          showUnifiedControlsStatus(`Could not save: ${error.message}`, true),
        );
    });

    document.addEventListener("pointerdown", (event) => {
      if (!quickPillsMenu.hidden && !quickPillsPanel.contains(event.target)) {
        setQuickPillsMenu(false);
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !quickPillsMenu.hidden) {
        setQuickPillsMenu(false);
        quickPillsPanel.querySelector("#lst-pill-trigger")?.focus();
      }
    });
  }

  function setQuickPillsMenu(open) {
    quickPillsMenu.hidden = !open;
    quickPillsPanel
      .querySelector("#lst-pill-trigger")
      ?.setAttribute("aria-expanded", String(open));
    requestAnimationFrame(positionDebugPanel);
  }

  function positionDebugPanel() {
    if (!debugPanel) return;
    const controlsVisible = quickPillsPanel?.style.display !== "none";
    const top = controlsVisible
      ? Math.round(quickPillsPanel.getBoundingClientRect().bottom + 12)
      : 12;
    debugPanel.style.setProperty("top", `${top}px`, "important");
    debugPanel.style.maxHeight = `max(120px, calc(100vh - ${top + 12}px))`;
  }

  function updateOverlayPanelVisibility() {
    if (!quickPillsPanel) return;
    updateQuickPills();
    requestAnimationFrame(positionDebugPanel);
  }

  function formatMs(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value <= 0) return "—";
    return value < 1000
      ? `${Math.round(value)}ms`
      : `${(value / 1000).toFixed(1)}s`;
  }

  function formatAheadDuration(seconds) {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    if (value < 60) return `${value}s`;
    const minutes = Math.floor(value / 60);
    const remainder = value % 60;
    return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  }

  function shortUrl(url) {
    if (!url) return "—";
    try {
      const parsed = new URL(url);
      return `${parsed.hostname}${parsed.pathname}`.slice(-88);
    } catch {
      return String(url).slice(-88);
    }
  }

  function updateDebugPanel() {
    updateQuickPills();
    if (!debugPanel || !debugPanelBody) return;

    const shouldShow =
      settings.showDebugPanel &&
      (settings.debugPanelAlwaysOnTop ||
        currentStatus.precomputing ||
        currentStatus.lastError);

    debugPanel.style.display = shouldShow ? "block" : "none";
    requestAnimationFrame(positionDebugPanel);
    if (!shouldShow) return;

    const diagnostics = currentStatus.lastDiagnostics || [];
    const latest = diagnostics.length
      ? diagnostics[diagnostics.length - 1]
      : null;

    const lines = [
      `model       ${settings.model || "—"}`,
      `target      ${settings.targetLanguage || "—"}`,
      `context     ${settings.useTranslationContext ? "2 cues before/after" : "off"}`,
      `track       ${currentStatus.cueCount || 0} cues`,
      `episode     ${currentStatus.translatedCount || 0}/${currentStatus.cueCount || 0} (${currentStatus.episodeProgressPercent || 0}%)`,
      `remaining   ${currentStatus.remainingTranslatedCount || 0}/${currentStatus.remainingCueCount || 0} (${currentStatus.progressPercent || 0}%)`,
      `cache ahead ${formatAheadDuration(currentStatus.cachedAheadSeconds)}`,
      `precompute  ${currentStatus.precomputing ? "RUNNING" : "idle"} · batch ${currentStatus.currentBatch || 0}/${currentStatus.totalBatches || 0}`,
      `request     ${currentStatus.requestState || "idle"} · ${formatMs(currentStatus.lastRequestMs)}`,
      `result      ${currentStatus.lastRequestTranslated || 0}/${currentStatus.lastRequestRequested || 0} translated · ${currentStatus.lastRequestFailed || 0} failed`,
      `ollama      ${currentStatus.lastOllamaMode || "—"}`,
      `playback    ${currentStatus.playbackMode || "waiting"}`,
      `video       ${Number(currentStatus.videoTime || 0).toFixed(2)}s`,
      `sync offset ${clamp(settings.subtitleTimingOffsetMs, -2000, 2000, 0)}ms`,
      `track sync  ${timedTrackSyncState} · auto ${automaticCueTimeOffsetSeconds.toFixed(2)}s`,
      `cue         ${currentStatus.activeCueStart == null ? "—" : `${Number(currentStatus.activeCueStart).toFixed(2)}–${Number(currentStatus.activeCueEnd).toFixed(2)}s`}`,
      `in-flight   ${translationCoordinator?.inFlight.size || 0}`,
      `source      ${shortUrl(cueSourceUrl)}`,
    ];

    if (currentStatus.currentText) {
      lines.push(`current     ${truncate(currentStatus.currentText, 135)}`);
    }
    if (currentStatus.lastTranslatedText) {
      lines.push(
        `translated  ${truncate(currentStatus.lastTranslatedText, 135)}`,
      );
    }
    if (latest?.stage) {
      lines.push(`diag stage  ${latest.stage}`);
    }
    if (latest?.idRecovery) {
      lines.push(`id match    ${latest.idRecovery}`);
    }
    if (latest?.returnedIds?.length) {
      lines.push(
        `return ids  ${truncate(latest.returnedIds.join(" | "), 150)}`,
      );
    }
    if (latest?.error) {
      lines.push(`diag error  ${truncate(latest.error, 170)}`);
    }
    if (latest?.rawResponse) {
      lines.push(`raw ollama  ${truncate(latest.rawResponse, 240)}`);
    }
    if (currentStatus.lastError) {
      lines.push(`last error  ${truncate(currentStatus.lastError, 190)}`);
    }

    debugPanelBody.textContent = lines.join("\n");
  }

  function setStatus(message, visible = true) {
    currentStatus.message = message;
    statusMessageRequestedVisible = Boolean(visible && message);
    ensureOverlay();
    statusLine.textContent = message || "";
    statusLine.style.display =
      settings.showStatusMessages && statusMessageRequestedVisible
        ? "block"
        : "none";
    updateDebugPanel();
  }

  function maximumVisibleSubtitles() {
    return Math.round(clamp(settings.maximumVisibleSubtitles, 1, 4, 2));
  }

  function trimRenderedSubtitles() {
    const excess = renderedSubtitles.length - maximumVisibleSubtitles();
    if (excess > 0) {
      const removed = renderedSubtitles.slice(0, excess);
      renderedSubtitles.splice(0, excess);
      logDiagnostic("info", "rendering", "subtitle-stack-trimmed", {
        reason: "maximum-visible-subtitles",
        removedCount: removed.length,
      }, removed.at(-1)?.key);
    }
    if (!renderedSubtitles.some((entry) => entry.key === lastRenderedCueKey)) {
      lastRenderedCueKey = renderedSubtitles.at(-1)?.key || "";
    }
  }

  function renderSubtitleStack() {
    if (!overlay?.isConnected) ensureOverlay();
    if (!subtitleStack) return;

    subtitleStack.replaceChildren();
    for (const subtitle of renderedSubtitles) {
      const entry = document.createElement("div");
      entry.className = "lst-subtitle-entry";

      if (settings.showOriginal && subtitle.original) {
        const original = document.createElement("div");
        original.className = "lst-subtitle-original";
        original.textContent = subtitle.original;
        entry.appendChild(original);
      }

      if (settings.showTranslated && subtitle.translated) {
        const translated = document.createElement("div");
        translated.className = "lst-subtitle-translated";
        translated.textContent = subtitle.translated;
        entry.appendChild(translated);
      }

      if (entry.childElementCount) subtitleStack.appendChild(entry);
    }

    overlay.style.display =
      settings.enabled && subtitleStack.childElementCount ? "block" : "none";
  }

  function removeRenderedSubtitle(key, reason = "unspecified") {
    const next = renderedSubtitles.filter((entry) => entry.key !== key);
    if (next.length === renderedSubtitles.length) return;
    logDiagnostic("info", "rendering", "subtitle-cleared", {
      reason,
      removedCount: renderedSubtitles.length - next.length,
    }, key);
    renderedSubtitles = next;
    if (lastRenderedCueKey === key) {
      lastRenderedCueKey = renderedSubtitles.at(-1)?.key || "";
    }
    renderSubtitleStack();
  }

  function removeRenderedSubtitlesBySource(source, reason = "unspecified") {
    const next = renderedSubtitles.filter((entry) => entry.source !== source);
    if (next.length === renderedSubtitles.length) return;
    logDiagnostic("warning", "rendering", "subtitle-source-cleared", {
      reason,
      source,
      removedCount: renderedSubtitles.length - next.length,
    }, lastRenderedCueKey);
    renderedSubtitles = next;
    if (!renderedSubtitles.some((entry) => entry.key === lastRenderedCueKey)) {
      lastRenderedCueKey = renderedSubtitles.at(-1)?.key || "";
    }
    renderSubtitleStack();
  }

  function clearRenderedSubtitle(reason = "unspecified") {
    if (renderedSubtitles.length) {
      logDiagnostic("warning", "rendering", "subtitle-stack-cleared", {
        reason,
        removedCount: renderedSubtitles.length,
      }, lastRenderedCueKey);
    }
    renderedSubtitles = [];
    lastRenderedCueKey = "";
    renderSubtitleStack();
  }

  function minimumSubtitleDisplaySeconds() {
    return clamp(settings.minimumSubtitleDisplaySeconds, 0, 10, 2);
  }

  function beginRenderedSubtitle({
    key,
    original,
    translated = "",
    naturalEndVideoTime,
    videoTime,
    source,
  }) {
    const now = Number(videoTime);
    const naturalEnd = Number(naturalEndVideoTime);
    if (!Number.isFinite(now)) return;

    // Keep recently ended cues until their configured minimum display time.
    // Cached current cues render synchronously, so retaining the prior cue no
    // longer creates the old-line-only flash at a cue boundary.
    const previous = renderedSubtitles;
    renderedSubtitles = renderedSubtitles.filter(
      (entry) => entry.source === source,
    );
    if (previous.length !== renderedSubtitles.length) {
      logDiagnostic("info", "rendering", "subtitle-source-handoff", {
        from: previous.find((entry) => entry.source !== source)?.source || "unknown",
        to: source,
        removedCount: previous.length - renderedSubtitles.length,
      }, key);
    }
    const existing = renderedSubtitles.find((entry) => entry.key === key);
    const endVideoTime = Number.isFinite(naturalEnd) ? naturalEnd : now;
    const retainUntilVideoTime = Math.max(
      endVideoTime,
      now + minimumSubtitleDisplaySeconds(),
    );

    if (existing) {
      existing.original = original || existing.original;
      existing.translated = translated || existing.translated;
      existing.endVideoTime = endVideoTime;
      existing.retainUntilVideoTime = retainUntilVideoTime;
    } else {
      renderedSubtitles.push({
        key,
        original: original || "",
        translated: translated || "",
        endVideoTime,
        retainUntilVideoTime,
        source,
      });
    }

    lastRenderedCueKey = key;
    trimRenderedSubtitles();
    renderSubtitleStack();
  }

  function updateRenderedSubtitleTranslation(
    key,
    original,
    translated,
    videoTime,
  ) {
    const now = Number(videoTime);
    const entry = renderedSubtitles.find((subtitle) => subtitle.key === key);
    if (!entry || !Number.isFinite(now)) return false;

    entry.original = original || entry.original;
    entry.translated = translated || entry.translated;
    entry.retainUntilVideoTime = Math.max(
      entry.retainUntilVideoTime,
      now + minimumSubtitleDisplaySeconds(),
    );
    renderSubtitleStack();
    return true;
  }

  function shouldRetainRenderedSubtitle(key, videoTime) {
    const now = Number(videoTime);
    const entry = renderedSubtitles.find((subtitle) => subtitle.key === key);
    return Boolean(
      entry &&
      Number.isFinite(now) &&
      now >= entry.endVideoTime &&
      now < entry.retainUntilVideoTime,
    );
  }

  function removeExpiredRenderedSubtitles(videoTime) {
    const now = Number(videoTime);
    if (!Number.isFinite(now)) return;
    const next = renderedSubtitles.filter(
      (entry) => now < entry.retainUntilVideoTime,
    );
    if (next.length === renderedSubtitles.length) return;
    logDiagnostic("info", "rendering", "subtitle-expired", {
      reason: "retention-ended",
      removedCount: renderedSubtitles.length - next.length,
    }, lastRenderedCueKey);
    renderedSubtitles = next;
    if (!renderedSubtitles.some((entry) => entry.key === lastRenderedCueKey)) {
      lastRenderedCueKey = renderedSubtitles.at(-1)?.key || "";
    }
    renderSubtitleStack();
  }

  function findCueAt(time) {
    if (!cues.length) return null;

    let low = 0;
    let high = cues.length - 1;

    while (low <= high) {
      const mid = (low + high) >> 1;
      const cue = cues[mid];

      if (time < cue.start) high = mid - 1;
      else if (time >= cue.end) low = mid + 1;
      else return { cue, index: mid };
    }

    return null;
  }

  function findCueMatchingText(text, expectedTime) {
    let best = null;
    let bestDistance = Infinity;

    for (let index = 0; index < cues.length; index++) {
      const cue = cues[index];
      if (!subtitleTextsMatch(cue.text, text)) continue;
      const distance =
        expectedTime < cue.start
          ? cue.start - expectedTime
          : expectedTime >= cue.end
            ? expectedTime - cue.end
            : 0;
      if (distance < bestDistance) {
        best = { cue, index };
        bestDistance = distance;
      }
    }

    return best;
  }

  function findUniqueCueMatchingSimplifiedText(text) {
    return globalThis.LSTSubtitleSync.findUniqueSimplifiedCue(cues, text);
  }

  function isInterCueGapMatch(match, naturalTime, naturalMatch) {
    return globalThis.LSTSubtitleSync.isInterCueGapMatch(
      cues,
      match,
      naturalTime,
      naturalMatch,
    );
  }

  function cueListContainsText(selectedCues, text) {
    return Boolean(
      text && selectedCues.some((cue) => subtitleTextsMatch(cue.text, text)),
    );
  }

  function cueListSpan(selectedCues) {
    if (!selectedCues.length) return 0;
    return Math.max(
      0,
      Number(selectedCues.at(-1)?.end) - Number(selectedCues[0]?.start),
    );
  }

  function cueTrackSignature(selectedCues) {
    let hash = 2166136261;
    for (const cue of selectedCues) {
      const value = cueKey(cue);
      for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
    }
    return `${selectedCues.length}:${(hash >>> 0).toString(16)}`;
  }

  function naturalSubtitleLookupTime(videoTime) {
    return Number(videoTime) + automaticCueTimeOffsetSeconds;
  }

  function subtitleLookupTime(videoTime) {
    // Positive values delay LST subtitles; negative values show them earlier.
    return (
      naturalSubtitleLookupTime(videoTime) -
      clamp(settings.subtitleTimingOffsetMs, -2000, 2000, 0) / 1000
    );
  }

  function netflixSubtitleDomDiagnostics(netflixText) {
    const selectors = [
      ".player-timedtext",
      '[data-uia="player-subtitle-text"]',
      ".player-timedtext-text-container",
    ];
    const observations = [];
    let chosenSelector = "none";
    for (const selector of selectors) {
      const elements = [...document.querySelectorAll(selector)];
      const lengths = elements.map((element) => {
        const text = normalizeText(element.innerText || element.textContent || "");
        return {
          length: text.length,
          comparableLength: comparableSubtitleText(text).length,
          textId: diagnosticTextId(text),
        };
      });
      if (
        chosenSelector === "none" &&
        lengths.some(({ length }) => length > 0)
      ) {
        chosenSelector = selector;
      }
      observations.push({ selector, nodeCount: elements.length, lengths });
    }
    const nonEmptyTextIds = observations
      .flatMap(({ lengths }) => lengths)
      .filter(({ length }) => length > 0)
      .map(({ textId }) => textId);
    const simplifiedSelected = simplifiedDiagnosticText(netflixText);
    const midpoint = simplifiedSelected.length / 2;
    return {
      chosenSelector,
      selectedTextId: diagnosticTextId(netflixText),
      selectedTextLength: normalizeText(netflixText).length,
      representationCount: new Set(nonEmptyTextIds).size,
      representationsDisagree: new Set(nonEmptyTextIds).size > 1,
      selectedLooksDuplicated: Number.isInteger(midpoint) && midpoint > 0 &&
        simplifiedSelected.slice(0, midpoint) === simplifiedSelected.slice(midpoint),
      observations,
    };
  }

  function timedTrackMismatchDiagnostics(
    video,
    netflixText,
    naturalMatch,
    matchingCue,
    matchQuality,
  ) {
    const simplifiedNetflix = simplifiedDiagnosticText(netflixText);
    const simplifiedMatches = simplifiedNetflix
      ? cues.filter((cue) => simplifiedDiagnosticText(cue.text) === simplifiedNetflix)
      : [];
    let nearbyIndex = naturalMatch?.index ?? cues.findIndex(
      (cue) => cue.start > naturalSubtitleLookupTime(video.currentTime),
    );
    if (nearbyIndex < 0) nearbyIndex = cues.length - 1;
    const nearby = [];
    for (
      let index = Math.max(0, nearbyIndex - 1);
      index <= Math.min(cues.length - 1, nearbyIndex + 1);
      index++
    ) {
      const cue = cues[index];
      nearby.push({
        relation: index === nearbyIndex ? "current" : index < nearbyIndex ? "previous" : "next",
        startMs: Math.round(cue.start * 1000),
        endMs: Math.round(cue.end * 1000),
        textLength: normalizeText(cue.text).length,
        textId: diagnosticTextId(cue.text),
      });
    }
    const nearbySimplified = nearbyIndex >= 0
      ? cues.slice(Math.max(0, nearbyIndex - 1), nearbyIndex + 2)
        .map((cue) => simplifiedDiagnosticText(cue.text))
      : [];
    const combinedNearbyMatch = nearbySimplified.some(
      (value, index) =>
        nearbySimplified[index + 1] &&
        `${value}${nearbySimplified[index + 1]}` === simplifiedNetflix,
    );
    const partialNearbyMatch = Boolean(
      simplifiedNetflix.length >= 4 &&
      nearbySimplified.some(
        (value) => value.includes(simplifiedNetflix) || simplifiedNetflix.includes(value),
      ),
    );
    const naturalTime = naturalSubtitleLookupTime(video.currentTime);
    const nextMatchedCue = matchingCue ? cues[matchingCue.index + 1] : null;

    return {
      ...netflixSubtitleDomDiagnostics(netflixText),
      stableForMs: Math.max(0, Math.round(performance.now() - netflixSubtitleCandidateSince)),
      trackCueCount: cues.length,
      naturalLookupMs: Math.round(naturalTime * 1000),
      userTimingOffsetMs: clamp(settings.subtitleTimingOffsetMs, -2000, 2000, 0),
      automaticTimingOffsetMs: Math.round(automaticCueTimeOffsetSeconds * 1000),
      matchQuality: matchQuality || "none",
      exactTrackMatch: matchQuality === "exact",
      simplifiedTrackMatchCount: simplifiedMatches.length,
      simplifiedMatchCue: simplifiedMatches.length === 1
        ? diagnosticCue(cueKey(simplifiedMatches[0]))
        : "",
      combinedNearbyMatch,
      partialNearbyMatch,
      matchedCue: matchingCue ? diagnosticCue(cueKey(matchingCue.cue)) : "",
      msSinceMatchedCueEnd: matchingCue
        ? Math.round((naturalTime - matchingCue.cue.end) * 1000)
        : null,
      msUntilNextCueStart: nextMatchedCue
        ? Math.round((nextMatchedCue.start - naturalTime) * 1000)
        : null,
      inInterCueGap: isInterCueGapMatch(matchingCue, naturalTime, naturalMatch),
      nearby,
      rendered: renderedSubtitles.map((entry) => ({
        cue: diagnosticCue(entry.key),
        source: entry.source,
        hasTranslation: Boolean(entry.translated),
      })),
    };
  }

  function validateTimedTrackAgainstNetflix(video, netflixText) {
    if (!video || !cues.length) return false;

    const naturalTime = naturalSubtitleLookupTime(video.currentTime);
    const naturalMatch = findCueAt(naturalTime);

    if (!netflixText) {
      if (timedTrackMismatchSince || timedTrackSyncState === "mismatch") {
        logDiagnostic("info", "synchronization", "timed-track-mismatch-ended", {
          mismatchId: activeTimedTrackMismatchId,
          outcome: "netflix-subtitle-gap",
          durationMs: timedTrackMismatchSince
            ? Math.round(performance.now() - timedTrackMismatchSince)
            : null,
          previousReason: lastTimedTrackMismatch || "confirmed-mismatch",
        }, naturalMatch ? cueKey(naturalMatch.cue) : "");
        timedTrackMismatchSince = 0;
        lastTimedTrackMismatch = "";
        activeTimedTrackMismatchId = 0;
        timedTrackSyncState = "verified";
      }
      return timedTrackSyncState === "verified";
    }

    if (
      naturalMatch &&
      subtitleTextsMatch(naturalMatch.cue.text, netflixText)
    ) {
      if (timedTrackMismatchSince || timedTrackSyncState === "mismatch") {
        logDiagnostic("info", "synchronization", "timed-track-mismatch-resolved", {
          mismatchId: activeTimedTrackMismatchId,
          outcome: "exact-match",
          durationMs: timedTrackMismatchSince
            ? Math.round(performance.now() - timedTrackMismatchSince)
            : null,
          previousReason: lastTimedTrackMismatch || "confirmed-mismatch",
          netflixTextId: diagnosticTextId(netflixText),
        }, cueKey(naturalMatch.cue));
      }
      timedTrackSyncState = "verified";
      lastNetflixSyncText = netflixText;
      timedTrackMismatchSince = 0;
      lastTimedTrackMismatch = "";
      activeTimedTrackMismatchId = 0;
      return true;
    }

    const exactMatchingCue = findCueMatchingText(netflixText, naturalTime);
    const simplifiedMatchingCue = exactMatchingCue
      ? null
      : findUniqueCueMatchingSimplifiedText(netflixText);
    const matchingCue = exactMatchingCue || simplifiedMatchingCue;
    const matchQuality = exactMatchingCue
      ? "exact"
      : simplifiedMatchingCue
        ? "simplified-unique"
        : "none";

    if (
      naturalMatch &&
      simplifiedMatchingCue &&
      simplifiedMatchingCue.index === naturalMatch.index
    ) {
      if (timedTrackMismatchSince || timedTrackSyncState === "mismatch") {
        logDiagnostic("info", "synchronization", "timed-track-mismatch-resolved", {
          mismatchId: activeTimedTrackMismatchId,
          outcome: "unique-simplified-current-cue-match",
          durationMs: timedTrackMismatchSince
            ? Math.round(performance.now() - timedTrackMismatchSince)
            : null,
          previousReason: lastTimedTrackMismatch || "confirmed-mismatch",
        }, cueKey(naturalMatch.cue));
      }
      if (!subtitleTextsMatch(lastNetflixSyncText, netflixText)) {
        logDiagnostic("info", "synchronization", "formatting-match-accepted", {
          matchQuality,
          netflixTextLength: normalizeText(netflixText).length,
          capturedTextLength: normalizeText(naturalMatch.cue.text).length,
        }, cueKey(naturalMatch.cue));
      }
      timedTrackSyncState = "verified";
      lastNetflixSyncText = netflixText;
      timedTrackMismatchSince = 0;
      lastTimedTrackMismatch = "";
      activeTimedTrackMismatchId = 0;
      return true;
    }

    if (isInterCueGapMatch(matchingCue, naturalTime, naturalMatch)) {
      timedTrackSyncState = "verified";
      lastNetflixSyncText = netflixText;
      timedTrackMismatchSince = 0;
      lastTimedTrackMismatch = "";
      activeTimedTrackMismatchId = 0;
      return true;
    }

    if (
      matchingCue &&
      timedTrackSyncState === "unverified"
    ) {
      // Captured subtitle fragments can use a timeline starting at zero even when
      // playback began in the middle of an episode. Anchor that timeline to the
      // line Netflix is displaying. A later visible line will refine the anchor.
      automaticCueTimeOffsetSeconds =
        matchingCue.cue.start + 0.04 - Number(video.currentTime);
      timedTrackSyncState = "verified";
      lastNetflixSyncText = netflixText;
      timedTrackMismatchSince = 0;
      lastTimedTrackMismatch = "";
      logDiagnostic("info", "synchronization", "timed-track-anchored", {
        matchQuality,
        automaticOffsetMs: Math.round(automaticCueTimeOffsetSeconds * 1000),
      }, cueKey(matchingCue.cue));
      return true;
    }

    if (timedTrackSyncState === "verified") {
      const mismatch = exactMatchingCue
        ? "known-cue-boundary"
        : simplifiedMatchingCue
          ? "formatting-cue-boundary"
          : "unknown-text";
      const now = performance.now();
      if (!timedTrackMismatchSince || lastTimedTrackMismatch !== mismatch) {
        timedTrackMismatchSince = now;
        lastTimedTrackMismatch = mismatch;
        activeTimedTrackMismatchId = ++timedTrackMismatchSequence;
        logDiagnostic("warning", "synchronization", "timed-track-mismatch-started", {
          mismatchId: activeTimedTrackMismatchId,
          reason: mismatch,
          graceMs: TIMED_TRACK_MISMATCH_GRACE_MS,
          ...timedTrackMismatchDiagnostics(
            video,
            netflixText,
            naturalMatch,
            matchingCue,
            matchQuality,
          ),
        }, naturalMatch ? cueKey(naturalMatch.cue) : "");
      }
      if (now - timedTrackMismatchSince < TIMED_TRACK_MISMATCH_GRACE_MS) {
        return true;
      }

      const cueDistance = matchingCue && naturalMatch
        ? Math.abs(matchingCue.index - naturalMatch.index)
        : Infinity;
      const offsetErrorSeconds = matchingCue
        ? matchingCue.cue.start - naturalTime
        : 0;
      if (
        matchingCue &&
        cueDistance > 1 &&
        Math.abs(offsetErrorSeconds) > 2
      ) {
        const mismatchReason = lastTimedTrackMismatch;
        const mismatchDurationMs = Math.round(now - timedTrackMismatchSince);
        const mismatchId = activeTimedTrackMismatchId;
        automaticCueTimeOffsetSeconds =
          matchingCue.cue.start + 0.04 - Number(video.currentTime);
        timedTrackMismatchSince = 0;
        lastTimedTrackMismatch = "";
        activeTimedTrackMismatchId = 0;
        lastNetflixSyncText = netflixText;
        logDiagnostic("warning", "synchronization", "timed-track-reanchored", {
          reason: mismatchReason,
          mismatchId,
          durationMs: mismatchDurationMs,
          automaticOffsetMs: Math.round(automaticCueTimeOffsetSeconds * 1000),
          cueDistance: Number.isFinite(cueDistance) ? cueDistance : null,
          matchQuality,
        }, cueKey(matchingCue.cue));
        return true;
      }
    }

    if (timedTrackSyncState !== "mismatch") {
      logDiagnostic("warning", "synchronization", "timed-track-mismatch-confirmed", {
        mismatchId: activeTimedTrackMismatchId,
        reason: exactMatchingCue
          ? "known-cue-boundary"
          : simplifiedMatchingCue
            ? "formatting-cue-boundary"
            : "unknown-text",
        retainedTimedSubtitle: true,
        durationMs: timedTrackMismatchSince
          ? Math.round(performance.now() - timedTrackMismatchSince)
          : null,
        ...timedTrackMismatchDiagnostics(
          video,
          netflixText,
          naturalMatch,
          matchingCue,
          matchQuality,
        ),
      }, naturalMatch ? cueKey(naturalMatch.cue) : "");
    }
    timedTrackSyncState = "mismatch";
    lastNetflixSyncText = netflixText;
    return false;
  }

  function isTimedCueStillCurrent(key) {
    const video = document.querySelector("video");
    if (!video || !renderedSubtitles.some((entry) => entry.key === key))
      return false;
    const match = findCueAt(subtitleLookupTime(video.currentTime));
    return Boolean(
      (match && cueKey(match.cue) === key) ||
      shouldRetainRenderedSubtitle(key, video.currentTime),
    );
  }

  async function getCachedTranslations(
    selectedCues,
    requestedCacheId = cacheId(),
  ) {
    const keys = selectedCues.map(cueKey);
    if (!keys.length) return {};

    const response = await runtimeMessage({
      type: "CACHE_GET",
      cacheId: requestedCacheId,
      keys,
    });

    const entries = response.entries || {};
    if (requestedCacheId === cacheId()) rememberCachedEntries(entries);
    return entries;
  }

  function rememberCachedEntries(entries) {
    let renderedChanged = false;
    const videoTime = Number(document.querySelector("video")?.currentTime);
    for (const [key, translation] of Object.entries(entries || {})) {
      knownCachedKeys.add(key);
      if (!translation) continue;
      knownCachedTranslations.set(key, translation);
      const rendered = renderedSubtitles.find((entry) => entry.key === key);
      if (rendered && rendered.translated !== translation) {
        rendered.translated = translation;
        if (Number.isFinite(videoTime)) {
          rendered.retainUntilVideoTime = Math.max(
            rendered.retainUntilVideoTime,
            videoTime + minimumSubtitleDisplaySeconds(),
          );
        }
        renderedChanged = true;
        logDiagnostic("info", "translation", "translation-attached", {
          source: "shared-result",
          translationLength: String(translation).length,
        }, key);
      }
    }
    if (renderedChanged) renderSubtitleStack();
    updateTranscriptTranslations(entries);
    refreshCacheCoverage();
  }

  function refreshCacheCoverage(videoTime) {
    currentStatus.translatedCount = cues.reduce(
      (count, cue) => count + (knownCachedKeys.has(cueKey(cue)) ? 1 : 0),
      0,
    );

    const video = document.querySelector("video");
    const rawTime = Number.isFinite(Number(videoTime))
      ? Number(videoTime)
      : Number(video?.currentTime);
    if (!Number.isFinite(rawTime) || !cues.length) {
      currentStatus.cachedAheadSeconds = 0;
      updateProgress(rawTime);
      return;
    }

    const time = subtitleLookupTime(rawTime);
    updateProgress(rawTime);
    let coveredUntil = time;
    for (const cue of cues) {
      if (cue.end <= time) continue;
      if (!knownCachedKeys.has(cueKey(cue))) break;
      coveredUntil = Math.max(coveredUntil, cue.end);
    }
    currentStatus.cachedAheadSeconds = Math.max(0, coveredUntil - time);
  }

  function surroundingTranslationContext(selectedCues) {
    if (!settings.useTranslationContext || !cues.length || !selectedCues.length) {
      return [];
    }

    const cueIndexes = new Map(cues.map((cue, index) => [cueKey(cue), index]));
    const targetIndexes = selectedCues
      .map((cue) => cueIndexes.get(cueKey(cue)))
      .filter(Number.isInteger)
      .sort((left, right) => left - right);
    if (!targetIndexes.length) return [];

    const targetSet = new Set(targetIndexes);
    const first = targetIndexes[0];
    const last = targetIndexes.at(-1);
    const candidates = cues
      .map((cue, index) => ({ cue, index }))
      .filter(({ index }) => !targetSet.has(index))
      .map(({ cue, index }) => ({
        cue,
        index,
        distance: Math.min(...targetIndexes.map((target) => Math.abs(target - index))),
      }))
      .filter(({ distance }) => distance <= 2)
      .sort((left, right) => left.distance - right.distance || left.index - right.index)
      .slice(0, 12)
      .sort((left, right) => left.index - right.index);

    return candidates.map(({ cue, index }) => ({
      position: index < first ? "before" : index > last ? "after" : "between",
      startMs: Math.round(cue.start * 1000),
      text: cue.text,
    }));
  }

  async function translateOwnedCues(selectedCues) {
    const deduped = [];
    const seen = new Set();

    for (const cue of selectedCues) {
      const key = cueKey(cue);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(cue);
    }

    if (!deduped.length) {
      return { entries: {}, failures: [] };
    }

    // Keep an in-flight request tied to the episode/track that started it. A
    // Netflix navigation must not write late results into the next episode.
    const requestedCacheId = cacheId();
    const requestedCacheMetadata = cacheMetadata();
    const cached = await getCachedTranslations(deduped, requestedCacheId);
    const missing = deduped.filter(
      (cue) => !Object.prototype.hasOwnProperty.call(cached, cueKey(cue)),
    );

    if (!missing.length) {
      logDiagnostic("info", "translation", "translation-cache-hit", {
        count: deduped.length,
      }, cueKey(deduped[0]));
      return { entries: cached, failures: [] };
    }

    try {
      currentStatus.requestState = "running";
      currentStatus.lastRequestRequested = missing.length;
      currentStatus.lastRequestTranslated = 0;
      currentStatus.lastRequestFailed = 0;
      updateDebugPanel();

      const requestStartedAt = Date.now();
      const contextItems = surroundingTranslationContext(missing);
      logDiagnostic("info", "translation", "translation-request-started", {
        count: missing.length,
        source: precomputeInProgress ? "precompute" : "playback",
        contextCueCount: contextItems.length,
      }, cueKey(missing[0]));
      const response = await runtimeMessage({
        type: "TRANSLATE_BATCH",
        provider: settings.provider,
        model: settings.model,
        targetLanguage: settings.targetLanguage,
        requestTimeoutSeconds: settings.requestTimeoutSeconds,
        items: missing.map((cue) => ({
          id: cueKey(cue),
          text: cue.text,
        })),
        contextItems,
      });

      currentStatus.requestState = "done";
      currentStatus.lastRequestMs =
        response.summary?.elapsedMs || Date.now() - requestStartedAt;
      currentStatus.lastRequestRequested =
        response.summary?.requested ?? missing.length;
      currentStatus.lastRequestTranslated =
        response.summary?.translated ?? (response.translations || []).length;
      currentStatus.lastRequestFailed =
        response.summary?.failed ?? (response.failures || []).length;
      logDiagnostic(
        currentStatus.lastRequestFailed ? "warning" : "info",
        "translation",
        "translation-request-completed",
        {
          requested: currentStatus.lastRequestRequested,
          translated: currentStatus.lastRequestTranslated,
          failed: currentStatus.lastRequestFailed,
          elapsedMs: currentStatus.lastRequestMs,
        },
        cueKey(missing[0]),
      );
      currentStatus.lastDiagnostics = response.diagnostics || [];

      const latestDiag = currentStatus.lastDiagnostics.length
        ? currentStatus.lastDiagnostics[
            currentStatus.lastDiagnostics.length - 1
          ]
        : null;

      currentStatus.lastOllamaMode = latestDiag?.idRecovery
        ? `${latestDiag.mode || "structured"} / ${latestDiag.idRecovery}`
        : latestDiag?.mode || latestDiag?.stage || "";

      currentStatus.lastOllamaRaw = latestDiag?.rawResponse || "";
      updateDebugPanel();

      const newEntries = {};
      for (const entry of response.translations || []) {
        if (entry.text) newEntries[entry.id] = entry.text;
      }
      const persistedEntries =
        requestedCacheId === cacheId()
          ? promoteFallbackEntries(newEntries)
          : newEntries;
      if (requestedCacheId === cacheId()) rememberCachedEntries(persistedEntries);

      if (Object.keys(persistedEntries).length) {
        await runtimeMessage({
          type: "CACHE_SET",
          cacheId: requestedCacheId,
          entries: persistedEntries,
          metadata: requestedCacheMetadata,
        });
      }

      return {
        entries: { ...cached, ...newEntries },
        failures: response.failures || [],
      };
    } catch (error) {
      currentStatus.requestState = "error";
      currentStatus.lastError = error.message;
      if (error?.diagnostics) {
        currentStatus.lastDiagnostics = [
          {
            stage: "extension-request-error",
            ...error.diagnostics,
          },
        ];
      }
      updateDebugPanel();
      logDiagnostic("error", "translation", "translation-request-failed", {
        error: error.message,
        count: missing.length,
      }, cueKey(missing[0]));
      throw error;
    } finally {
      updateDebugPanel();
    }
  }

  function getTranslationCoordinator() {
    if (!translationCoordinator) {
      translationCoordinator = new globalThis.LSTTranslationCoordinator({
        keyFor: cueKey,
        runBatch: translateOwnedCues,
        onEvent(event, details) {
          const { key = "", ...safeDetails } = details;
          logDiagnostic("info", "translation", event, safeDetails, key);
        },
      });
    }
    return translationCoordinator;
  }

  function translateCues(selectedCues) {
    return getTranslationCoordinator().translate(selectedCues);
  }

  async function ensureCueTranslated(cue, index) {
    if (!cue || !settings.model) return;

    const key = cueKey(cue);
    logDiagnostic("info", "translation", "active-cue-translation-requested", {
      cueStartMs: Math.round(cue.start * 1000),
      cueEndMs: Math.round(cue.end * 1000),
      textLength: normalizeText(cue.text).length,
    }, key);
    const cached = await getCachedTranslations([cue]);

    if (cached[key]) {
      currentStatus.playbackMode = "timed-text cache";
      currentStatus.lastTranslatedText = truncate(cached[key]);
      if (isTimedCueStillCurrent(key)) {
        updateRenderedSubtitleTranslation(
          key,
          cue.text,
          cached[key],
          document.querySelector("video")?.currentTime,
        );
      } else {
        logDiagnostic("warning", "translation", "translation-not-rendered", {
          reason: "cue-no-longer-current",
          source: "cache",
        }, key);
      }
    } else {
      const currentResult = await translateCues([cue]);
      if (currentResult.entries[key]) {
        currentStatus.playbackMode = "timed-text realtime";
        currentStatus.lastTranslatedText = truncate(currentResult.entries[key]);
        if (isTimedCueStillCurrent(key)) {
          updateRenderedSubtitleTranslation(
            key,
            cue.text,
            currentResult.entries[key],
            document.querySelector("video")?.currentTime,
          );
        } else {
          logDiagnostic("warning", "translation", "translation-not-rendered", {
            reason: "cue-no-longer-current",
            source: "realtime",
          }, key);
        }
      }
    }

    if (settings.autoTranslateAhead && cues.length) {
      maintainLookAhead(cue, index).catch((error) => {
        console.warn("[LST] Look-ahead translation failed:", error);
        setStatus(
          `Could not maintain the translation buffer: ${error.message}`,
          true,
        );
      });
    }
  }

  async function maintainLookAhead(currentCue, index) {
    const generation = cacheGeneration;
    const seconds = Math.max(30, Number(settings.lookAheadSeconds) || 30);
    const playbackTime = Number(document.querySelector("video")?.currentTime);
    const deadline =
      Math.max(
        currentCue.start,
        Number.isFinite(playbackTime) ? playbackTime : currentCue.start,
      ) + seconds;
    const ahead = [];

    for (const cue of cues.slice(index + 1)) {
      const key = cueKey(cue);
      if (!lookAheadQueued.has(key)) {
        lookAheadQueued.add(key);
        ahead.push(cue);
      }
      // Include the first cue beyond the time boundary so a long silent gap
      // cannot leave the next spoken line untranslated.
      if (cue.start > deadline) break;
    }

    if (!ahead.length) return;
    if (!lookAheadNoticeShown) {
      lookAheadNoticeShown = true;
      setStatus(
        `Preparing translations at least ${seconds} seconds ahead…`,
        true,
      );
    }

    const batchSize = Math.max(1, Number(settings.batchSize) || 8);
    let failed = 0;
    try {
      for (let i = 0; i < ahead.length; i += batchSize) {
        if (generation !== cacheGeneration || !playbackActive || !isWatchPage()) return;
        const result = await translateCues(ahead.slice(i, i + batchSize));
        failed += result.failures.length;
      }
      if (failed) {
        setStatus(
          `${failed} upcoming subtitle${failed === 1 ? "" : "s"} could not be prepared.`,
          true,
        );
      } else if (!lookAheadReadyNoticeShown) {
        lookAheadReadyNoticeShown = true;
        setStatus(
          `Translation buffer ready at least ${seconds} seconds ahead.`,
          true,
        );
      }
    } finally {
      for (const cue of ahead) lookAheadQueued.delete(cueKey(cue));
      updateQuickPills();
    }
  }

  function startPausedCaching(video) {
    if (
      pausedCachingPromise ||
      !settings.cacheWhilePaused ||
      !settings.model ||
      !cues.length ||
      precomputeInProgress
    )
      return;

    pausedCachingPromise = runPausedCaching(video).finally(() => {
      pausedCachingPromise = null;
      refreshCacheCoverage(video.currentTime);
      updateQuickPills();
    });
    updateQuickPills();
  }

  async function runPausedCaching(video) {
    const generation = cacheGeneration;
    if (!pausedCacheNoticeShown) {
      pausedCacheNoticeShown = true;
      setStatus(
        "Paused — building more of this episode's translation cache…",
        true,
      );
    }

    while (
      generation === cacheGeneration &&
      playbackActive &&
      isWatchPage() &&
      video.paused &&
      settings.cacheWhilePaused &&
      !precomputeInProgress
    ) {
      const playbackTime = subtitleLookupTime(video.currentTime);
      const remaining = cues.filter(
        (cue) =>
          cue.end > playbackTime &&
          !knownCachedKeys.has(cueKey(cue)) &&
          !pausedCacheFailedKeys.has(cueKey(cue)),
      );

      if (!remaining.length) {
        if (!pausedCacheCompleteNoticeShown) {
          pausedCacheCompleteNoticeShown = true;
          setStatus(
            "Paused cache complete from the current position to the end.",
            true,
          );
        }
        return;
      }

      const available = remaining.filter(
        (cue) =>
          !getTranslationCoordinator().has(cueKey(cue)) &&
          !lookAheadQueued.has(cueKey(cue)),
      );
      if (!available.length) return;

      const batchSize = Math.max(1, Number(settings.batchSize) || 8);
      const batch = available.slice(0, batchSize);
      const result = await translateCues(batch);
      for (const failure of result.failures) {
        if (failure.id) pausedCacheFailedKeys.add(failure.id);
      }

      refreshCacheCoverage(video.currentTime);
      setStatus(
        `Paused cache · ${formatAheadDuration(currentStatus.cachedAheadSeconds)} ahead · ` +
          `${currentStatus.remainingTranslatedCount}/` +
          `${currentStatus.remainingCueCount} remaining cues`,
        true,
      );
    }
  }

  async function playbackLoop() {
    if (!playbackActive || !isWatchPage()) return;
    ensureOverlay();

    if (Date.now() - lastTitleMetadataRefreshAt >= 2000) {
      lastTitleMetadataRefreshAt = Date.now();
      netflixTitleMetadata();
      persistImprovedCacheMetadata();
    }

    const video = document.querySelector("video");
    if (!video || !settings.enabled) {
      requestAnimationFrame(playbackLoop);
      return;
    }

    if (cueVideoId && cueVideoId !== getVideoId()) {
      cacheGeneration++;
      precomputeCancelled = true;
      cues = [];
      cueSourceUrl = "";
      cueVideoId = getVideoId();
      translationCoordinator = null;
      knownCachedKeys = new Set();
      knownCachedTranslations = new Map();
      pausedCacheFailedKeys = new Set();
      lookAheadQueued = new Set();
      lookAheadNoticeShown = false;
      lookAheadReadyNoticeShown = false;
      pausedCacheNoticeShown = false;
      pausedCacheCompleteNoticeShown = false;
      lastPlaybackWasPaused = false;
      timedTrackSyncState = "unverified";
      automaticCueTimeOffsetSeconds = 0;
      lastNetflixSyncText = "";
      timedTrackMismatchSince = 0;
      lastTimedTrackMismatch = "";
      timedTrackMismatchSequence = 0;
      activeTimedTrackMismatchId = 0;
      lastFallbackText = "";
      netflixSubtitleCandidate = "";
      netflixSubtitleCandidateSince = 0;
      diagnosticTextIds = new Map();
      nextDiagnosticTextId = 1;
      currentStatus.captured = false;
      currentStatus.cueCount = 0;
      currentStatus.translatedCount = 0;
      currentStatus.remainingCueCount = 0;
      currentStatus.remainingTranslatedCount = 0;
      currentStatus.episodeProgressPercent = 0;
      currentStatus.progressPercent = 0;
      currentStatus.activeCueStart = null;
      currentStatus.activeCueEnd = null;
      currentStatus.playbackMode = "waiting";
      clearRenderedSubtitle("episode-changed");
      renderTranscript();
      logDiagnostic("info", "track", "episode-changed", {});
      setStatus("Episode changed — waiting for its subtitle track…", true);
      handleFallbackRenderedSubtitle();
      requestAnimationFrame(playbackLoop);
      return;
    }

    if (!cues.length) {
      requestAnimationFrame(playbackLoop);
      return;
    }

    if (video.paused) {
      if (!lastPlaybackWasPaused) {
        pausedCacheNoticeShown = false;
        pausedCacheCompleteNoticeShown = false;
      }
      lastPlaybackWasPaused = true;
      startPausedCaching(video);
    } else if (lastPlaybackWasPaused) {
      lastPlaybackWasPaused = false;
      refreshCacheCoverage(video.currentTime);
      if (pausedCacheNoticeShown) {
        setStatus(
          `Playback resumed · ${formatAheadDuration(currentStatus.cachedAheadSeconds)} cached ahead.`,
          true,
        );
      }
    }

    currentStatus.videoTime = video.currentTime;
    const netflixObservation = observeNetflixRenderedSubtitle();
    const netflixText = netflixObservation.text;
    if (
      !netflixObservation.stable &&
      timedTrackSyncState !== "verified"
    ) {
      currentStatus.playbackMode = "waiting for stable Netflix subtitle";
      updateDebugPanel();
      requestAnimationFrame(playbackLoop);
      return;
    }
    if (
      netflixObservation.stable &&
      !validateTimedTrackAgainstNetflix(video, netflixText)
    ) {
      currentStatus.activeCueStart = null;
      currentStatus.activeCueEnd = null;
      currentStatus.playbackMode = netflixText
        ? "DOM fallback (unverified timed track)"
        : "waiting for subtitle sync";
      updateDebugPanel();
      focusTranscriptCue(findCueMatchingText(netflixText, subtitleLookupTime(video.currentTime)));
      if (netflixText) handleFallbackRenderedSubtitle();
      requestAnimationFrame(playbackLoop);
      return;
    }

    const lookupTime = subtitleLookupTime(video.currentTime);
    const match = findCueAt(lookupTime);

    if (!match) {
      if (!noTimedCueSince) noTimedCueSince = performance.now();
      currentStatus.activeCueStart = null;
      currentStatus.activeCueEnd = null;
      updateDebugPanel();
      focusTranscriptCue(null);
      // Give the DOM fallback a short handoff window, then clear a stale line
      // when Netflix is also between subtitles.
      if (
        lastRenderedCueKey &&
        !shouldRetainRenderedSubtitle(lastRenderedCueKey, video.currentTime) &&
        performance.now() - noTimedCueSince > 220 &&
        !findNetflixRenderedSubtitle()
      ) {
        removeExpiredRenderedSubtitles(video.currentTime);
      }
      requestAnimationFrame(playbackLoop);
      return;
    }

    noTimedCueSince = 0;
    currentStatus.activeCueStart = match.cue.start;
    currentStatus.activeCueEnd = match.cue.end;
    focusTranscriptCue(match);
    updateDebugPanel();
    const key = cueKey(match.cue);
    removeExpiredRenderedSubtitles(video.currentTime);

    if (key !== lastRenderedCueKey) {
      const timingOffsetSeconds =
        clamp(settings.subtitleTimingOffsetMs, -2000, 2000, 0) / 1000;
      const cachedTranslation = knownCachedTranslations.get(key) || "";
      beginRenderedSubtitle({
        key,
        original: match.cue.text,
        translated: cachedTranslation,
        naturalEndVideoTime:
          match.cue.end -
          automaticCueTimeOffsetSeconds +
          timingOffsetSeconds,
        videoTime: video.currentTime,
        source: "timed",
      });
      currentStatus.playbackMode = cachedTranslation
        ? "timed-text cache"
        : "timed-text pending";
      if (cachedTranslation) {
        currentStatus.lastTranslatedText = truncate(cachedTranslation);
      }

      ensureCueTranslated(match.cue, match.index).catch((error) => {
        currentStatus.lastError = error.message;
        setStatus(`Translation error: ${error.message}`, true);
      });
    }

    requestAnimationFrame(playbackLoop);
  }

  function findNetflixRenderedSubtitle() {
    const candidates = [
      document.querySelector(".player-timedtext"),
      document.querySelector('[data-uia="player-subtitle-text"]'),
      document.querySelector(".player-timedtext-text-container"),
    ].filter(Boolean);

    for (const container of candidates) {
      const text = normalizeText(
        container.innerText || container.textContent || "",
      );
      if (text) return text;
    }

    return "";
  }

  function observeNetflixRenderedSubtitle() {
    const text = findNetflixRenderedSubtitle();
    const now = performance.now();
    if (text !== netflixSubtitleCandidate) {
      netflixSubtitleCandidate = text;
      netflixSubtitleCandidateSince = now;
    }
    return {
      text,
      stable:
        now - netflixSubtitleCandidateSince >=
        NETFLIX_SUBTITLE_STABILITY_MS,
    };
  }

  async function handleFallbackRenderedSubtitle() {
    if (!playbackActive || !isWatchPage() || !settings.enabled || !settings.model) return;
    const generation = playbackGeneration;

    const observation = observeNetflixRenderedSubtitle();
    const text = observation.text;
    if (!observation.stable) {
      clearTimeout(fallbackTimer);
      fallbackTimer = setTimeout(
        handleFallbackRenderedSubtitle,
        NETFLIX_SUBTITLE_STABILITY_MS,
      );
      return;
    }
    if (!text) {
      if (
        lastFallbackText &&
        String(currentStatus.playbackMode).startsWith("DOM")
      ) {
        const video = document.querySelector("video");
        const fallbackKey = cueKey(fallbackCueForText(lastFallbackText));
        if (shouldRetainRenderedSubtitle(fallbackKey, video?.currentTime))
          return;
        lastFallbackText = "";
        removeRenderedSubtitle(fallbackKey, "netflix-subtitle-ended");
      }
      return;
    }
    if (text === lastFallbackText) return;

    const video = document.querySelector("video");
    // Only let timed text take over after its underlying line has been checked
    // against Netflix. This also respects a user timing offset, which may make
    // the intentionally rendered LST cue differ from Netflix's current cue.
    if (
      video &&
      timedTrackSyncState !== "mismatch" &&
      validateTimedTrackAgainstNetflix(video, text)
    ) {
      return;
    }

    lastFallbackText = text;
    const fallbackCue = fallbackCueForText(text);
    const key = cueKey(fallbackCue);

    try {
      const result = await translateCues([fallbackCue]);
      if (generation !== playbackGeneration || !playbackActive || !isWatchPage()) return;
      const translated = result.entries[key] || "";

      if (translated && lastFallbackText === text) {
        currentStatus.playbackMode = cues.length
          ? "DOM fallback (timing mismatch)"
          : "DOM realtime";
        currentStatus.lastTranslatedText = truncate(translated);
        const videoTime = document.querySelector("video")?.currentTime;
        beginRenderedSubtitle({
          key,
          original: text,
          translated,
          naturalEndVideoTime: videoTime,
          videoTime,
          source: "dom",
        });

        if (!precomputeInProgress) {
          setStatus(
            cues.length
              ? "Using visible-subtitle fallback while the captured track is out of sync."
              : "Realtime DOM mode — waiting to capture a full subtitle track.",
            true,
          );
        }
      }

      if (result.failures.length) {
        currentStatus.lastError =
          result.failures[0].error || "Realtime translation failed";
      }
    } catch (error) {
      if (generation !== playbackGeneration || !playbackActive || !isWatchPage()) return;
      currentStatus.lastError = error.message;
      setStatus(`Realtime translation error: ${error.message}`, true);
    }
  }

  function startFallbackObserver() {
    const observer = new MutationObserver(() => {
      if (!playbackActive || !isWatchPage()) return;
      clearTimeout(fallbackTimer);
      fallbackTimer = setTimeout(handleFallbackRenderedSubtitle, 40);
    });

    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
    });

    // Netflix sometimes updates subtitle layout without a useful mutation on the
    // exact text node we observed. This lightweight poll keeps the fallback honest.
    const interval = setInterval(handleFallbackRenderedSubtitle, 350);
    return () => {
      observer.disconnect();
      clearInterval(interval);
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    };
  }

  async function acceptSubtitleDocument(url, text) {
    if (!playbackActive || !isWatchPage()) return;
    const generation = playbackGeneration;
    const parsed = parseSubtitleDocument(text);
    if (!parsed.length) return;

    parsed.sort((a, b) => a.start - b.start);

    const signature = cueTrackSignature(parsed);
    const currentSignature = cueTrackSignature(cues);

    if (signature === currentSignature) {
      logDiagnostic("info", "track", "equivalent-subtitle-track-ignored", {
        cueCount: parsed.length,
      });
      return;
    }

    const sameVideo = cueVideoId === getVideoId();
    if (sameVideo && cues.length) {
      const netflixText = findNetflixRenderedSubtitle();
      const currentMatchesNetflix = cueListContainsText(cues, netflixText);
      const parsedMatchesNetflix = cueListContainsText(parsed, netflixText);
      const looksLikeFragment =
        parsed.length < Math.max(10, cues.length * 0.5) &&
        cueListSpan(parsed) < cueListSpan(cues) * 0.5;

      // Netflix may fetch short timed-text fragments, metadata XML, or another
      // subtitle representation while an episode is playing. Never let one of
      // those displace the full/verified track whose cue keys back the cache.
      if (
        looksLikeFragment ||
        (timedTrackSyncState === "verified" && !parsedMatchesNetflix) ||
        (currentMatchesNetflix && !parsedMatchesNetflix)
      ) {
        return;
      }
    }

    cues = parsed;
    cueSourceUrl = url || "captured";
    cueVideoId = getVideoId();
    timedTrackSyncState = "unverified";
    automaticCueTimeOffsetSeconds = 0;
    lastNetflixSyncText = "";
    timedTrackMismatchSince = 0;
    lastTimedTrackMismatch = "";
    activeTimedTrackMismatchId = 0;
    translationCoordinator = null;
    removeRenderedSubtitlesBySource("timed", "new-subtitle-track");
    knownCachedKeys = new Set();
    knownCachedTranslations = new Map();
    pausedCacheFailedKeys = new Set();
    renderTranscript();

    currentStatus.captured = true;
    currentStatus.cueCount = cues.length;
    logDiagnostic("info", "track", "subtitle-track-accepted", {
      cueCount: cues.length,
      firstCueStartMs: Math.round((cues[0]?.start || 0) * 1000),
      lastCueEndMs: Math.round((cues.at(-1)?.end || 0) * 1000),
    });

    try {
      await runtimeMessage({
        type: "CACHE_RECONCILE_FALLBACK",
        cacheId: cacheId(),
        timedCues: cues.map((cue) => ({
          key: cueKey(cue),
          sourceText: cue.text,
        })),
        metadata: cacheMetadata(),
      });
    } catch (error) {
      console.warn("[LST] Could not reconcile fallback translations:", error);
    }
    if (generation !== playbackGeneration || !playbackActive || !isWatchPage()) return;

    const allCached = await getCachedTranslations(cues);
    if (generation !== playbackGeneration || !playbackActive || !isWatchPage()) return;
    currentStatus.translatedCount = Object.keys(allCached).length;
    updateProgress();

    setStatus(
      `Captured ${cues.length} subtitle cues · ` +
        `${currentStatus.remainingTranslatedCount}/` +
        `${currentStatus.remainingCueCount} remaining cues cached.`,
      true,
    );
  }

  async function precomputeAll() {
    if (precomputeInProgress) return;
    if (!settings.model) {
      throw new Error("Choose a translation model in extension settings first.");
    }
    if (!cues.length) {
      throw new Error(
        "No full subtitle track captured yet. Turn on a Netflix subtitle track, then retry.",
      );
    }

    precomputeInProgress = true;
    precomputeCancelled = false;

    currentStatus.precomputing = true;
    currentStatus.failedCount = 0;
    currentStatus.lastError = "";
    currentStatus.jobStartedAt = Date.now();

    try {
      const cached = await getCachedTranslations(cues);
      currentStatus.translatedCount = Object.keys(cached).length;

      const videoTime = Number(document.querySelector("video")?.currentTime);
      const precomputeStartTime = Number.isFinite(videoTime)
        ? subtitleLookupTime(videoTime)
        : -Infinity;
      const remainingCues = cues.filter((cue) => cue.end > precomputeStartTime);

      const missing = remainingCues.filter(
        (cue) => !Object.prototype.hasOwnProperty.call(cached, cueKey(cue)),
      );

      const batchSize = Math.max(1, Number(settings.batchSize) || 16);
      currentStatus.totalBatches = Math.ceil(missing.length / batchSize);
      currentStatus.currentBatch = 0;
      updateProgress();

      if (!missing.length) {
        setStatus(
          currentStatus.translatedCount >= cues.length
            ? `Precompute already complete: ${cues.length}/${cues.length} cached.`
            : "All remaining subtitles are already cached from the current position.",
          true,
        );
        return;
      }

      for (let i = 0; i < missing.length; i += batchSize) {
        if (precomputeCancelled) {
          setStatus(
            `Precompute stopped with ${currentStatus.remainingTranslatedCount}/` +
              `${currentStatus.remainingCueCount} remaining cues cached.`,
            true,
          );
          return;
        }

        const batch = missing.slice(i, i + batchSize);
        const batchNumber = Math.floor(i / batchSize) + 1;

        currentStatus.currentBatch = batchNumber;
        currentStatus.currentRangeStart = i + 1;
        currentStatus.currentRangeEnd = i + batch.length;
        currentStatus.currentText = truncate(
          batch.map((cue) => cue.text).join("  •  "),
          260,
        );
        currentStatus.batchStartedAt = Date.now();

        setStatus(
          `Precompute ${currentStatus.progressPercent}% of remaining subtitles · ` +
            `${currentStatus.remainingTranslatedCount}/` +
            `${currentStatus.remainingCueCount} ahead cached · ` +
            `batch ${batchNumber}/${currentStatus.totalBatches}\n` +
            `${currentStatus.currentText}`,
          true,
        );

        const result = await translateCues(batch);

        // translateCues records successful keys in knownCachedKeys. Recount from
        // that set so progress cannot double-count the just-finished batch.
        refreshCacheCoverage(document.querySelector("video")?.currentTime);
        currentStatus.failedCount += result.failures.length;

        if (result.failures.length) {
          currentStatus.lastError =
            result.failures[0].error || "One or more cues failed";
        }

        const lastSuccess = [...batch]
          .reverse()
          .find((cue) => result.entries[cueKey(cue)]);

        if (lastSuccess) {
          currentStatus.lastTranslatedText = truncate(
            result.entries[cueKey(lastSuccess)],
            180,
          );
        }

        updateProgress();
      }

      // Recount cache at the end, so retries/realtime work that happened while
      // precomputing are reflected exactly.
      const finalCache = await getCachedTranslations(cues);
      currentStatus.translatedCount = Object.keys(finalCache).length;
      updateProgress();

      if (currentStatus.failedCount) {
        setStatus(
          `Precompute finished at ${currentStatus.progressPercent}% of remaining subtitles · ` +
            `${currentStatus.remainingTranslatedCount}/` +
            `${currentStatus.remainingCueCount} ahead cached · ` +
            `${currentStatus.failedCount} failed.`,
          true,
        );
      } else {
        setStatus(
          currentStatus.translatedCount >= cues.length
            ? `Precompute complete: ${cues.length}/${cues.length} cues cached locally.`
            : "Remaining subtitles are cached from the current playback position.",
          true,
        );
      }
    } catch (error) {
      currentStatus.lastError = error.message;
      setStatus(`Precompute error: ${error.message}`, true);
      throw error;
    } finally {
      precomputeInProgress = false;
      currentStatus.precomputing = false;
      currentStatus.batchStartedAt = 0;
      currentStatus.currentText = "";
      updateQuickPills();
    }
  }

  function startPrecomputeDetached() {
    if (!playbackActive || !isWatchPage()) {
      throw new Error("Open a Netflix watch page first.");
    }
    if (precomputeInProgress) {
      return { started: false, alreadyRunning: true };
    }

    // Important: the popup only starts the job. It does not own the Promise.
    // Closing the popup therefore cannot cancel precompute.
    precomputePromise = precomputeAll()
      .catch((error) => {
        console.error("[LST] Detached precompute failed:", error);
      })
      .finally(() => {
        precomputePromise = null;
      });

    return { started: true, alreadyRunning: false };
  }

  window.addEventListener("message", (event) => {
    if (!playbackActive || !isWatchPage()) return;
    if (event.source !== window) return;
    if (event.data?.source !== SOURCE) return;
    if (event.data?.type !== "SUBTITLE_DOCUMENT") return;

    const { url, text } = event.data.payload || {};
    acceptSubtitleDocument(url, text).catch((error) => {
      console.warn("[LST] Could not parse captured subtitles:", error);
    });
  });

  ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      switch (message?.type) {
        case "GET_PAGE_STATUS": {
          refreshCacheCoverage(document.querySelector("video")?.currentTime);
          const metadata = cacheMetadata();
          sendResponse({
            ok: true,
            status: {
              ...currentStatus,
              videoId: getVideoId(),
              showName: metadata.showName,
              episodeName: metadata.episodeName,
              sourceUrl: cueSourceUrl,
              enabled: settings.enabled,
              model: settings.model,
              targetLanguage: settings.targetLanguage,
            },
          });
          return;
        }

        case "START_PRECOMPUTE":
          sendResponse({ ok: true, ...startPrecomputeDetached() });
          return;

        case "CANCEL_PRECOMPUTE":
          precomputeCancelled = true;
          sendResponse({ ok: true });
          return;

        case "RELOAD_SETTINGS": {
          if (!playbackActive || !isWatchPage()) {
            await loadSettings();
            sendResponse({ ok: true });
            return;
          }
          const previousCacheId = cacheId();
          const previousUseTranslationContext = settings.useTranslationContext;
          await loadSettings();
          if (settings.useTranslationContext !== previousUseTranslationContext) {
            translationCoordinator = null;
          }
          if (cacheId() !== previousCacheId) {
            translationCoordinator = null;
            knownCachedKeys = new Set();
            knownCachedTranslations = new Map();
            pausedCacheFailedKeys = new Set();
            if (cues.length) await getCachedTranslations(cues);
          }
          ensureOverlay();
          applySubtitleAppearance();
          updateOverlayPanelVisibility();
          updateDebugPanel();
          sendResponse({ ok: true });
          return;
        }

        default:
          sendResponse({ ok: false, error: "Unknown page message." });
      }
    })().catch((error) => {
      sendResponse({ ok: false, error: error?.message || String(error) });
    });

    return true;
  });

  function stopPlayback() {
    playbackActive = false;
    playbackGeneration++;
    precomputeCancelled = true;
    document.documentElement.classList.remove("lst-hide-netflix-subtitles");
    stopTitleMetadataObserver();
    stopFallbackObserver();
    clearTimeout(diagnosticFlushTimer);
    diagnosticFlushTimer = null;
    diagnosticEvents = [];
    lastFallbackText = "";
    netflixSubtitleCandidate = "";
    cues = [];
    cueSourceUrl = "";
    cueVideoId = "";
    translationCoordinator = null;
    knownCachedKeys = new Set();
    knownCachedTranslations = new Map();
      lookAheadQueued = new Set();
      lookAheadNoticeShown = false;
      lookAheadReadyNoticeShown = false;
      pausedCacheFailedKeys = new Set();
      pausedCacheNoticeShown = false;
      pausedCacheCompleteNoticeShown = false;
      lastPlaybackWasPaused = false;
    renderedSubtitles = [];
    lastRenderedCueKey = "";
    currentStatus = {
      ...currentStatus,
      captured: false,
      cueCount: 0,
      translatedCount: 0,
      remainingCueCount: 0,
      remainingTranslatedCount: 0,
      precomputing: false,
      progressPercent: 0,
      playbackMode: "waiting",
      requestState: "idle",
      message: "Waiting for Netflix subtitles…"
    };
    for (const element of [overlay, hud, debugPanel, transcriptPanel]) {
      if (element) element.style.display = "none";
    }
  }

  async function syncPlaybackRoute() {
    if (!isWatchPage()) {
      if (playbackActive) stopPlayback();
      return;
    }
    if (playbackActive) return;
    playbackActive = true;
    const generation = ++playbackGeneration;
    try {
      await loadSettings();
      if (generation !== playbackGeneration) return;
      if (!isWatchPage()) {
        stopPlayback();
        return;
      }
      for (const element of [overlay, hud, debugPanel, transcriptPanel]) {
        if (element) element.style.display = "";
      }
      ensureOverlay();
      setStatus("Waiting for Netflix subtitles…", true);
      stopTitleMetadataObserver = startTitleMetadataObserver();
      stopFallbackObserver = startFallbackObserver();
      requestAnimationFrame(playbackLoop);
    } catch (error) {
      if (generation === playbackGeneration) {
        playbackActive = false;
        stopTitleMetadataObserver();
        stopFallbackObserver();
        for (const element of [overlay, hud, debugPanel, transcriptPanel]) {
          if (element) element.style.display = "none";
        }
      }
      throw error;
    }
  }

  startFullscreenObserver();
  syncPlaybackRoute().catch((error) => console.warn("[LST] Could not start playback:", error));
  setInterval(() => {
    syncPlaybackRoute().catch((error) => console.warn("[LST] Could not follow Netflix navigation:", error));
  }, 750);
})();
