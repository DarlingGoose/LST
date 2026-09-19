(() => {
  const ext = globalThis.browser || globalThis.chrome;
  const SOURCE = "lst-local-subtitle-translate";

  const DEFAULTS = {
    enabled: true,
    provider: "ollama",
    model: "translategemma:4b",
    targetLanguage: "English",
    hideNativeSubtitles: true,
    enabledSites: { netflix: true, primevideo: true },
    hudPosition: "",
    showOriginal: false,
    showTranslated: true,
    minimumSubtitleDisplaySeconds: 2,
    maximumVisibleSubtitles: 2,
    showStatusMessages: true,
    autoTranslateAhead: true,
    useTranslationContext: false,
    verifyTranslations: true,
    lookAheadSeconds: 30,
    cacheWhilePaused: true,
    batchSize: 8,
    requestTimeoutSeconds: 75,
    customTranslationPrompt: "",
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
  const RENDERED_SUBTITLE_STABILITY_MS = 90;
  const TIMED_TRACK_MISMATCH_GRACE_MS = 300;
  const DEBUG_FLUSH_MS = 500;

  let settings = { ...DEFAULTS };
  let cues = [];
  let cueSourceUrl = "";
  let cueVideoId = "";
  const titleMetadataByVideoId = new Map();
  const titleMetadataRequestsByVideoId = new Map();
  const storedTitleSignaturesByCacheId = new Map();
  let lastTitleResolution = {};
  // The episode number the page states, when it states one. Importing a file
  // needs it: it is what the file names are matched against.
  let lastEpisodeNumber = null;
  let lastEpisodeMetadataSignature = "";
  let lastEpisodeMetadataBlock = "";

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
  let renderedSubtitleCandidate = "";
  let renderedSubtitleCandidateSince = 0;
  let timedTrackSyncState = "unverified";
  let automaticCueTimeOffsetSeconds = 0;
  let lastRenderedSyncText = "";
  let timedTrackMismatchSince = 0;
  let lastTimedTrackMismatch = "";
  let timedTrackMismatchSequence = 0;
  let activeTimedTrackMismatchId = 0;
  let noTimedCueSince = 0;
  let lastTitleMetadataRefreshAt = 0;
  let titleMetadataRefreshTimer = null;

  let warnedMissingTranslationContext = false;
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
    message: "Waiting for subtitles…",
    // Which track is playing: the service's own captions, or a subtitle file the
    // viewer imported for this episode.
    subtitleSource: "none",
    importedFileName: "",
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
    const videoTime = Number(activeVideo()?.currentTime);
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

  // Which service this page is, and every site-specific fact about it, belongs
  // to playback-site.js so this file, the page hook, the background and the
  // extension's pages answer those questions the same way. The manifest loads it
  // before this file; the fallbacks below only exist so a broken load order
  // reports itself instead of throwing or guessing a site.
  let warnedMissingPlaybackSite = false;

  function playbackSite() {
    const api = globalThis.LSTPlaybackSite;
    if (api) return api;
    if (!warnedMissingPlaybackSite) {
      warnedMissingPlaybackSite = true;
      console.warn(
        "[LST] playback-site.js is missing; LST cannot tell which service this page is.",
      );
    }
    return null;
  }

  // Site detection is cached per URL, because the playback loop asks for it many
  // times per second and both services navigate without reloading the document.
  let playbackSiteCache = { href: null, detected: null };

  function detectedSite() {
    const href = String(location.href || `${location.pathname || ""}${location.search || ""}`);
    if (playbackSiteCache.href !== href) {
      const api = playbackSite();
      playbackSiteCache = {
        href,
        detected: api
          ? api.detect(location)
          : {
              site: null,
              siteId: "",
              matchPattern: "",
              view: { href, pathname: String(location.pathname || ""), search: "", host: "" },
              reason: "playback-site-unavailable",
            },
      };
    }
    return playbackSiteCache.detected;
  }

  function currentSite() {
    return detectedSite().site || null;
  }

  function currentSiteId() {
    return detectedSite().siteId || "";
  }

  // What to call the service in a sentence the viewer reads. Falling back to a
  // neutral phrase is deliberate: an unknown site must not be called Netflix.
  function siteName() {
    return currentSite()?.label || "this service";
  }

  // A service the viewer has switched off behaves like the global switch: LST
  // stays idle and leaves native subtitles alone. A site that is absent from the
  // map is enabled, because an unknown key is not a reason to disable something
  // the viewer never touched.
  function siteEnabled(siteId) {
    const map = settings.enabledSites;
    if (!siteId || !map || typeof map !== "object") return true;
    return map[siteId] !== false;
  }

  // Is a player actually in use on this page? A playback path is not the same
  // question: a Prime Video detail page is a storefront with a trailer on it
  // until the viewer presses play, and LST must not paint its overlay over a
  // storefront. Each service answers for itself, and a service that cannot
  // answer leaves LST idle rather than guessed-on.
  function playerPresence() {
    const site = currentSite();
    if (!site?.playerPresence) return { present: false, reason: "adapter-unavailable" };
    try {
      return site.playerPresence(document);
    } catch {
      return { present: false, reason: "adapter-error" };
    }
  }

  function isWatchPage() {
    const site = currentSite();
    if (!site) return false;
    return Boolean(site.isPlaybackPage(detectedSite().view).ok);
  }

  function getVideoId() {
    const site = currentSite();
    if (!site) return "unknown";
    try {
      return site.videoIdFrom(detectedSite().view).videoId || "unknown";
    } catch {
      // The adapter is the only place a URL is read, so a throw here means the
      // id is unavailable rather than that some other rule should be tried.
      return "unknown";
    }
  }

  // Which <video> element the viewer is watching. Prime renders several (main
  // playback plus ad and preview slots), so "the first video on the page" is not
  // the same question. The answer is cached briefly because the playback loop
  // asks once per frame.
  const ACTIVE_VIDEO_CACHE_MS = 250;
  let activeVideoCache = { at: 0, element: null };
  let lastActiveVideoReason = "";

  function activeVideo() {
    const now = performance.now();
    if (
      activeVideoCache.element?.isConnected &&
      now - activeVideoCache.at < ACTIVE_VIDEO_CACHE_MS
    ) {
      return activeVideoCache.element;
    }
    const site = currentSite();
    let video = null;
    if (site) {
      try {
        const result = site.activeVideo(document);
        video = result?.video || null;
        lastActiveVideoReason = result?.reason || "";
      } catch (error) {
        video = document.querySelector("video") || null;
        lastActiveVideoReason = "adapter-error";
      }
    } else {
      video = document.querySelector("video") || null;
      lastActiveVideoReason = "site-unavailable";
    }
    activeVideoCache = { at: now, element: video };
    return video;
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

  // Cue identity is decided by subtitle-sync.js so that every place a rendered
  // line is matched against the captured track uses the same folded comparison.
  // The helper is read lazily because content.js also runs in contexts that load
  // it on its own, where these degrade to the previous comparable-text test.
  function foldedSubtitleText(text) {
    const api = globalThis.LSTSubtitleSync;
    return api?.foldSubtitleText
      ? api.foldSubtitleText(text)
      : comparableSubtitleText(text);
  }

  function foldedMatchTier() {
    return Number(globalThis.LSTSubtitleSync?.MATCH_TIER?.folded ?? 2);
  }

  function subtitleTextsMatch(left, right) {
    const api = globalThis.LSTSubtitleSync;
    if (api?.matchTier) {
      return api.matchTier(left, right) === api.MATCH_TIER.folded;
    }
    const comparableLeft = comparableSubtitleText(left);
    return Boolean(
      comparableLeft && comparableLeft === comparableSubtitleText(right),
    );
  }

  function simplifiedDiagnosticText(text) {
    return globalThis.LSTSubtitleSync.simplifySubtitleText(text);
  }

  function diagnosticTextId(text) {
    const normalized = foldedSubtitleText(text);
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
      const text = foldedSubtitleText(cue.text);
      if (!text) continue;
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
        foldedSubtitleText(key.slice("fallback:".length)),
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
    const videoId = cueVideoId || getVideoId();
    const siteId = currentSiteId();
    const api = episodeIdentity();
    if (api) {
      return api.encodeCacheId({
        videoId,
        siteId,
        provider: settings.provider,
        model: settings.model,
        targetLanguage: settings.targetLanguage,
      });
    }
    const model = encodeURIComponent(
      settings.provider === "ollama"
        ? settings.model || "none"
        : `${settings.provider}/${settings.model || "none"}`,
    );
    const language = encodeURIComponent(settings.targetLanguage || "English");
    // Without episode-identity.js the id is assembled here, and the namespace
    // rule is the same one: only a non-default service is prefixed, so Netflix
    // keys stay readable by a build that has the module.
    const namespace = siteId && siteId !== "netflix" ? `${siteId}~` : "";
    return `${namespace}${videoId}:${model}:${language}`;
  }

  // How a service words its own document title, and which parts of it are
  // boilerplate, belongs to the adapter: "Amazon.co.jp: Show : Prime Video" and
  // "Watch Show | Netflix Official Site" are the same question asked twice.
  function cleanSitePageTitle(value) {
    const site = currentSite();
    if (site?.cleanPageTitle) return normalizeText(site.cleanPageTitle(value));
    return normalizeText(value);
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

  // Episode identity — which names Netflix actually gave us, which are the
  // placeholders it renders when it has nothing better, where the episode
  // marker sits inside a title, and what the title block embedded in the
  // episode page says — belongs to episode-identity.js, so this file, the
  // background, and the extension's own pages answer those questions the same
  // way. The manifest loads it first; the fallbacks below only exist so a
  // broken load order reports itself instead of throwing.
  let warnedMissingEpisodeIdentity = false;

  function episodeIdentity() {
    const api = globalThis.LSTEpisodeIdentity;
    if (api) return api;
    if (!warnedMissingEpisodeIdentity) {
      warnedMissingEpisodeIdentity = true;
      console.warn(
        "[LST] episode-identity.js is missing; episode names will not be classified.",
      );
    }
    return null;
  }

  function classifiedName(value) {
    const api = episodeIdentity();
    if (api) return api.classifyName(value);
    // Without the classifier a scraped name is trusted exactly as it was
    // before the classifier existed, and the reason says why.
    const name = normalizeText(value);
    return {
      name,
      kind: name ? "specific" : "empty",
      reason: "episode-identity-unavailable",
      shape: "",
    };
  }

  function isSpecificName(value) {
    return classifiedName(value).kind === "specific";
  }

  function fallbackEpisodeName(videoId) {
    const api = episodeIdentity();
    if (api) return api.fallbackEpisodeName(videoId);
    return videoId && videoId !== "unknown"
      ? `Episode ${videoId}`
      : "Episode details unavailable";
  }

  function isFallbackEpisodeName(value) {
    return !isSpecificName(value);
  }

  function episodeMarkerInfo(text) {
    const api = episodeIdentity();
    if (api) return api.episodeMarker(text);
    return {
      marker: "",
      season: null,
      episode: null,
      shape: "",
      reason: "episode-identity-unavailable",
    };
  }

  function episodeMarker(text) {
    return episodeMarkerInfo(text).marker;
  }

  function episodeMetadataFromHtml(html, videoId) {
    const api = episodeIdentity();
    if (!api) return { metadata: null, reason: "episode-identity-unavailable" };

    const found = api.findEpisodeMetadataInHtml(html, videoId);
    if (!found.title && found.episodeNumber == null) {
      return { metadata: null, reason: found.reason };
    }
    // The show name is a separate question, and the page's own title is the
    // only place Netflix states it for an episode page.
    const parsed = new DOMParser().parseFromString(String(html), "text/html");
    const showName = classifiedName(
      cleanSitePageTitle(
        parsed.title || parsed.querySelector('meta[property="og:title"]')?.content,
      ),
    );
    return {
      reason: found.reason,
      episodeNumber: Number.isInteger(found.episodeNumber) ? found.episodeNumber : null,
      metadata: {
        showName: showName.kind === "specific" ? showName.name : "",
        episodeName: api.episodeNameFromParts(found),
      },
    };
  }

  // Netflix publishes an episode's title and number in the HTML of its own
  // /title/<id> page. Amazon has no equivalent, so this lookup is gated on the
  // service rather than attempted and failed everywhere.
  function requestSiteTitleMetadata(videoId) {
    if (currentSiteId() !== "netflix") return;
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
        const { metadata, reason, episodeNumber } = episodeMetadataFromHtml(html, videoId);
        if (Number.isInteger(episodeNumber) && episodeNumber > 0) {
          lastEpisodeNumber = episodeNumber;
        }
        if (!metadata?.episodeName) {
          logEpisodeMetadata("episode-metadata-lookup-empty", { videoId, reason });
          return;
        }
        const previous = titleMetadataByVideoId.get(videoId) || {};
        titleMetadataByVideoId.set(videoId, {
          showName: metadata.showName || previous.showName || siteName(),
          episodeName: metadata.episodeName,
        });
        lastTitleResolution = {
          ...lastTitleResolution,
          lookupReason: reason,
          lookupSource: "episode-page",
          episodeNameKind: classifiedName(metadata.episodeName).kind,
          episodeNameReason: classifiedName(metadata.episodeName).reason,
        };
        persistImprovedCacheMetadata();
      })
      .catch((error) => {
        console.warn("[LST] Could not load Netflix episode details:", error);
        logEpisodeMetadata("episode-metadata-lookup-failed", {
          videoId,
          reason: "request-failed",
        });
      });
    titleMetadataRequestsByVideoId.set(videoId, request);
  }

  // Where a service shows the title inside its player, and which of its
  // elements name the show rather than the episode, belongs to the adapter. A
  // service that publishes neither — Prime Video's player chrome is unverified —
  // answers with empty lists and the document title stands in.
  const EMPTY_TITLE_SELECTORS = Object.freeze({
    containers: [],
    show: [],
    showAttributes: [],
    episode: [],
    episodeAttributes: [],
  });

  function siteTitleSelectors() {
    const selectors = currentSite()?.titleSelectors;
    return selectors || EMPTY_TITLE_SELECTORS;
  }

  function siteTitleElements() {
    const site = currentSite();
    if (!site?.titleElements) return [];
    try {
      return site.titleElements(document).elements || [];
    } catch {
      return [];
    }
  }

  // The selector the title observer watches. It is derived from the adapter so a
  // service the observer knows nothing about still reports its document title.
  function siteTitleObserverSelector() {
    const selectors = siteTitleSelectors();
    return [
      "title",
      ...(selectors.containers || []),
      ...(selectors.show || []),
      ...(selectors.episode || []),
    ].join(", ");
  }

  function siteTitleMetadata() {
    const selectors = siteTitleSelectors();
    const explicitShowCandidates = [
      ...metadataTexts(selectors.show || []),
      ...metadataTexts(selectors.showAttributes || [], "alt"),
    ];
    const explicitEpisodeCandidates = [
      ...metadataTexts(selectors.episode || []),
      ...metadataTexts(selectors.episodeAttributes || [], "aria-label"),
    ];
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
      .map(cleanSitePageTitle)
      .filter((value) => isSpecificName(value));
    const parts = siteTitleElements()
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
    const marker = episodeMarkerInfo(markerSource);
    if (Number.isInteger(marker.episode) && marker.episode > 0) {
      lastEpisodeNumber = marker.episode;
    }
    const normalizedEpisodeMarker = marker.marker;
    const usableExplicitShow = explicitShowCandidates.find(
      (value) =>
        isSpecificName(value) &&
        !episodeMarker(value) &&
        !explicitEpisodeCandidates.includes(value),
    );
    const usablePageTitle = pageTitleCandidates[0] || "";
    const showName =
      usableExplicitShow ||
      usablePageTitle ||
      parts.find(
        (value) =>
          isSpecificName(value) &&
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
    const previousEpisodeName = isFallbackEpisodeName(previous.episodeName)
      ? ""
      : previous.episodeName;
    const discovered = {
      showName: showName || previous.showName || siteName(),
      episodeName:
        episodeName || previousEpisodeName || fallbackEpisodeName(videoId),
    };

    const hasSpecificEpisode = !isFallbackEpisodeName(discovered.episodeName);
    if (!hasSpecificEpisode) requestSiteTitleMetadata(videoId);
    if (
      isSpecificName(discovered.showName) ||
      !previous.showName ||
      hasSpecificEpisode
    ) {
      titleMetadataByVideoId.set(videoId, discovered);
    }
    const remembered = titleMetadataByVideoId.get(videoId) || discovered;

    // What was decided about the episode's name, and why. The names themselves
    // are page content, so only their kind and the rule that produced it are
    // recorded here; see logEpisodeMetadata.
    lastTitleResolution = {
      episodeMarkerShape: marker.shape || "none",
      episodeMarkerReason: marker.reason,
      markerFoundInCandidates: Boolean(markerSource),
      explicitEpisodeCandidateCount: explicitEpisodeCandidates.length,
      explicitShowCandidateCount: explicitShowCandidates.length,
      pageTitleCandidateCount: pageTitleCandidates.length,
      showNameKind: classifiedName(remembered.showName).kind,
      showNameReason: classifiedName(remembered.showName).reason,
      episodeNameKind: classifiedName(remembered.episodeName).kind,
      episodeNameReason: classifiedName(remembered.episodeName).reason,
      episodeTitleKind: classifiedName(episodeTitle).kind,
      episodeTitleReason: classifiedName(episodeTitle).reason,
      episodeNameFrom:
        episodeName ? "page" : previousEpisodeName ? "previous" : "placeholder",
      lookupSource:
        lastTitleResolution.lookupSource ||
        (hasSpecificEpisode ? "player" : "episode-page-pending"),
      lookupReason: lastTitleResolution.lookupReason || "no-lookup-yet",
    };

    return {
      ...remembered,
      title: [remembered.showName, remembered.episodeName]
        .filter(Boolean)
        .join(" — "),
    };
  }

  // The service a cache belongs to is part of the id it is written under, so a
  // Prime Video episode can never be filed as a Netflix one. The id travels with
  // the metadata as well, so the background reconciles names against the same
  // service the key names.
  function cacheMetadata() {
    const videoId = cueVideoId || getVideoId();
    const currentVideoId = getVideoId();
    const remembered = titleMetadataByVideoId.get(videoId);
    let titleMetadata;
    if (videoId === currentVideoId) {
      titleMetadata = siteTitleMetadata();
    } else {
      // The title UI is no longer on screen. What was remembered for that video
      // is all we have, plus the placeholders that name the video id.
      const showName = remembered?.showName || siteName();
      const episodeName =
        remembered?.episodeName || fallbackEpisodeName(videoId);
      titleMetadata = {
        showName,
        episodeName,
        title: [showName, episodeName].filter(Boolean).join(" — "),
      };
    }
    return {
      videoId,
      siteId: currentSiteId(),
      ...titleMetadata,
      url: location.href,
      provider: settings.provider || "ollama",
      model: settings.model || "Unknown model",
      targetLanguage: settings.targetLanguage || "English",
      sourceCueCount: cues.length,
    };
  }

  // Episode naming is reported as the decision that was made and the rule that
  // made it, never as the names themselves: show and episode titles are page
  // content, and the event log is meant to stay safe to share when something
  // goes wrong.
  function logEpisodeMetadata(event, details) {
    logDiagnostic("info", "episode", event, details);
  }

  function persistImprovedCacheMetadata() {
    // A title that just resolved is the first moment the show's name is known,
    // which is also the first moment LST can look up what Jimaku holds for it.
    // That happens even when nothing can be cached, because the case that needs
    // it most — a title the service does not subtitle — has no cues at all.
    refreshJimakuFinding({ reason: "title-resolved" }).catch((error) => {
      console.warn("[LST] Could not read what Jimaku holds for this show:", error);
    });
    const blocked = !cues.length
      ? "no-cues"
      : !knownCachedKeys.size
        ? "nothing-cached"
        : cueVideoId !== getVideoId()
          ? "different-video"
          : "";
    if (blocked) {
      // A cache that is not being written cannot carry a name either. Say why
      // nothing was saved, once per reason, instead of staying silent.
      if (lastEpisodeMetadataBlock !== blocked) {
        lastEpisodeMetadataBlock = blocked;
        logEpisodeMetadata("episode-metadata-refresh-skipped", {
          reason: blocked,
        });
      }
      return;
    }
    lastEpisodeMetadataBlock = "";
    const metadata = cacheMetadata();
    const showName = classifiedName(metadata.showName);
    const episodeName = classifiedName(metadata.episodeName);
    const detail = {
      videoId: metadata.videoId,
      showNameKind: showName.kind,
      showNameReason: showName.reason,
      episodeNameKind: episodeName.kind,
      episodeNameReason: episodeName.reason,
      ...lastTitleResolution,
      lookupSource: lastTitleResolution.lookupSource || "player",
    };
    const resolved =
      showName.kind === "specific" || episodeName.kind === "specific";
    const detailSignature = JSON.stringify(detail);
    if (detailSignature !== lastEpisodeMetadataSignature) {
      lastEpisodeMetadataSignature = detailSignature;
      logEpisodeMetadata(
        resolved ? "episode-name-resolved" : "episode-name-unresolved",
        detail,
      );
    }
    // Only a real name is worth writing back. A placeholder adds nothing to a
    // cache that already names its episode.
    if (!resolved) return;

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
    // The watched selector comes from the adapter, so a service the observer
    // knows nothing about still reports a change of its own document title.
    const titleSelector = siteTitleObserverSelector();
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
        siteTitleMetadata();
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

    const video = activeVideo();
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

  // Subtitle formats belong to the module that knows where an imported file
  // comes from, so the same SubRip file is read the same way whether the player
  // delivered it or a viewer imported it. The parsers here stay the ones that
  // need a DOM: TTML and WebVTT arrive from the service and are read as
  // documents.
  function parseSubtitleDocument(text) {
    const trimmed = String(text || "").trim();
    if (/^WEBVTT\b/i.test(trimmed)) return parseVtt(trimmed);
    if (/<tt[\s>]/i.test(trimmed)) return parseTtml(trimmed);
    const api = subtitleImport();
    if (api?.parseSrt && /-->/.test(trimmed)) return api.parseSrt(trimmed);
    return [];
  }

  async function loadSettings() {
    try {
      const stored = (await runtimeMessage({ type: "GET_SETTINGS" })).settings || {};
      settings = { ...DEFAULTS, ...stored };
      // The renamed key is read through here as well as in the background, so a
      // viewer whose saved preference predates the rename keeps it even if the
      // background answering this message is an older build. `??` semantics
      // matter: a stored `false` is a real answer.
      if (
        stored.hideNativeSubtitles === undefined &&
        stored.hideNetflixSubtitles !== undefined
      ) {
        settings.hideNativeSubtitles = stored.hideNetflixSubtitles;
      }
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
    // Players normally fullscreen a container. A native fullscreen
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
      applyHudPosition();
    }

    if (!statusLine?.isConnected) {
      statusLine = document.createElement("div");
      statusLine.id = "not-status";
      statusLine.setAttribute("role", "status");
      statusLine.setAttribute("aria-live", "polite");
      hud.appendChild(statusLine);
    }

    if (!jimakuNote?.isConnected) {
      // A note about Jimaku outlives the status line, which is where every other
      // message goes and is replaced by the next one — often within a second of
      // arriving. What the viewer asked for is something they can read after the
      // episode has settled, so it is its own element with its own dismiss.
      jimakuNote = document.createElement("div");
      jimakuNote.id = "lst-jimaku-note";
      jimakuNote.hidden = true;
      jimakuNote.setAttribute("role", "status");
      jimakuNote.setAttribute("aria-live", "polite");
      jimakuNote.innerHTML = `
        <span id="lst-jimaku-note-text"></span>
        <button type="button" data-jimaku-action="dismiss" aria-label="Dismiss what LST knows about this show">×</button>
      `;
      jimakuNote.addEventListener("click", (event) => {
        if (event.target.closest("[data-jimaku-action]")?.dataset.jimakuAction !== "dismiss") return;
        // Dismissal lasts as long as the page does, and one show's dismissal is
        // not another's.
        if (jimakuFinding?.showKey) jimakuNoteDismissed.add(jimakuFinding.showKey);
        logDiagnostic("info", "import", "jimaku-note-dismissed", {});
        updatePillSubtitleSource();
      });
      hud.appendChild(jimakuNote);
      jimakuNoteText = jimakuNote.querySelector("#lst-jimaku-note-text");
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
          <span id="lst-pill-source" class="lst-pill-source" hidden></span>
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
          <section class="lst-pill-section lst-pill-subtitles" aria-labelledby="lst-subtitles-heading">
            <h3 id="lst-subtitles-heading">Subtitles</h3>
            <p id="lst-pill-source-note" class="lst-pill-note">Waiting for the service's subtitles.</p>
            <p id="lst-pill-jimaku-note" class="lst-pill-note lst-pill-jimaku" hidden></p>
            <div class="lst-pill-actions">
              <button type="button" data-pill-action="import">Import subtitles…</button>
              <button type="button" data-pill-action="check-jimaku">Check Jimaku</button>
            </div>
          </section>
          <section class="lst-pill-section" aria-labelledby="lst-visibility-heading">
            <h3 id="lst-visibility-heading">Visibility</h3>
            <label><span>Translation</span><span class="lst-pill-switch"><input data-pill-setting="showTranslated" type="checkbox" role="switch"><span class="lst-pill-switch-ui"></span></span></label>
            <label><span>Original text</span><span class="lst-pill-switch"><input data-pill-setting="showOriginal" type="checkbox" role="switch"><span class="lst-pill-switch-ui"></span></span></label>
            <label><span>Hide the service's own subtitles</span><span class="lst-pill-switch"><input data-pill-setting="hideNativeSubtitles" type="checkbox" role="switch"><span class="lst-pill-switch-ui"></span></span></label>
            <label><span>Transcript sidebar</span><span class="lst-pill-switch"><input data-pill-setting="showTranscriptSidebar" type="checkbox" role="switch"><span class="lst-pill-switch-ui"></span></span></label>
          </section>
          <section class="lst-pill-section lst-pill-timing" aria-labelledby="lst-timing-heading">
            <span><h3 id="lst-timing-heading">Timing offset</h3><output id="lst-pill-timing-value">0 ms</output></span>
            <div id="lst-pill-timing-global">
              <button type="button" data-pill-action="earlier" aria-label="Show subtitles 100 milliseconds earlier">−100 ms</button>
              <button type="button" data-pill-action="timing-reset">Reset</button>
              <button type="button" data-pill-action="later" aria-label="Show subtitles 100 milliseconds later">+100 ms</button>
            </div>
            <div class="lst-pill-timing-grid" id="lst-pill-timing-file" hidden>
              <button type="button" data-file-timing-step="-30000" aria-label="Show this imported file 30 seconds earlier">−30 s</button>
              <button type="button" data-file-timing-step="-5000" aria-label="Show this imported file 5 seconds earlier">−5 s</button>
              <button type="button" data-file-timing-step="-1000" aria-label="Show this imported file 1 second earlier">−1 s</button>
              <button type="button" data-file-timing-step="-100" aria-label="Show this imported file 100 milliseconds earlier">−0.1 s</button>
              <button type="button" data-file-timing-step="100" aria-label="Show this imported file 100 milliseconds later">+0.1 s</button>
              <button type="button" data-file-timing-step="1000" aria-label="Show this imported file 1 second later">+1 s</button>
              <button type="button" data-file-timing-step="5000" aria-label="Show this imported file 5 seconds later">+5 s</button>
              <button type="button" data-file-timing-step="30000" aria-label="Show this imported file 30 seconds later">+30 s</button>
              <button type="button" data-pill-action="file-timing-reset" aria-label="Show this imported file where the file says">Reset</button>
            </div>
            <p class="lst-pill-note" id="lst-pill-timing-note" hidden></p>
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
      const video = activeVideo();
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
      empty.textContent = `Turn on a ${siteName()} subtitle track to load its transcript.`;
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
      const video = activeVideo();
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

  // The four corners the HUD and its control pill can occupy. The viewer's
  // choice is stored once and applies to every service, so a viewer who moves
  // LST out of the way is not surprised by a different corner elsewhere. Until
  // they choose, the service supplies a starting corner — the service's own
  // title and controls occupy different corners, and this is how LST stays off
  // them on the first run rather than by accident.
  const HUD_POSITIONS = Object.freeze([
    "top-left",
    "top-right",
    "bottom-left",
    "bottom-right",
  ]);

  function hudPosition() {
    const chosen = String(settings.hudPosition || "");
    if (HUD_POSITIONS.includes(chosen)) {
      return { position: chosen, reason: "viewer-choice" };
    }
    const preferred = currentSite()?.defaultHudPosition;
    if (HUD_POSITIONS.includes(preferred)) {
      return { position: preferred, reason: "service-default" };
    }
    return { position: "top-right", reason: "built-in-default" };
  }

  function applyHudPosition() {
    if (!hud) return;
    const resolved = hudPosition();
    if (hud.dataset.position !== resolved.position) {
      hud.dataset.position = resolved.position;
    }
  }

  function applySubtitleAppearance() {
    if (!overlay || !subtitleStack) return;

    // Hiding a service's own captions is a stylesheet rule carrying !important,
    // driven by one shared class. An inline style would not survive on Prime
    // Video, which rewrites the caption element's inline style periodically.
    document.documentElement.classList.toggle(
      "lst-hide-native-subtitles",
      settings.enabled && settings.hideNativeSubtitles !== false,
    );
    applyHudPosition();

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

  // Where the subtitles on screen come from, said in the player rather than only
  // in the extension's own pages: an imported file is a different thing from the
  // service's own track, and the viewer should not have to open a settings page
  // to find out which one they are watching.
  function updatePillSubtitleSource() {
    if (!quickPillsPanel) return;
    const chip = quickPillsPanel.querySelector("#lst-pill-source");
    const sourceNote = quickPillsPanel.querySelector("#lst-pill-source-note");
    const jimakuPillNote = quickPillsPanel.querySelector("#lst-pill-jimaku-note");
    const imported = trackIsImported();
    if (chip) {
      chip.hidden = !imported;
      chip.textContent = imported ? "Imported" : "";
      chip.title = imported ? importedTrack?.fileName || "" : "";
    }
    quickPillsPanel.dataset.source = imported ? "imported" : "service";
    if (sourceNote) {
      if (imported && importedTrack.translate !== false) {
        sourceNote.textContent =
          `Using ${importedTrack.fileName || "an imported file"}, imported for this episode.`;
      } else if (imported) {
        sourceNote.textContent =
          `Using ${importedTrack.fileName || "an imported file"} — already ` +
          `${importedTrack.language || settings.targetLanguage}, so it is shown as it is.`;
      } else if (currentStatus.captured) {
        sourceNote.textContent = `Using ${siteName()}'s own subtitles.`;
      } else {
        sourceNote.textContent = `Waiting for ${siteName()}'s subtitles.`;
      }
    }
    if (!jimakuPillNote) return;
    // A note about Jimaku is only worth showing when there is no imported file
    // in use: the file in use is the answer, and the note adds nothing to it.
    const described = imported ? null : jimakuFindingText();
    jimakuPillNote.hidden = !described;
    if (described) {
      jimakuPillNote.textContent = `${described.headline}. ${described.detail}`;
      jimakuPillNote.dataset.tone = described.tone;
    }
    updateJimakuNote();
  }

  function updateQuickPills() {
    if (!quickPillsPanel || !quickPillsState) return;
    quickPillsPanel.style.display = settings.showQuickPills ? "block" : "none";
    refreshCacheCoverage();
    const status = quickPillStatus();
    quickPillsPanel.dataset.state = status.state;
    quickPillsState.textContent = status.label;
    updatePillSubtitleSource();
    updateQuickPillsTiming();
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
  }

  // The timing controls point at one clock: an imported file's own, when one is
  // in use, and the global setting otherwise. Which clock that is comes from the
  // module the popup asks too, so the two pages cannot point at different ones.
  function timingTarget() {
    const api = subtitleImport();
    const globalOffsetMs = clamp(
      settings.subtitleTimingOffsetMs,
      -2000,
      2000,
      0,
    );
    if (api?.timingTargetFor) {
      return api.timingTargetFor(trackIsImported() ? importedTrack : null, {
        globalOffsetMs,
      });
    }
    return trackIsImported()
      ? {
          scope: "imported-file",
          episodeKey: importedTrack?.episodeKey || "",
          offsetMs: 0,
          limitMs: 0,
        }
      : { scope: "global", episodeKey: "", offsetMs: globalOffsetMs, limitMs: 2000 };
  }

  function updateQuickPillsTiming() {
    if (!quickPillsPanel) return;
    const target = timingTarget();
    const importedScope = target.scope !== "global";
    const output = quickPillsPanel.querySelector("#lst-pill-timing-value");
    const globalRow = quickPillsPanel.querySelector("#lst-pill-timing-global");
    const fileRow = quickPillsPanel.querySelector("#lst-pill-timing-file");
    const note = quickPillsPanel.querySelector("#lst-pill-timing-note");
    if (globalRow) globalRow.hidden = importedScope;
    if (fileRow) fileRow.hidden = !importedScope;

    if (!importedScope) {
      if (output)
        output.textContent = `${target.offsetMs > 0 ? "+" : ""}${target.offsetMs} ms`;
      if (note) note.hidden = true;
      return;
    }

    const described = subtitleImport()?.describeFileTiming?.(target.offsetMs);
    if (output) output.textContent = described?.label || `${target.offsetMs} ms`;
    if (!note) return;
    note.hidden = false;
    // The global setting still applies while a file is in use, so a viewer who
    // tuned it for the service's own track is told it is part of the sum rather
    // than left to wonder why the file is still off by what they set.
    const global = clamp(settings.subtitleTimingOffsetMs, -2000, 2000, 0);
    note.textContent =
      `${described?.sentence || ""}` +
      (global
        ? ` The global timing offset (${global > 0 ? "+" : ""}${global} ms) also applies.`
        : "");
  }

  // A file the viewer imported carries its own correction, so this is where the
  // timing controls write while one is in use: with the file, in the background,
  // for the episode it was imported for.
  function nudgeImportedFileTiming(deltaMs) {
    const episodeKey = importedTrack?.episodeKey;
    if (!episodeKey) return;
    const api = subtitleImport();
    const current = api?.normalizeFileTiming
      ? api.normalizeFileTiming(importedTrack?.timingOffsetMs)
      : Number(importedTrack?.timingOffsetMs) || 0;
    const limit = api?.FILE_TIMING_LIMIT_MS || 600000;
    const next = clamp(current + deltaMs, -limit, limit, 0);
    if (next === current) {
      // Either the file is already where the viewer wants it, or the correction
      // has reached the end of the range. A file further out than ten minutes is
      // a file for another release, and pressing on will not help.
      showUnifiedControlsStatus(
        deltaMs === 0
          ? "Already where the file says"
          : "That is as far as LST moves a file (10 minutes)",
      );
      return;
    }
    runtimeMessage({
      type: "SET_IMPORTED_TRACK_TIMING",
      episodeKey,
      offsetMs: next,
    })
      .then((response) => {
        applyImportedFileTiming(response?.track?.timingOffsetMs ?? next);
        showUnifiedControlsStatus("Saved");
      })
      .catch((error) =>
        showUnifiedControlsStatus(`Could not save the timing: ${error.message}`, true),
      );
  }

  // Applying a correction is local and immediate: the viewer nudged until the
  // line landed, so the line has to move under their eyes, not at the next
  // episode change. The file is the same file, so nothing is re-read.
  function applyImportedFileTiming(offsetMs) {
    if (!trackIsImported()) return;
    const api = subtitleImport();
    const next = api?.normalizeFileTiming
      ? api.normalizeFileTiming(offsetMs)
      : Number(offsetMs) || 0;
    if (next === fileTimingOffsetMs()) return;
    importedTrack.timingOffsetMs = next;
    // The line that belongs at this moment may be a different one now, and the
    // one on screen may have to go.
    removeRenderedSubtitlesBySource("timed", "file-timing-changed");
    lastRenderedCueKey = "";
    renderTranscript();
    updateQuickPillsTiming();
    setStatus(importedTrackStatusText(), true);
    logDiagnostic("info", "import", "imported-track-timing-changed", {
      offsetMs: next,
      reason: next ? "corrected" : "in-step",
    });
  }

  function bindQuickPills() {
    quickPillsPanel.addEventListener("click", (event) => {
      const fileStep = event.target.closest("[data-file-timing-step]");
      if (fileStep) {
        nudgeImportedFileTiming(Number(fileStep.dataset.fileTimingStep) || 0);
        return;
      }
      const action =
        event.target.closest("[data-pill-action]")?.dataset.pillAction;
      if (action === "toggle") {
        setQuickPillsMenu(quickPillsMenu.hidden);
      } else if (action === "collapse") {
        setQuickPillsMenu(false);
      } else if (action === "file-timing-reset") {
        nudgeImportedFileTiming(
          -(
            subtitleImport()?.normalizeFileTiming?.(importedTrack?.timingOffsetMs) || 0
          ),
        );
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
      } else if (action === "import") {
        // The card that chooses a file, opened at the card itself. A subtitle
        // file is chosen from a list, so it needs the page rather than a pill.
        setQuickPillsMenu(false);
        runtimeMessage({ type: "OPEN_OPTIONS", hash: "#import" }).catch((error) => {
          setStatus(`Could not open the import card: ${error.message}`, true);
        });
      } else if (action === "check-jimaku") {
        // The viewer's own click, which is what makes asking Jimaku here allowed:
        // nothing is sent for a page they only opened.
        checkJimakuForShow().catch((error) => {
          logDiagnostic("warning", "import", "jimaku-check-failed", {
            reason: "request-failed",
          });
          setStatus(
            `Could not ask Jimaku: ${error.message} The import card is where access to Jimaku is granted.`,
            true,
          );
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
    const verification = [...diagnostics]
      .reverse()
      .find((entry) => entry?.verification)?.verification;
    const alignment = [...diagnostics]
      .reverse()
      .find((entry) => entry?.alignment)?.alignment;

    const lines = [
      `model       ${settings.model || "—"}`,
      `target      ${settings.targetLanguage || "—"}`,
      `context     ${
        settings.useTranslationContext
          ? translationContextApi()?.describeLimits() || "on (limits unknown)"
          : "off"
      }`,
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
      `sync offset ${clamp(settings.subtitleTimingOffsetMs, -2000, 2000, 0)}ms · file ${fileTimingOffsetMs()}ms`,
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
    if (alignment) {
      lines.push(
        `aligned     ${alignment.matched} by id · ${alignment.unanswered} re-asked`,
      );
    }
    if (verification) {
      lines.push(
        `verify      ${verification.checked} checked · ${verification.rejected} rejected` +
          `${verification.reason ? ` (${verification.reason})` : ""}`,
      );
    }
    if (latest?.unexpectedIds?.length) {
      lines.push(
        `odd ids     ${truncate(latest.unexpectedIds.join(" | "), 150)}`,
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

  // Conservative fallback for contexts that run content.js without the matching
  // helper: only a unique folded match is resolved, and duplicates are left
  // unresolved rather than guessed. Production always loads the helper.
  function findCueMatchingComparableText(text, expectedTime) {
    const matches = [];
    for (let index = 0; index < cues.length; index++) {
      const cue = cues[index];
      if (!subtitleTextsMatch(cue.text, text)) continue;
      const distance =
        expectedTime < cue.start
          ? cue.start - expectedTime
          : expectedTime >= cue.end
            ? expectedTime - cue.end
            : 0;
      matches.push({ cue, index, distance });
    }
    if (!matches.length) return null;
    const tier = foldedMatchTier();
    if (matches.length === 1) {
      return {
        cue: matches[0].cue,
        index: matches[0].index,
        tier,
        reason: "folded",
        resolvedBy: "unique",
        ambiguous: false,
        candidateCount: 1,
      };
    }
    return {
      cue: null,
      index: -1,
      tier,
      reason: "ambiguous",
      resolvedBy: "none",
      ambiguous: true,
      candidateCount: matches.length,
    };
  }

  // Ranks the captured cues that could be the line the player is showing. Folded
  // text wins over punctuation-insensitive text, a two-cue join is only used when
  // no single cue matches, and equally good candidates are separated by playback
  // time only while the track timeline is already trusted. Anything else stays
  // unresolved so the caller can report the ambiguity instead of guessing.
  function findCueResolution(text, expectedTime) {
    const api = globalThis.LSTSubtitleSync;
    if (api?.resolveCue) {
      return api.resolveCue(cues, text, expectedTime, {
        trustTime: timedTrackSyncState === "verified",
      });
    }
    return findCueMatchingComparableText(text, expectedTime);
  }

  function findCueMatchingText(text, expectedTime) {
    const resolution = findCueResolution(text, expectedTime);
    return resolution?.cue
      ? { cue: resolution.cue, index: resolution.index }
      : null;
  }

  function matchQualityForResolution(resolution) {
    if (!resolution?.cue) return "none";
    if (resolution.reason === "joined") return "joined";
    return resolution.tier === foldedMatchTier() ? "folded" : "loose";
  }

  function matchQualityOf(exactMatchingCue, approximatedCue) {
    return exactMatchingCue
      ? "exact"
      : matchQualityForResolution(approximatedCue);
  }

  function matchResolutionDiagnostics(resolution) {
    if (!resolution) return {};
    return {
      matchTier: resolution.tier,
      matchReason: resolution.reason,
      matchResolvedBy: resolution.resolvedBy,
      matchAmbiguous: Boolean(resolution.ambiguous),
      matchTimeTrusted: Boolean(resolution.timeTrusted),
      matchCandidateCount: resolution.candidateCount,
      matchJoinedWith: Number.isInteger(resolution.secondIndex)
        ? resolution.secondIndex
        : null,
    };
  }

  function isInterCueGapMatch(match, naturalTime, naturalMatch) {
    return globalThis.LSTSubtitleSync.isInterCueGapMatch(
      cues,
      match,
      naturalTime,
      naturalMatch,
    );
  }

  function trackDecisionDiagnostics(decision) {
    if (!decision) return {};
    return {
      trackDecision: decision.accept ? "accept" : "keep",
      trackUnion: Boolean(decision.union),
      trackRelationship: String(decision.relationship || ""),
      trackReason: String(decision.reason || ""),
      trackCurrentTrusted: Boolean(decision.trustExisting),
      trackCurrentCueCount: Number(decision.existingCueCount) || 0,
      trackIncomingCueCount: Number(decision.incomingCueCount) || 0,
      trackSharedCueCount: Number(decision.sharedCueCount) || 0,
      trackIncomingOnlyCueCount: Number(decision.incomingOnlyCueCount) || 0,
      trackCurrentOnlyCueCount: Number(decision.existingOnlyCueCount) || 0,
      trackTimingMatchCount: Number(decision.timingMatchCount) || 0,
      trackTimeRangesOverlap: Boolean(decision.timeRangesOverlap),
      trackCurrentSpanSeconds: Math.round(
        Number(decision.existingSpanSeconds) || 0,
      ),
      trackIncomingSpanSeconds: Math.round(
        Number(decision.incomingSpanSeconds) || 0,
      ),
      renderedLineInIncoming: Boolean(decision.renderedMatchesIncoming),
      renderedLineInCurrent: Boolean(decision.renderedMatchesExisting),
    };
  }

  function resolveTrackDecision(existingCues, incomingCues, renderedText) {
    const api = globalThis.LSTSubtitleSync;
    if (api?.resolveTrackDocument) {
      return api.resolveTrackDocument(existingCues, incomingCues, {
        trustExisting: timedTrackSyncState === "verified",
        renderedText: renderedText,
      });
    }
    // subtitle-sync.js always loads before this script. Without it LST cannot
    // tell a duplicate document from a new track, so it keeps what it has.
    return {
      accept: !existingCues.length,
      relationship: existingCues.length ? "unknown" : "none",
      reason: existingCues.length
        ? "track-identity-unavailable"
        : "no-existing-track",
      existingCueCount: existingCues.length,
      incomingCueCount: incomingCues.length,
    };
  }

  function adoptCapturedTrack(existingCues, incomingCues, decision) {
    const api = globalThis.LSTSubtitleSync;
    if (!api?.adoptTrackDocument) return incomingCues.slice();
    return api.adoptTrackDocument(existingCues, incomingCues, {
      union: Boolean(decision?.union),
    });
  }

  function naturalSubtitleLookupTime(videoTime) {
    return Number(videoTime) + automaticCueTimeOffsetSeconds;
  }

  // The correction that applies right now: the global setting, which the
  // service's own track moves with, plus — while a file the viewer imported is in
  // use — that file's own correction. A file made for another release of the same
  // episode can be seconds or minutes away from the copy being watched, which is
  // why the file's number exists at all and why it is stored with the file rather
  // than in one setting. Both are "positive is later"; the module adds them and
  // states the direction once, so the lookup and the render cannot disagree.
  function fileTimingOffsetMs() {
    if (!trackIsImported()) return 0;
    const api = subtitleImport();
    const value = importedTrack?.timingOffsetMs;
    return api?.normalizeFileTiming ? api.normalizeFileTiming(value) : Number(value) || 0;
  }

  function syncOffsetSeconds() {
    const api = subtitleImport();
    const globalOffsetMs = clamp(
      settings.subtitleTimingOffsetMs,
      -2000,
      2000,
      0,
    );
    if (api?.timingLookupOffsetSeconds) {
      return api.timingLookupOffsetSeconds({
        fileTimingMs: fileTimingOffsetMs(),
        globalOffsetMs,
      });
    }
    return (fileTimingOffsetMs() + globalOffsetMs) / 1000;
  }

  function subtitleLookupTime(videoTime) {
    // Positive values delay LST subtitles; negative values show them earlier.
    return naturalSubtitleLookupTime(videoTime) - syncOffsetSeconds();
  }

  function renderedSubtitleDomDiagnostics(renderedText) {
    // The selectors come from the adapter, so the diagnostics describe the
    // containers this service actually renders into instead of one service's
    // markup measured on the other service's page.
    const selectors = currentSite()?.nativeCaptionSelectors || [
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
    const simplifiedSelected = simplifiedDiagnosticText(renderedText);
    const midpoint = simplifiedSelected.length / 2;
    return {
      chosenSelector,
      selectedTextId: diagnosticTextId(renderedText),
      selectedTextLength: normalizeText(renderedText).length,
      representationCount: new Set(nonEmptyTextIds).size,
      representationsDisagree: new Set(nonEmptyTextIds).size > 1,
      selectedLooksDuplicated: Number.isInteger(midpoint) && midpoint > 0 &&
        simplifiedSelected.slice(0, midpoint) === simplifiedSelected.slice(midpoint),
      observations,
    };
  }

  function timedTrackMismatchDiagnostics(
    video,
    renderedText,
    naturalMatch,
    matchingCue,
    matchQuality,
    resolution = null,
  ) {
    const foldedRendered = foldedSubtitleText(renderedText);
    const foldedMatches = foldedRendered
      ? cues.filter((cue) => foldedSubtitleText(cue.text) === foldedRendered)
      : [];
    const simplifiedRendered = simplifiedDiagnosticText(renderedText);
    const simplifiedMatches = simplifiedRendered
      ? cues.filter((cue) => simplifiedDiagnosticText(cue.text) === simplifiedRendered)
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
        `${value}${nearbySimplified[index + 1]}` === simplifiedRendered,
    );
    const partialNearbyMatch = Boolean(
      simplifiedRendered.length >= 4 &&
      nearbySimplified.some(
        (value) => value.includes(simplifiedRendered) || simplifiedRendered.includes(value),
      ),
    );
    const naturalTime = naturalSubtitleLookupTime(video.currentTime);
    const nextMatchedCue = matchingCue ? cues[matchingCue.index + 1] : null;

    return {
      ...renderedSubtitleDomDiagnostics(renderedText),
      stableForMs: Math.max(0, Math.round(performance.now() - renderedSubtitleCandidateSince)),
      trackCueCount: cues.length,
      naturalLookupMs: Math.round(naturalTime * 1000),
      userTimingOffsetMs: clamp(settings.subtitleTimingOffsetMs, -2000, 2000, 0),
      automaticTimingOffsetMs: Math.round(automaticCueTimeOffsetSeconds * 1000),
      matchQuality: matchQuality || "none",
      exactTrackMatch: matchQuality === "exact",
      ...matchResolutionDiagnostics(resolution),
      foldedTrackMatchCount: foldedMatches.length,
      foldedMatchCue: foldedMatches.length === 1
        ? diagnosticCue(cueKey(foldedMatches[0]))
        : "",
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

  function validateTimedTrackAgainstRendering(video, renderedText) {
    if (!video || !cues.length) return false;

    const naturalTime = naturalSubtitleLookupTime(video.currentTime);
    const naturalMatch = findCueAt(naturalTime);

    if (!renderedText) {
      if (timedTrackMismatchSince || timedTrackSyncState === "mismatch") {
        logDiagnostic("info", "synchronization", "timed-track-mismatch-ended", {
          mismatchId: activeTimedTrackMismatchId,
          outcome: "rendered-subtitle-gap",
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
      subtitleTextsMatch(naturalMatch.cue.text, renderedText)
    ) {
      if (timedTrackMismatchSince || timedTrackSyncState === "mismatch") {
        logDiagnostic("info", "synchronization", "timed-track-mismatch-resolved", {
          mismatchId: activeTimedTrackMismatchId,
          outcome: "exact-match",
          durationMs: timedTrackMismatchSince
            ? Math.round(performance.now() - timedTrackMismatchSince)
            : null,
          previousReason: lastTimedTrackMismatch || "confirmed-mismatch",
          renderedTextId: diagnosticTextId(renderedText),
        }, cueKey(naturalMatch.cue));
      }
      timedTrackSyncState = "verified";
      lastRenderedSyncText = renderedText;
      timedTrackMismatchSince = 0;
      lastTimedTrackMismatch = "";
      activeTimedTrackMismatchId = 0;
      return true;
    }

    const resolution = findCueResolution(renderedText, naturalTime);
    const exactMatchingCue =
      resolution?.cue && resolution.tier === foldedMatchTier()
        ? { cue: resolution.cue, index: resolution.index }
        : null;
    const approximatedCue = exactMatchingCue
      ? null
      : resolution?.cue
        ? resolution
        : null;
    const matchingCue = exactMatchingCue || approximatedCue;
    const matchQuality = matchQualityOf(exactMatchingCue, approximatedCue);

    if (
      naturalMatch &&
      approximatedCue &&
      approximatedCue.index === naturalMatch.index
    ) {
      if (timedTrackMismatchSince || timedTrackSyncState === "mismatch") {
        logDiagnostic("info", "synchronization", "timed-track-mismatch-resolved", {
          mismatchId: activeTimedTrackMismatchId,
          outcome: "formatting-current-cue-match",
          durationMs: timedTrackMismatchSince
            ? Math.round(performance.now() - timedTrackMismatchSince)
            : null,
          previousReason: lastTimedTrackMismatch || "confirmed-mismatch",
          ...matchResolutionDiagnostics(approximatedCue),
        }, cueKey(naturalMatch.cue));
      }
      if (!subtitleTextsMatch(lastRenderedSyncText, renderedText)) {
        logDiagnostic("info", "synchronization", "formatting-match-accepted", {
          matchQuality,
          ...matchResolutionDiagnostics(approximatedCue),
          renderedTextLength: normalizeText(renderedText).length,
          capturedTextLength: normalizeText(naturalMatch.cue.text).length,
        }, cueKey(naturalMatch.cue));
      }
      timedTrackSyncState = "verified";
      lastRenderedSyncText = renderedText;
      timedTrackMismatchSince = 0;
      lastTimedTrackMismatch = "";
      activeTimedTrackMismatchId = 0;
      return true;
    }

    if (isInterCueGapMatch(matchingCue, naturalTime, naturalMatch)) {
      timedTrackSyncState = "verified";
      lastRenderedSyncText = renderedText;
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
      // line the player is displaying. A later visible line will refine the anchor.
      automaticCueTimeOffsetSeconds =
        matchingCue.cue.start + 0.04 - Number(video.currentTime);
      timedTrackSyncState = "verified";
      lastRenderedSyncText = renderedText;
      timedTrackMismatchSince = 0;
      lastTimedTrackMismatch = "";
      logDiagnostic("info", "synchronization", "timed-track-anchored", {
        matchQuality,
        ...matchResolutionDiagnostics(resolution),
        automaticOffsetMs: Math.round(automaticCueTimeOffsetSeconds * 1000),
      }, cueKey(matchingCue.cue));
      return true;
    }

    if (timedTrackSyncState === "verified") {
      const mismatch = exactMatchingCue
        ? "known-cue-boundary"
        : approximatedCue
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
            renderedText,
            naturalMatch,
            matchingCue,
            matchQuality,
            resolution,
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
        lastRenderedSyncText = renderedText;
        logDiagnostic("warning", "synchronization", "timed-track-reanchored", {
          reason: mismatchReason,
          mismatchId,
          durationMs: mismatchDurationMs,
          automaticOffsetMs: Math.round(automaticCueTimeOffsetSeconds * 1000),
          cueDistance: Number.isFinite(cueDistance) ? cueDistance : null,
          matchQuality,
          ...matchResolutionDiagnostics(resolution),
        }, cueKey(matchingCue.cue));
        return true;
      }
    }

    if (timedTrackSyncState !== "mismatch") {
      logDiagnostic("warning", "synchronization", "timed-track-mismatch-confirmed", {
        mismatchId: activeTimedTrackMismatchId,
        reason: exactMatchingCue
          ? "known-cue-boundary"
          : approximatedCue
            ? "formatting-cue-boundary"
            : "unknown-text",
        retainedTimedSubtitle: true,
        durationMs: timedTrackMismatchSince
          ? Math.round(performance.now() - timedTrackMismatchSince)
          : null,
        ...timedTrackMismatchDiagnostics(
          video,
          renderedText,
          naturalMatch,
          matchingCue,
          matchQuality,
          resolution,
        ),
      }, naturalMatch ? cueKey(naturalMatch.cue) : "");
    }
    timedTrackSyncState = "mismatch";
    lastRenderedSyncText = renderedText;
    return false;
  }

  function isTimedCueStillCurrent(key) {
    const video = activeVideo();
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
    const videoTime = Number(activeVideo()?.currentTime);
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

    const video = activeVideo();
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

  // Which surrounding lines travel with a request — and why — belongs to
  // translation-context.js, so the reference lines sent to the provider are the
  // ones the options page and the README describe: judged by the silence
  // between them and the nearest requested line rather than by how many cue
  // indexes away they are. This file contributes the one thing the module cannot
  // know: which cue indexes the requested cues are, because what makes two cues
  // the same cue is decided by cue identity.
  function translationContextApi() {
    const api = globalThis.LSTTranslationContext;
    if (api) return api;
    if (!warnedMissingTranslationContext) {
      warnedMissingTranslationContext = true;
      console.warn(
        "[LST] translation-context.js is missing; translations are sent without surrounding context.",
      );
    }
    return null;
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

    const api = translationContextApi();
    if (!api) {
      // Without the module there is no rule to apply, and guessing one from cue
      // indexes is exactly what used to send a line from another scene as
      // context. The request goes out without context, and says so.
      logDiagnostic(
        "warning",
        "translation",
        "translation-context-skipped",
        {
          reason: "translation-context-unavailable",
          requestedCues: selectedCues.length,
          targetCues: targetIndexes.length,
        },
        cueKey(selectedCues[0]),
      );
      return [];
    }

    const selection = api.selectContext({
      scope: cues,
      targetIndexes,
      requestedCount: selectedCues.length,
      // The setting is checked above so that a feature which is off by default
      // does not write an event for every request.
      enabled: true,
    });

    logDiagnostic(
      selection.items.length ? "info" : "warning",
      "translation",
      "translation-context-selected",
      {
        reason: selection.reason,
        requestedCues: selectedCues.length,
        targetCues: selection.targets,
        contextCues: selection.items.length,
        before: selection.positions.before,
        after: selection.positions.after,
        overlapping: selection.positions.overlapping,
        refused: selection.refused,
        limits: api.describeLimits(),
      },
      cueKey(selectedCues[0]),
    );

    return selection.items;
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
    // A navigation must not write late results into the next episode.
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

      // The background is the last check before a request reaches a provider. If
      // it refused or shortened the context this request sent, the reason travels
      // back with the response and is recorded here.
      const contextReport = response.summary || {};
      if (
        contextItems.length &&
        contextReport.contextReason &&
        contextReport.contextReason !== "ok"
      ) {
        logDiagnostic(
          "warning",
          "translation",
          "translation-context-rejected",
          {
            reason: contextReport.contextReason,
            sentCues: contextReport.contextSentCues || contextItems.length,
            usedCues: contextReport.contextCueCount || 0,
            refusedCues: contextReport.contextRefusedCues || 0,
            queue: precomputeInProgress ? "precompute" : "playback",
          },
          cueKey(missing[0]),
        );
      }

      const rejectedFailures = (response.failures || []).filter(
        (failure) => failure?.verification,
      );
      if (rejectedFailures.length) {
        logDiagnostic("warning", "translation", "translation-verification-failed", {
          count: rejectedFailures.length,
          reason: rejectedFailures[0].verification,
          error: rejectedFailures[0].error || "",
        }, cueKey(missing[0]));
      }

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
    // Nothing is asked of a provider for a track that needs no translation.
    if (!trackNeedsTranslation()) return;

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
          activeVideo()?.currentTime,
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
            activeVideo()?.currentTime,
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
    const playbackTime = Number(activeVideo()?.currentTime);
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
      !trackNeedsTranslation() ||
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
      siteTitleMetadata();
      persistImprovedCacheMetadata();
    }

    const video = activeVideo();
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
      lastRenderedSyncText = "";
      timedTrackMismatchSince = 0;
      lastTimedTrackMismatch = "";
      timedTrackMismatchSequence = 0;
      activeTimedTrackMismatchId = 0;
      lastFallbackText = "";
      renderedSubtitleCandidate = "";
      renderedSubtitleCandidateSince = 0;
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
      lastEpisodeNumber = null;
      logDiagnostic("info", "track", "episode-changed", {});
      setStatus("Episode changed — waiting for its subtitle track…", true);
      handleFallbackRenderedSubtitle();
      // The next episode has its own episode key, so an import made for the
      // episode that just ended is not carried over to this one.
      cueTrackKind = "none";
      importedTrack = null;
      currentStatus.subtitleSource = "none";
      currentStatus.importedFileName = "";
      refreshImportedTrack({ reason: "episode-changed", force: true }).catch((error) => {
        console.warn("[LST] Could not check for imported subtitles:", error);
      });
      // Another episode may be another show, and a show LST already knows
      // something about should say so on the episode the viewer moved to.
      refreshJimakuFinding({ reason: "episode-changed" }).catch((error) => {
        console.warn("[LST] Could not read what Jimaku holds for this show:", error);
      });
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
    // An imported track brings its own timeline, so the player is not asked to
    // render anything for LST to know which cue is playing. This is the case an
    // imported track exists for: a title the service does not subtitle at all.
    const importedNow = trackIsImported();
    if (!importedNow) {
      const renderedObservation = observeRenderedSubtitle();
      const renderedText = renderedObservation.text;
      if (
        !renderedObservation.stable &&
        timedTrackSyncState !== "verified"
      ) {
        currentStatus.playbackMode = `waiting for stable ${siteName()} subtitle`;
        updateDebugPanel();
        requestAnimationFrame(playbackLoop);
        return;
      }
      if (
        renderedObservation.stable &&
        !validateTimedTrackAgainstRendering(video, renderedText)
      ) {
        currentStatus.activeCueStart = null;
        currentStatus.activeCueEnd = null;
        currentStatus.playbackMode = renderedText
          ? "DOM fallback (unverified timed track)"
          : "waiting for subtitle sync";
        updateDebugPanel();
        focusTranscriptCue(findCueMatchingText(renderedText, subtitleLookupTime(video.currentTime)));
        if (renderedText) handleFallbackRenderedSubtitle();
        requestAnimationFrame(playbackLoop);
        return;
      }
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
      // when the service is also between subtitles.
      if (
        lastRenderedCueKey &&
        !shouldRetainRenderedSubtitle(lastRenderedCueKey, video.currentTime) &&
        performance.now() - noTimedCueSince > 220 &&
        !findRenderedSubtitle()
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
      const cachedTranslation = knownCachedTranslations.get(key) || "";
      // A track that needs no translation displays itself: the line the viewer
      // reads is the line in the file, and no provider is asked for anything.
      const needsTranslation = trackNeedsTranslation();
      // Without translation the line shown is the line in the file. A cached
      // translation is deliberately not used here: it may belong to a language
      // the viewer has since changed away from.
      const displayed = needsTranslation ? cachedTranslation : match.cue.text;
      beginRenderedSubtitle({
        key,
        original: match.cue.text,
        translated: displayed,
        naturalEndVideoTime:
          match.cue.end -
          automaticCueTimeOffsetSeconds +
          syncOffsetSeconds(),
        videoTime: video.currentTime,
        source: "timed",
      });
      if (!needsTranslation) {
        currentStatus.playbackMode = "imported track (no translation)";
        currentStatus.lastTranslatedText = truncate(match.cue.text);
        requestAnimationFrame(playbackLoop);
        return;
      }
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

  // What subtitle text is on screen right now. The adapter decides how a
  // service renders a line: Netflix puts a whole cue in one timed-text
  // container, Prime Video rewrites one span per line in place. Reading a
  // container on Prime would harvest player title and timer text as if it were
  // a subtitle, which is why the question belongs to the adapter.
  function findRenderedSubtitle() {
    const site = currentSite();
    if (site) {
      try {
        return normalizeText(site.renderedSubtitleLines(document).text || "");
      } catch {
        // Fall through to the legacy read rather than reporting a subtitle that
        // is not there.
      }
    }
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

  // Prime reuses one caption element and rewrites its text, so a cue boundary is
  // a text change and not a new element. The stable-text window already produces
  // that boundary, and the state between cues is the zero-length text the
  // adapter reports when no caption span carries anything.
  function observeRenderedSubtitle() {
    const text = findRenderedSubtitle();
    const now = performance.now();
    if (text !== renderedSubtitleCandidate) {
      renderedSubtitleCandidate = text;
      renderedSubtitleCandidateSince = now;
    }
    return {
      text,
      stable:
        now - renderedSubtitleCandidateSince >=
        RENDERED_SUBTITLE_STABILITY_MS,
    };
  }

  async function handleFallbackRenderedSubtitle() {
    if (!playbackActive || !isWatchPage() || !settings.enabled || !settings.model) return;
    // The DOM fallback exists because a captured track can fail to be confirmed
    // against what the player draws. An imported track needs no confirmation —
    // it is a file — so reading the service's captions here would only add a
    // second, unrelated subtitle to the screen.
    if (trackIsImported()) return;
    const generation = playbackGeneration;

    const observation = observeRenderedSubtitle();
    const text = observation.text;
    if (!observation.stable) {
      clearTimeout(fallbackTimer);
      fallbackTimer = setTimeout(
        handleFallbackRenderedSubtitle,
        RENDERED_SUBTITLE_STABILITY_MS,
      );
      return;
    }
    if (!text) {
      if (
        lastFallbackText &&
        String(currentStatus.playbackMode).startsWith("DOM")
      ) {
        const video = activeVideo();
        const fallbackKey = cueKey(fallbackCueForText(lastFallbackText));
        if (shouldRetainRenderedSubtitle(fallbackKey, video?.currentTime))
          return;
        lastFallbackText = "";
        removeRenderedSubtitle(fallbackKey, "rendered-subtitle-ended");
      }
      return;
    }
    if (text === lastFallbackText) return;

    const video = activeVideo();
    // Only let timed text take over after its underlying line has been checked
    // against what the player renders. This also respects a user timing offset,
    // which may make the intentionally rendered LST cue differ from the
    // player's current cue.
    if (
      video &&
      timedTrackSyncState !== "mismatch" &&
      validateTimedTrackAgainstRendering(video, text)
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
        const videoTime = activeVideo()?.currentTime;
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

    // The player sometimes updates subtitle layout without a useful mutation on the
    // exact text node we observed. This lightweight poll keeps the fallback honest.
    const interval = setInterval(handleFallbackRenderedSubtitle, 350);
    return () => {
      observer.disconnect();
      clearInterval(interval);
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    };
  }

  // `details` is how the document was found, not what is in it: the page world
  // says whether it captured a document as it went past or fetched a whole track
  // from a playback-resources listing, which language that track declared, and
  // which rule chose it. It is recorded with the track so the event log can
  // explain a Prime capture, and it never carries the caption text.
  async function acceptSubtitleDocument(url, text, details = {}) {
    if (!playbackActive || !isWatchPage()) return;
    // A track the viewer imported is the track this episode uses. Captured
    // documents keep arriving while it plays, and they are refused by name
    // rather than allowed to replace a file the viewer chose.
    if (trackIsImported()) {
      logDiagnostic("info", "track", "subtitle-track-ignored", {
        reason: "imported-track-in-use",
        incomingUrl: shortUrl(url),
      });
      return;
    }
    const generation = playbackGeneration;
    const parsed = parseSubtitleDocument(text);
    if (!parsed.length) return;

    parsed.sort((a, b) => a.start - b.start);

    // A captured document is either the track already in use, another part of
    // it, or a different track. Membership and time coverage decide which, and
    // the decision is reported either way.
    const sameVideo = cueVideoId === getVideoId();
    const existingCues = sameVideo ? cues : [];
    const renderedText = existingCues.length ? findRenderedSubtitle() : "";
    const decision = resolveTrackDecision(existingCues, parsed, renderedText);

    if (!decision.accept) {
      logDiagnostic("info", "track", "subtitle-track-kept", {
        incomingUrl: shortUrl(url),
        ...trackDecisionDiagnostics(decision),
      });
      return;
    }

    cues = adoptCapturedTrack(existingCues, parsed, decision);
    cueSourceUrl = url || "captured";
    cueVideoId = getVideoId();
    cueTrackKind = "captured";
    importedTrack = null;
    currentStatus.subtitleSource = "captured";
    currentStatus.importedFileName = "";
    // A document that still contains every cue of the current track cannot
    // invalidate the synchronization already confirmed for it, so only
    // a replacement re-derives the timeline.
    if (!decision.union) {
      timedTrackSyncState = "unverified";
      automaticCueTimeOffsetSeconds = 0;
      lastRenderedSyncText = "";
      timedTrackMismatchSince = 0;
      lastTimedTrackMismatch = "";
      activeTimedTrackMismatchId = 0;
      translationCoordinator = null;
      removeRenderedSubtitlesBySource("timed", "new-subtitle-track");
    }
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
      incomingUrl: shortUrl(url),
      capture: details.capture || "document",
      sourceLanguage: details.language || "unknown",
      ...trackDecisionDiagnostics(decision),
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

  // Imported tracks ----------------------------------------------------------
  //
  // A viewer watching a title the service does not subtitle can attach a
  // subtitle file instead, and that file becomes the episode's track: its cues
  // drive the overlay and the transcript, and the service's own captions stop
  // being the source of anything. Because the file carries its own timeline, a
  // service that draws no captions at all still gets subtitles — the clock
  // decides which cue is on screen instead of a rendered line, which is exactly
  // the case an imported track exists for.
  //
  // A file already written in the language the viewer asked for is displayed
  // without asking any translation provider for anything. That decision is made
  // when the file is imported, stored with it, and reported in its reason.

  let importedTrack = null;
  let cueTrackKind = "none";
  let warnedMissingSubtitleImport = false;

  function subtitleImport() {
    const api = globalThis.LSTSubtitleImport;
    if (api) return api;
    if (!warnedMissingSubtitleImport) {
      warnedMissingSubtitleImport = true;
      console.warn(
        "[LST] subtitle-import.js is missing; imported subtitles cannot be used.",
      );
    }
    return null;
  }

  // An imported track is keyed by episode rather than by cache id, because the
  // cache id also names the model and the target language, and changing either
  // must not lose the file the viewer imported.
  function importedEpisodeKey() {
    const api = subtitleImport();
    if (!api) return "";
    const videoId = cueVideoId || getVideoId();
    const identity = episodeIdentity();
    if (identity?.encodeEpisodeKey) {
      return identity.encodeEpisodeKey({ videoId, siteId: currentSiteId() });
    }
    return api.episodeKeyFor(videoId, currentSiteId());
  }

  function trackIsImported() {
    return cueTrackKind === "imported" && Boolean(importedTrack);
  }

  // Whether this track has to reach a translation provider at all. Everything
  // that would spend a request asks this first.
  function trackNeedsTranslation() {
    if (!trackIsImported()) return true;
    return importedTrack.translate !== false;
  }

  // Whether an imported file has to be translated, for the language the viewer
  // asks for now. A decision the viewer made stands forever; one LST made is made
  // again against the language they want now, because the file has not changed but
  // the question has. One owner, so adopting a file and re-checking one already in
  // use cannot answer it differently.
  function resolveTranslateDecision(track) {
    const api = subtitleImport();
    if (track?.translateReason === "viewer-choice" || !api?.needsTranslation) {
      return {
        translate: track?.translate !== false,
        translateReason: track?.translateReason || "",
      };
    }
    const decision = api.needsTranslation({
      language: track.language,
      targetLanguage: settings.targetLanguage,
      sampleText: String(track.text || "").slice(0, 4000),
    });
    return { translate: decision.translate, translateReason: decision.reason };
  }

  function importedTrackSummary() {
    if (!importedTrack) return null;
    return {
      source: "imported",
      episodeKey: importedTrack.episodeKey,
      fileName: importedTrack.fileName,
      entryName: importedTrack.entryName,
      entryId: importedTrack.entryId,
      language: importedTrack.language,
      languageCode: importedTrack.languageCode,
      format: importedTrack.format,
      cueCount: importedTrack.cueCount,
      importedAt: importedTrack.importedAt,
      translate: importedTrack.translate !== false,
      translateReason: importedTrack.translateReason,
      // Where this file's own timeline sits on the video's clock, so the popup
      // and the player move the same number and describe it the same way.
      timingOffsetMs: fileTimingOffsetMs(),
    };
  }

  function importedTrackStatusText() {
    const name = importedTrack?.fileName || "imported subtitles";
    const cueCount = `${cues.length} cue${cues.length === 1 ? "" : "s"}`;
    const described = subtitleImport()?.describeFileTiming?.(fileTimingOffsetMs());
    const timing = described?.offsetMs ? ` · timing ${described.label}` : "";
    return trackNeedsTranslation()
      ? `Imported subtitles: ${name} · ${cueCount}${timing}.`
      : `Imported subtitles: ${name} · ${cueCount}${timing} · already ` +
          `${importedTrack.language || "in your language"}, so nothing is translated.`;
  }

  // What Jimaku held for this show when LST last asked, and which show the answer
  // belongs to. Its whole point is that reading it asks nobody: the note was
  // written when the viewer searched Jimaku, and the player reads it when an
  // episode starts, so arriving at a title can be told what exists for it
  // without a request leaving the browser. The one exception is the viewer
  // pressing "Check Jimaku", which is their request and not a page's.
  let jimakuFinding = null;
  let jimakuFindingKey = "";
  let jimakuCheckPending = false;
  // The shows whose note the viewer has closed. It lasts as long as the page
  // does, and one show's dismissal is never another's.
  const jimakuNoteDismissed = new Set();
  let jimakuNote;
  let jimakuNoteText;
  function showKey() {
    const identity = episodeIdentity();
    if (!identity?.encodeShowKey) return "";
    const metadata = cacheMetadata();
    return identity.encodeShowKey({
      showName: metadata.showName,
      siteId: metadata.siteId,
    });
  }

  function jimakuFindingText() {
    const api = subtitleImport();
    if (!api?.describeJimakuFinding || !jimakuFinding) return null;
    return api.describeJimakuFinding(jimakuFinding, { now: Date.now() });
  }

  // Read what is known about this show. Called where the episode is, rather than
  // on a timer, so a viewer who never settles on a title asks nothing.
  async function refreshJimakuFinding({ reason = "episode", force = false } = {}) {
    if (!playbackActive || !isWatchPage()) return;
    const api = subtitleImport();
    if (!api?.normalizeJimakuFinding) return;
    const key = showKey();
    if (!key) {
      if (jimakuFinding || jimakuFindingKey) {
        jimakuFinding = null;
        jimakuFindingKey = "";
        updateQuickPills();
      }
      return;
    }
    if (!force && key === jimakuFindingKey) return;
    jimakuFindingKey = key;
    let response;
    try {
      response = await runtimeMessage({ type: "GET_JIMAKU_FINDING", showKey: key });
    } catch (error) {
      logDiagnostic("warning", "import", "jimaku-finding-unavailable", {
        reason: "background-unavailable",
      });
      return;
    }
    // The viewer may have moved on to another show while the answer was in
    // flight, in which case the note belongs to a show that is no longer on
    // screen.
    if (jimakuFindingKey !== key) return;
    jimakuFinding = api.normalizeJimakuFinding(response?.finding) || null;
    logDiagnostic("info", "import", "jimaku-finding-read", {
      reason: jimakuFindingText()?.reason || response?.reason || api.FINDING_REASON.none,
      entryCount: jimakuFinding?.entryCount ?? 0,
      fileCount: jimakuFinding?.fileCount ?? null,
      episode: jimakuFinding?.episode ?? null,
      source: reason,
    });
    updateQuickPills();
  }

  // A note about Jimaku outlives the status line, which every other message
  // replaces — often within a second of arriving, which is exactly what makes a
  // notice there useless. This is the sentence on screen, dismissed by the viewer
  // and by nothing else, and never drawn over subtitles the viewer is reading.
  function updateJimakuNote() {
    if (!jimakuNote || !jimakuNoteText) return;
    const show = jimakuFinding?.showKey || "";
    const described = trackIsImported() ? null : jimakuFindingText();
    jimakuNote.hidden =
      !described ||
      jimakuNoteDismissed.has(show) ||
      settings.showStatusMessages === false;
    if (jimakuNote.hidden) return;
    jimakuNoteText.textContent =
      described.tone === "warn"
        ? `${described.headline}. Try another spelling in the LST controls.`
        : `${described.headline}. Import one from the LST controls.`;
    jimakuNote.dataset.tone = described.tone;
  }

  // The note the background just wrote, adopted here so the player can say the
  // answer without asking for it a second time.
  function adoptJimakuFinding(finding) {
    const api = subtitleImport();
    const normalized = api?.normalizeJimakuFinding
      ? api.normalizeJimakuFinding(finding)
      : null;
    if (!normalized) return null;
    // A note is this tab's note only when it names the show this tab is on. The
    // same message reaches every tab, and the others are watching something else.
    if (normalized.showKey !== showKey()) return null;
    jimakuFinding = normalized;
    jimakuFindingKey = normalized.showKey;
    updateQuickPills();
    return jimakuFindingText();
  }

  // The one request LST sends about a show the viewer only opened, and it is
  // sent because they pressed a button. Nothing else asks Jimaku on arrival, so a
  // page that is merely opened cannot tell anyone which shows are being watched.
  async function checkJimakuForShow() {
    if (jimakuCheckPending) return;
    const api = subtitleImport();
    const metadata = cacheMetadata();
    const query = api?.queryFromShowName ? api.queryFromShowName(metadata.showName) : "";
    if (!query) {
      setStatus(
        "LST has no show name to search for yet. Wait for the title to load, then press Check Jimaku again.",
        true,
      );
      return;
    }
    jimakuCheckPending = true;
    setStatus(`Asking Jimaku about “${query}”…`, true);
    try {
      const response = await runtimeMessage({
        type: "IMPORT_SEARCH",
        query,
        showKey: showKey(),
        showName: metadata.showName,
        siteId: metadata.siteId,
      });
      const described = adoptJimakuFinding(response?.finding);
      const entryCount = Number(response?.entries?.length) || 0;
      logDiagnostic("info", "import", "jimaku-checked", {
        reason: described?.reason || api?.FINDING_REASON?.none || "no-finding-yet",
        entryCount,
      });
      if (described) {
        setStatus(`${described.headline}.`, true);
      } else if (entryCount) {
        setStatus(
          `Jimaku lists ${entryCount} entr${entryCount === 1 ? "y" : "ies"} for “${query}”.`,
          true,
        );
      } else {
        setStatus(`Jimaku lists nothing for “${query}”.`, true);
      }
    } finally {
      jimakuCheckPending = false;
      updateQuickPills();
    }
  }

  // An imported track replaces the captured one through the same adoption path a
  // captured document takes, with the two differences that matter: the timeline
  // is trusted because it came from a file rather than from the player, and the
  // source is recorded as imported.
  async function adoptImportedTrack(track) {
    const api = subtitleImport();
    const normalized = api ? api.normalizeImportedTrack(track) : null;
    if (!normalized) {
      logDiagnostic("warning", "import", "imported-track-unreadable", {
        reason: "not-a-track",
      });
      return false;
    }

    let parsed = [];
    try {
      parsed = parseSubtitleDocument(normalized.text);
    } catch (error) {
      logDiagnostic("warning", "import", "imported-track-unreadable", {
        reason: "parse-failed",
        format: normalized.format,
      });
      return false;
    }
    if (!parsed.length) {
      logDiagnostic("warning", "import", "imported-track-unreadable", {
        reason: "no-readable-cues",
        format: normalized.format,
      });
      return false;
    }
    parsed.sort((left, right) => left.start - right.start);

    // The decision about translating was stored with the track so it survives a
    // reload, but the viewer's target language can change after an import. A
    // decision the viewer made stands; one LST made is made again against the
    // language they want now.
    Object.assign(normalized, resolveTranslateDecision(normalized));

    cacheGeneration++;
    precomputeCancelled = true;
    cues = parsed;
    cueTrackKind = "imported";
    importedTrack = normalized;
    cueSourceUrl = normalized.fileUrl || "imported";
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
    // The file states its own timeline, so there is nothing to synchronize and
    // nothing to auto-align; the viewer's timing offset is the only adjustment.
    timedTrackSyncState = "verified";
    automaticCueTimeOffsetSeconds = 0;
    lastRenderedSyncText = "";
    timedTrackMismatchSince = 0;
    lastTimedTrackMismatch = "";
    activeTimedTrackMismatchId = 0;
    lastRenderedCueKey = "";
    removeRenderedSubtitlesBySource("timed", "imported-track");
    currentStatus.captured = true;
    currentStatus.cueCount = cues.length;
    currentStatus.translatedCount = 0;
    currentStatus.subtitleSource = "imported";
    currentStatus.importedFileName = normalized.fileName;
    currentStatus.playbackMode = trackNeedsTranslation()
      ? "imported track"
      : "imported track (no translation)";
    renderTranscript();
    updateProgress();
    logDiagnostic("info", "import", "imported-track-adopted", {
      cueCount: cues.length,
      format: normalized.format,
      language: normalized.language || "unknown",
      translate: trackNeedsTranslation(),
      translateReason: normalized.translateReason || "unspecified",
      entryId: normalized.entryId,
    });
    setStatus(importedTrackStatusText(), true);
    // The timing controls point at this file's own clock from now on, so the
    // panel switches with the track rather than waiting for the next refresh.
    updateQuickPills();

    // Lines of this file that were translated for this episode before are
    // already cached under the same cache id, so they render immediately and
    // the progress figure starts from what is really left.
    if (trackNeedsTranslation()) {
      try {
        await getCachedTranslations(cues);
      } catch (error) {
        console.warn("[LST] Could not read this episode's cached translations:", error);
      }
    }
    return true;
  }

  // Returning to the captured track is the same teardown an episode change does,
  // minus the episode change.
  function releaseImportedTrack(reason) {
    if (cueTrackKind !== "imported") return;
    cacheGeneration++;
    precomputeCancelled = true;
    cues = [];
    cueSourceUrl = "";
    cueTrackKind = "none";
    importedTrack = null;
    translationCoordinator = null;
    knownCachedKeys = new Set();
    knownCachedTranslations = new Map();
    pausedCacheFailedKeys = new Set();
    timedTrackSyncState = "unverified";
    automaticCueTimeOffsetSeconds = 0;
    lastRenderedSyncText = "";
    currentStatus.captured = false;
    currentStatus.cueCount = 0;
    currentStatus.translatedCount = 0;
    currentStatus.subtitleSource = "none";
    currentStatus.importedFileName = "";
    clearRenderedSubtitle(reason);
    renderTranscript();
    // The timing controls point at the global setting again now that no file is
    // in use, so the panel has to say so.
    updateQuickPills();
    logDiagnostic("info", "import", "imported-track-released", { reason });
  }

  // Ask the background what was imported for this episode. Called when playback
  // starts, when the episode changes, and when an import is added or removed on
  // another page, so the player never keeps a track the viewer has deleted.
  async function refreshImportedTrack({ reason = "playback-start", force = false } = {}) {
    if (!playbackActive || !isWatchPage()) return;
    const generation = playbackGeneration;
    const episodeKey = importedEpisodeKey();
    if (!episodeKey) {
      if (cueTrackKind === "imported") releaseImportedTrack("no-episode-key");
      return;
    }
    if (
      !force &&
      cueTrackKind === "imported" &&
      importedTrack?.episodeKey === episodeKey
    ) {
      return;
    }

    let response;
    try {
      response = await runtimeMessage({ type: "GET_IMPORTED_TRACK", episodeKey });
    } catch (error) {
      logDiagnostic("warning", "import", "imported-track-unavailable", {
        reason: "background-unavailable",
      });
      return;
    }
    if (generation !== playbackGeneration || !playbackActive || !isWatchPage()) return;
    // The viewer may have moved to another episode while the answer was in
    // flight, in which case the answer describes a track that is not this
    // page's track.
    if (importedEpisodeKey() !== episodeKey) return;

    const track = response?.track;
    if (!track) {
      if (cueTrackKind === "imported") releaseImportedTrack(response?.reason || "removed");
      return;
    }
    const unchanged =
      importedTrack?.episodeKey === track.episodeKey &&
      importedTrack?.importedAt === track.importedAt;
    if (unchanged && !force) return;
    if (unchanged) {
      // The same file, from the same import: the only thing that can have moved is
      // where its timeline sits — the number the viewer moves from the player — or
      // the language they asked for, which decides whether the file needs
      // translating at all. A correction is applied in place, so the line on
      // screen is not re-read and re-adopted under them; a different decision about
      // translating takes the whole path, because it changes what the player does
      // with every line of the file.
      const decision = resolveTranslateDecision(track);
      if (Boolean(decision.translate) === (importedTrack.translate !== false)) {
        applyImportedFileTiming(track.timingOffsetMs);
        return;
      }
    }

    if (await adoptImportedTrack(track)) {
      logDiagnostic("info", "import", "imported-track-loaded", { reason });
      return;
    }
    // An unreadable file must not leave LST silent with no way back to the
    // track the service is still delivering.
    if (cueTrackKind === "imported") releaseImportedTrack("unreadable");
  }

  async function precomputeAll() {
    if (precomputeInProgress) return;
    if (!settings.model && trackNeedsTranslation()) {
      throw new Error("Choose a translation model in extension settings first.");
    }
    if (!trackNeedsTranslation()) {
      // The imported file is already written in the language the viewer asked
      // for, so there is nothing to precompute and nothing to spend.
      setStatus(
        `This episode uses imported subtitles already in ` +
          `${importedTrack?.language || settings.targetLanguage}, so no translation is needed.`,
        true,
      );
      return;
    }
    if (!cues.length) {
      throw new Error(
        `No full subtitle track captured yet. Turn on a ${siteName()} subtitle track, then retry.`,
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

      const videoTime = Number(activeVideo()?.currentTime);
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
        refreshCacheCoverage(activeVideo()?.currentTime);
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
      throw new Error(`Open a ${siteName()} watch page first.`);
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

  // A track can be captured before LST has noticed that a player is in use. The
  // player asks for its resources the moment it starts, and LST notices a
  // player on its next pass — so the request that names the episode's subtitles
  // can arrive first, and it is not repeated on demand. The newest document is
  // therefore held here and adopted as soon as playback starts, rather than
  // dropped and waited for again.
  let pendingSubtitleDocument = null;

  function handleCapturedDocument(payload) {
    const { url, text, site, capture = "", language = "", reason = "" } = payload || {};
    // A document captured on one service is never adopted by the other: the
    // page hook tags what it publishes, and a mismatch is reported rather than
    // trusted, because a subtitle track from another site would be filed under
    // this one's cache id.
    if (site && site !== currentSiteId()) {
      logDiagnostic("info", "track", "subtitle-document-other-site", {
        documentSiteId: site,
        pageSiteId: currentSiteId() || "none",
        incomingUrl: shortUrl(url),
      });
      return;
    }
    acceptSubtitleDocument(url, text, { capture, language, reason }).catch((error) => {
      console.warn("[LST] Could not parse captured subtitles:", error);
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== SOURCE) return;
    if (!playbackActive || !isWatchPage()) {
      // Only a document is worth keeping; a note about a capture that already
      // happened would describe a page state the log is no longer on.
      if (event.data?.type === "SUBTITLE_DOCUMENT") pendingSubtitleDocument = event.data.payload;
      return;
    }

    // Why the page world found no track to hand over. It is a note rather than a
    // document — no subtitle text, only the reason and what it saw — and its
    // job is to put the capture's own answer in the event log, which is where a
    // viewer can find out why a title has no full track instead of watching LST
    // wait.
    if (event.data?.type === "SUBTITLE_CAPTURE") {
      const { site, event: captureEvent, reason, trackCount, language } =
        event.data.payload || {};
      if (site && site !== currentSiteId()) return;
      logDiagnostic("info", "track", `capture-${captureEvent || "note"}`, {
        reason: reason || "unspecified",
        trackCount: Number(trackCount) || 0,
        language: language || "unknown",
      });
      return;
    }

    if (event.data?.type !== "SUBTITLE_DOCUMENT") return;

    handleCapturedDocument(event.data.payload);
  });

  ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      switch (message?.type) {
        case "GET_PAGE_STATUS": {
          refreshCacheCoverage(activeVideo()?.currentTime);
          const metadata = cacheMetadata();
          sendResponse({
            ok: true,
            status: {
              ...currentStatus,
              videoId: getVideoId(),
              siteId: currentSiteId(),
              showName: metadata.showName,
              episodeName: metadata.episodeName,
              episodeNumber: lastEpisodeNumber,
              sourceUrl: cueSourceUrl,
              enabled: settings.enabled,
              model: settings.model,
              targetLanguage: settings.targetLanguage,
              imported: importedTrackSummary(),
              jimaku: jimakuFinding,
            },
          });
          return;
        }

        case "JIMAKU_CHANGED": {
          // The viewer searched or listed files in the import card. The note the
          // background wrote is handed over here so the player can say what was
          // found without asking Jimaku a second time.
          if (message.cleared) {
            // Only the note for the show being cleared is dropped; another tab
            // may be watching a show the viewer did keep.
            if (message.showKey && message.showKey === jimakuFindingKey) {
              jimakuFinding = null;
              updateQuickPills();
            }
            sendResponse({ ok: true, applied: true, reason: "cleared" });
            return;
          }
          const described = adoptJimakuFinding(message.finding);
          sendResponse({ ok: true, applied: Boolean(described), reason: described?.reason || "" });
          return;
        }

        case "IMPORT_CHANGED": {
          // An import was added, replaced or removed on another page. The player
          // picks the change up now instead of at the next episode change.
          if (!playbackActive || !isWatchPage()) {
            sendResponse({ ok: true, applied: false, reason: "not-playing" });
            return;
          }
          await refreshImportedTrack({ reason: "import-changed", force: true });
          sendResponse({
            ok: true,
            applied: trackIsImported(),
            imported: importedTrackSummary(),
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
          // Changing the target language can change whether an imported file
          // still needs translating.
          if (trackIsImported()) {
            const wasTranslating = trackNeedsTranslation();
            await refreshImportedTrack({ reason: "settings-changed", force: true });
            if (playbackActive && wasTranslating !== trackNeedsTranslation()) {
              setStatus(importedTrackStatusText(), true);
            }
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
    document.documentElement.classList.remove("lst-hide-native-subtitles");
    stopTitleMetadataObserver();
    stopFallbackObserver();
    clearTimeout(diagnosticFlushTimer);
    diagnosticFlushTimer = null;
    diagnosticEvents = [];
    lastFallbackText = "";
    renderedSubtitleCandidate = "";
    cues = [];
    cueSourceUrl = "";
    cueVideoId = "";
    cueTrackKind = "none";
    importedTrack = null;
    // A track captured for the player that has just gone belongs to that player,
    // not to the next one.
    pendingSubtitleDocument = null;
    // A note belongs to the show that was on screen; the next one reads its own.
    jimakuFinding = null;
    jimakuFindingKey = "";
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
      subtitleSource: "none",
      importedFileName: "",
      message: `Waiting for ${siteName()} subtitles…`,
    };
    for (const element of [overlay, hud, debugPanel, transcriptPanel]) {
      if (element) element.style.display = "none";
    }
  }

  // A page LST cannot serve stays idle, and says why once, so a viewer who
  // wonders why nothing is happening can see the reason in the event log instead
  // of nothing at all. The same rule covers an unknown host, a service the
  // viewer switched off, and a service page with nothing playing on it.
  let lastInactiveSiteReason = "";
  const PLAYER_ABSENCE_GRACE_POLLS = 3;
  let playerAbsencePolls = 0;

  function reportSiteInactive(reason, details = {}) {
    if (lastInactiveSiteReason === `${reason}:${currentSiteId()}`) return;
    lastInactiveSiteReason = `${reason}:${currentSiteId()}`;
    const detected = detectedSite();
    logDiagnostic(reason === "site-disabled" ? "info" : "warning", "site", reason, {
      siteId: detected.siteId || "none",
      matchPattern: detected.matchPattern || "none",
      host: detected.view?.host || "unknown",
      ...details,
    });
  }

  // The stored preference is read once, on the first page that could actually
  // play, so a browse page costs no storage read and stays idle. Reloading
  // settings pushes a fresh copy, so a service switched off while a page is open
  // is still noticed without another read.
  let settingsLoaded = false;
  let settingsLoadPromise = null;

  function ensureSettingsLoaded() {
    if (settingsLoaded) return Promise.resolve();
    if (!settingsLoadPromise) {
      settingsLoadPromise = loadSettings().then(() => {
        settingsLoaded = true;
      });
    }
    return settingsLoadPromise;
  }

  async function syncPlaybackRoute() {
    const site = currentSite();
    if (!site) {
      reportSiteInactive(
        detectedSite().reason === "playback-site-unavailable"
          ? "playback-site-unavailable"
          : "site-unsupported",
      );
      if (playbackActive) stopPlayback();
      return;
    }
    if (!isWatchPage()) {
      if (playbackActive) stopPlayback();
      return;
    }

    await ensureSettingsLoaded();

    // A service can be switched off while its page is open. That tears down
    // exactly like the global switch: the overlay, HUD, panels and the html
    // class go, native subtitles stay untouched, and no reload is needed.
    if (!siteEnabled(site.id)) {
      reportSiteInactive("site-disabled");
      if (playbackActive) stopPlayback();
      return;
    }

    // Nothing is drawn until a player is in use. On Prime Video that is what
    // keeps a storefront, a product page, or a detail page that has not started
    // playing completely untouched, instead of announcing that LST is waiting
    // for subtitles over a page where nothing is playing.
    //
    // A player can also wink out for a moment — an ad break, a source swap — so
    // a brief absence is tolerated before LST withdraws, and a storefront the
    // viewer navigated back to is left alone within a couple of seconds.
    if (!playerPresence().present) {
      if (!playbackActive) return;
      playerAbsencePolls += 1;
      if (playerAbsencePolls < PLAYER_ABSENCE_GRACE_POLLS) return;
      playerAbsencePolls = 0;
      stopPlayback();
      return;
    }
    playerAbsencePolls = 0;

    if (playbackActive) {
      lastInactiveSiteReason = "";
      return;
    }
    playbackActive = true;
    lastInactiveSiteReason = "";
    const generation = ++playbackGeneration;
    try {
      for (const element of [overlay, hud, debugPanel, transcriptPanel]) {
        if (element) element.style.display = "";
      }
      ensureOverlay();
      setStatus(`Waiting for ${siteName()} subtitles…`, true);
      stopTitleMetadataObserver = startTitleMetadataObserver();
      stopFallbackObserver = startFallbackObserver();
      requestAnimationFrame(playbackLoop);
      // A track the page world captured before this pass is this episode's
      // track: the request that carried it is not repeated, so holding it would
      // mean waiting for a capture that is never asked for again.
      if (pendingSubtitleDocument) {
        const held = pendingSubtitleDocument;
        pendingSubtitleDocument = null;
        handleCapturedDocument(held);
      }
      // A subtitle file the viewer imported for this episode is this episode's
      // track, whether or not the service is rendering captions of its own.
      refreshImportedTrack({ reason: "playback-start" }).catch((error) => {
        console.warn("[LST] Could not check for imported subtitles:", error);
      });
      // What Jimaku held for this show, if the viewer ever asked: a note read
      // from local storage, so arriving at a title sends nothing anywhere.
      refreshJimakuFinding({ reason: "playback-start" }).catch((error) => {
        console.warn("[LST] Could not read what Jimaku holds for this show:", error);
      });
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
    syncPlaybackRoute().catch((error) => console.warn("[LST] Could not follow site navigation:", error));
  }, 750);
})();
