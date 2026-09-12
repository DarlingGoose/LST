(() => {
  const ext = globalThis.browser || globalThis.chrome;
  const SOURCE = "lst-local-subtitle-translate";

  const DEFAULTS = {
    enabled: true,
    model: "translategemma:4b",
    targetLanguage: "English",
    hideNetflixSubtitles: true,
    showOriginal: false,
    showTranslated: true,
    showStatusMessages: true,
    autoTranslateAhead: true,
    lookAheadSeconds: 30,
    cacheWhilePaused: true,
    batchSize: 8,
    requestTimeoutSeconds: 75,
    showDebugPanel: false,
    debugPanelAlwaysOnTop: false,
    showSubtitleControls: true,
    subtitleControlsMinimized: false,
    showQuickPills: true,
    subtitleHorizontalPosition: "center",
    subtitleVerticalPosition: 9,
    subtitleMaxWidth: 92,
    translatedFontSize: 36,
    originalFontSize: 30,
    subtitleBackgroundOpacity: 58,
    subtitleTimingOffsetMs: 0
  };

  let settings = { ...DEFAULTS };
  let cues = [];
  let cueSourceUrl = "";
  let cueVideoId = "";
  const titleMetadataByVideoId = new Map();
  const storedTitleSignaturesByCacheId = new Map();

  let overlay;
  let originalLine;
  let translatedLine;
  let statusLine;
  let hud;
  let quickPillsPanel;
  let quickPillsMenu;
  let quickPillsState;
  let debugPanel;
  let debugPanelBody;
  let subtitleControlsPanel;
  let subtitleControlsStatus;
  let subtitleControlsStatusTimer;
  let statusMessageRequestedVisible = false;

  let lastRenderedCueKey = "";
  let lastFallbackText = "";
  let fallbackTimer = null;
  let lastTimedCueMatchAt = 0;
  let noTimedCueSince = 0;
  let lastTitleMetadataRefreshAt = 0;

  let translationInFlight = new Map();
  let knownCachedKeys = new Set();
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

  let currentStatus = {
    captured: false,
    cueCount: 0,
    translatedCount: 0,
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
    message: "Waiting for Netflix subtitles…"
  };

  async function runtimeMessage(message) {
    const response = await ext.runtime.sendMessage(message);
    if (!response?.ok) {
      throw new Error(response?.error || "Extension request failed.");
    }
    return response;
  }

  function getVideoId() {
    const match = location.pathname.match(/\/watch\/(\d+)/);
    return match ? match[1] : "unknown";
  }

  function normalizeText(text) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();
  }

  function truncate(text, max = 160) {
    const normalized = normalizeText(text);
    return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
  }

  function cueKey(cue) {
    return `${Math.round(cue.start * 1000)}:${Math.round(cue.end * 1000)}:${normalizeText(cue.text)}`;
  }

  function fallbackCueForText(text) {
    // Stable key so repeated DOM updates for the same subtitle reuse the cache.
    return { start: -1, end: -1, text: normalizeText(text) };
  }

  function cacheId() {
    const model = encodeURIComponent(settings.model || "none");
    const language = encodeURIComponent(settings.targetLanguage || "English");
    return `${cueVideoId || getVideoId()}:${model}:${language}`;
  }

  function cleanPageTitle() {
    return normalizeText(document.title)
      .replace(/^Watch\s+/i, "")
      .replace(/\s*(?:\||-|–|—)\s*Netflix.*$/i, "")
      .trim();
  }

  function firstMetadataText(selectors, attribute = "") {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const value = normalizeText(
        attribute ? element?.getAttribute(attribute) : element?.textContent
      );
      if (value) return value;
    }
    return "";
  }

  function netflixTitleMetadata() {
    const titleContainer = document.querySelector(
      '[data-uia="video-title"], [data-uia="player-title"], ' +
      '.watch-video--player-view .video-title, .ellipsize-text'
    );
    const explicitShow = firstMetadataText([
      '[data-uia="video-title"] [data-uia="series-title"]',
      '[data-uia="series-title"]',
      '[data-uia="video-title"] h4',
      '[data-uia="player-title"] h4',
      '.watch-video--player-view .video-title h4',
      '.ellipsize-text h4',
      '.player-status-main-title'
    ]) || firstMetadataText([
      '[data-uia="video-title"] img[alt]',
      '.watch-video--player-view .video-title img[alt]'
    ], "alt");
    const explicitEpisode = firstMetadataText([
      '[data-uia="video-title"] [data-uia="episode-title"]',
      '[data-uia="episode-title"]',
      '.watch-video--player-view .video-title .episode-title',
      '[data-uia="video-title"] span',
      '[data-uia="player-title"] span',
      '.ellipsize-text span',
      '.player-status-subtitle'
    ]);
    const pageTitle = cleanPageTitle();
    const parts = titleContainer
      ? [...titleContainer.querySelectorAll("h1, h2, h3, h4, span")]
        .map((element) => normalizeText(element.textContent))
        .filter((value, index, values) =>
          value &&
          values.indexOf(value) === index &&
          !/^\d+(?::\d+)+$/.test(value) &&
          !/^(?:HD|4K|HDR|UHD|AD|CC)$/i.test(value)
        )
      : [];

    const genericTitle = (value) =>
      !value || /^(?:Netflix|Netflix episode \S+|Unknown Netflix episode)$/i.test(value);
    const usableExplicitShow = genericTitle(explicitShow) ? "" : explicitShow;
    const usablePageTitle = genericTitle(pageTitle) ? "" : pageTitle;
    const episodeMarker = parts.find((value) =>
      /^(?:S(?:eason)?\s*\d+\s*[:·-]?\s*E(?:pisode)?\s*\d+|Episode\s+\d+)/i.test(value)
    );
    const showName = usableExplicitShow || usablePageTitle || parts.find((value) =>
      value !== explicitEpisode && value !== episodeMarker
    ) || "";
    const episodeTitle = explicitEpisode && explicitEpisode !== showName &&
      explicitEpisode !== episodeMarker
      ? explicitEpisode
      : parts.find((value) =>
        value !== showName && value !== usablePageTitle && value !== episodeMarker
      ) || "";
    const episodeName = [...new Set([episodeMarker, episodeTitle].filter(Boolean))].join(" · ");
    const videoId = getVideoId();
    const previous = titleMetadataByVideoId.get(videoId) || {};
    const discovered = {
      showName: showName || previous.showName || "Netflix",
      episodeName: episodeName || previous.episodeName || `Episode ${videoId}`
    };

    const hasSpecificEpisode = discovered.episodeName !== `Episode ${videoId}`;
    if (!genericTitle(discovered.showName) || !previous.showName || hasSpecificEpisode) {
      titleMetadataByVideoId.set(videoId, discovered);
    }
    const remembered = titleMetadataByVideoId.get(videoId) || discovered;

    return {
      ...remembered,
      title: [remembered.showName, remembered.episodeName].filter(Boolean).join(" — ")
    };
  }

  function cacheMetadata() {
    const videoId = cueVideoId || getVideoId();
    const currentVideoId = getVideoId();
    const remembered = titleMetadataByVideoId.get(videoId);
    const titleMetadata = videoId === currentVideoId
      ? netflixTitleMetadata()
      : {
          showName: remembered?.showName || "Netflix",
          episodeName: remembered?.episodeName || `Episode ${videoId}`,
          title: [remembered?.showName, remembered?.episodeName].filter(Boolean).join(" — ") ||
            `Netflix episode ${videoId}`
        };
    return {
      videoId,
      ...titleMetadata,
      url: location.href,
      model: settings.model || "Unknown model",
      targetLanguage: settings.targetLanguage || "English",
      sourceCueCount: cues.length
    };
  }

  function persistImprovedCacheMetadata() {
    if (!cues.length || !knownCachedKeys.size || cueVideoId !== getVideoId()) return;
    const metadata = cacheMetadata();
    if (!metadata.showName || metadata.showName === "Netflix") return;

    const signature = `${metadata.showName}|${metadata.episodeName}`;
    const currentCacheId = cacheId();
    if (storedTitleSignaturesByCacheId.get(currentCacheId) === signature) return;
    storedTitleSignaturesByCacheId.set(currentCacheId, signature);

    runtimeMessage({
      type: "CACHE_SET",
      cacheId: currentCacheId,
      entries: {},
      metadata
    }).catch((error) => {
      storedTitleSignaturesByCacheId.delete(currentCacheId);
      console.warn("[LST] Could not refresh cached episode title:", error);
    });
  }

  function updateProgress() {
    const total = Math.max(0, currentStatus.cueCount || 0);
    const translated = Math.max(0, currentStatus.translatedCount || 0);
    currentStatus.progressPercent = total
      ? Math.min(100, Number(((translated / total) * 100).toFixed(1)))
      : 0;
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
      return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(`0.${frac}`);
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
      10_000_000
    );

    const nodes = [...doc.getElementsByTagNameNS("*", "p")];
    return nodes
      .map((node, index) => {
        const start = parseClock(node.getAttribute("begin"), tickRate);
        let end = parseClock(node.getAttribute("end"), tickRate);
        const duration = parseClock(node.getAttribute("dur"), tickRate);

        if (!Number.isFinite(end) && Number.isFinite(start) && Number.isFinite(duration)) {
          end = start + duration;
        }

        return {
          id: node.getAttribute("xml:id") || node.getAttribute("id") || String(index),
          start,
          end,
          text: extractNodeText(node)
        };
      })
      .filter((cue) =>
        Number.isFinite(cue.start) &&
        Number.isFinite(cue.end) &&
        cue.end > cue.start &&
        cue.text
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
      if (!line.includes("-->") && i + 1 < lines.length && lines[i + 1].includes("-->")) {
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
          text: cueText
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
        ...(await runtimeMessage({ type: "GET_SETTINGS" })).settings
      };
    } catch (error) {
      console.warn("[LST] Could not load settings:", error);
    }
  }

  function ensureOverlay() {
    if (!overlay?.isConnected) {
      overlay = document.createElement("div");
      overlay.id = "not-overlay";
      overlay.innerHTML = `
        <div id="not-original"></div>
        <div id="not-translated"></div>
      `;
      document.documentElement.appendChild(overlay);

      originalLine = overlay.querySelector("#not-original");
      translatedLine = overlay.querySelector("#not-translated");
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
          <span aria-hidden="true">⌄</span>
        </button>
        <div id="lst-pill-menu" hidden>
          <div class="lst-pill-menu-title">Quick subtitles</div>
          <label><span>LST translation</span><input data-pill-setting="showTranslated" type="checkbox"></label>
          <label><span>LST original</span><input data-pill-setting="showOriginal" type="checkbox"></label>
          <label><span>Hide Netflix subtitles</span><input data-pill-setting="hideNetflixSubtitles" type="checkbox"></label>
          <div class="lst-pill-timing">
            <span>Timing <output id="lst-pill-timing-value">0 ms</output></span>
            <div>
              <button type="button" data-pill-action="earlier" aria-label="Show subtitles 100 milliseconds earlier">−100</button>
              <button type="button" data-pill-action="timing-reset">Reset</button>
              <button type="button" data-pill-action="later" aria-label="Show subtitles 100 milliseconds later">+100</button>
            </div>
          </div>
          <button type="button" data-pill-action="settings">Open all settings</button>
        </div>
      `;
      hud.appendChild(quickPillsPanel);
      quickPillsMenu = quickPillsPanel.querySelector("#lst-pill-menu");
      quickPillsState = quickPillsPanel.querySelector("#lst-pill-state");
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

    if (!subtitleControlsPanel?.isConnected) {
      subtitleControlsPanel = document.createElement("div");
      subtitleControlsPanel.id = "lst-subtitle-controls";
      subtitleControlsPanel.innerHTML = `
        <div id="lst-controls-header">
          <strong>Subtitle controls</strong>
          <div class="lst-controls-header-actions">
            <button type="button" data-action="minimize" aria-expanded="true" aria-controls="lst-controls-body">Minimize</button>
            <button type="button" data-action="hide">Hide</button>
          </div>
        </div>
        <div id="lst-controls-body">
        <label class="lst-control-field">
          <span>Alignment</span>
          <select data-setting="subtitleHorizontalPosition">
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </label>
        <label class="lst-control-field">
          <span>Height <output data-output-for="subtitleVerticalPosition"></output></span>
          <input data-setting="subtitleVerticalPosition" data-number type="range" min="4" max="82" step="1">
        </label>
        <label class="lst-control-field">
          <span>Translation size <output data-output-for="translatedFontSize"></output></span>
          <input data-setting="translatedFontSize" data-number type="range" min="18" max="64" step="1">
        </label>
        <label class="lst-control-field">
          <span>Original size <output data-output-for="originalFontSize"></output></span>
          <input data-setting="originalFontSize" data-number type="range" min="14" max="56" step="1">
        </label>
        <label class="lst-control-field">
          <span>Line width <output data-output-for="subtitleMaxWidth"></output></span>
          <input data-setting="subtitleMaxWidth" data-number type="range" min="40" max="96" step="1">
        </label>
        <label class="lst-control-field">
          <span>Background <output data-output-for="subtitleBackgroundOpacity"></output></span>
          <input data-setting="subtitleBackgroundOpacity" data-number type="range" min="0" max="90" step="1">
        </label>
        <label class="lst-control-field">
          <span>Timing <output data-output-for="subtitleTimingOffsetMs"></output></span>
          <input data-setting="subtitleTimingOffsetMs" data-number type="range" min="-2000" max="2000" step="50">
        </label>
        <label class="lst-control-check">
          <input data-setting="hideNetflixSubtitles" type="checkbox">
          <span>Hide Netflix subtitles</span>
        </label>
        <label class="lst-control-check">
          <input data-setting="showOriginal" type="checkbox">
          <span>Show LST original</span>
        </label>
        <label class="lst-control-check">
          <input data-setting="showTranslated" type="checkbox">
          <span>Show LST translation</span>
        </label>
        <label class="lst-control-check">
          <input data-setting="showStatusMessages" type="checkbox">
          <span>Show info messages</span>
        </label>
        <div id="lst-controls-footer">
          <span id="lst-controls-status" role="status"></span>
          <button type="button" data-action="settings">All settings</button>
        </div>
        </div>
      `;
      document.documentElement.appendChild(subtitleControlsPanel);
      subtitleControlsStatus = subtitleControlsPanel.querySelector("#lst-controls-status");
      bindSubtitleControls();
    }

    updateDebugPanel();
    applySubtitleAppearance();
    updateOverlayPanelVisibility();
    return overlay;
  }

  function clamp(value, min, max, fallback) {
    const number = Number(value);
    return Math.min(max, Math.max(min, Number.isFinite(number) ? number : fallback));
  }

  function applySubtitleAppearance() {
    if (!overlay || !originalLine || !translatedLine) return;

    document.documentElement.classList.toggle(
      "lst-hide-netflix-subtitles",
      settings.enabled && settings.hideNetflixSubtitles
    );

    const alignment = ["left", "center", "right"].includes(settings.subtitleHorizontalPosition)
      ? settings.subtitleHorizontalPosition
      : "center";
    const opacity = clamp(settings.subtitleBackgroundOpacity, 0, 90, 58) / 100;

    overlay.style.bottom = `${clamp(settings.subtitleVerticalPosition, 4, 82, 9)}%`;
    overlay.style.width = `min(${clamp(settings.subtitleMaxWidth, 40, 96, 92)}vw, 1100px)`;
    overlay.style.textAlign = alignment;
    overlay.style.left = alignment === "center" ? "50%" : alignment === "left" ? "4vw" : "auto";
    overlay.style.right = alignment === "right" ? "4vw" : "auto";
    overlay.style.transform = alignment === "center" ? "translateX(-50%)" : "none";

    originalLine.style.fontSize = `${clamp(settings.originalFontSize, 14, 56, 30)}px`;
    translatedLine.style.fontSize = `${clamp(settings.translatedFontSize, 18, 64, 36)}px`;

    for (const line of [originalLine, translatedLine]) {
      line.style.backgroundColor = `rgba(0, 0, 0, ${opacity})`;
      line.style.marginLeft = alignment === "left" ? "0" : "auto";
      line.style.marginRight = alignment === "right" ? "0" : "auto";
    }

    originalLine.style.display =
      settings.enabled && settings.showOriginal && originalLine.textContent ? "block" : "none";
    translatedLine.style.display =
      settings.enabled && settings.showTranslated && translatedLine.textContent ? "block" : "none";
    statusLine.style.display =
      settings.showStatusMessages && statusMessageRequestedVisible && currentStatus.message
        ? "block"
        : "none";

    syncSubtitleControls();
    updateQuickPills();
  }

  function quickControlValue(control) {
    if (control.type === "checkbox") return control.checked;
    if (control.hasAttribute("data-number")) return Number(control.value);
    return control.value;
  }

  function updateQuickControl(control) {
    const key = control?.dataset?.setting;
    if (!key) return;
    settings[key] = quickControlValue(control);
    applySubtitleAppearance();
  }

  async function saveQuickSetting(control) {
    const key = control?.dataset?.setting;
    if (!key) return;

    try {
      await runtimeMessage({ type: "SAVE_SETTINGS", settings: { [key]: settings[key] } });
      showSubtitleControlsStatus("Saved");
    } catch (error) {
      showSubtitleControlsStatus("Could not save", true);
      console.warn("[LST] Could not save subtitle control:", error);
    }
  }

  function showSubtitleControlsStatus(message, isError = false) {
    if (!subtitleControlsStatus) return;
    subtitleControlsStatus.textContent = message;
    subtitleControlsStatus.dataset.error = isError ? "true" : "false";
    clearTimeout(subtitleControlsStatusTimer);
    subtitleControlsStatusTimer = setTimeout(() => {
      if (subtitleControlsStatus) subtitleControlsStatus.textContent = "";
    }, 1800);
  }

  function bindSubtitleControls() {
    subtitleControlsPanel.addEventListener("input", (event) => {
      const control = event.target.closest("[data-setting]");
      if (control) updateQuickControl(control);
    });

    subtitleControlsPanel.addEventListener("change", (event) => {
      const control = event.target.closest("[data-setting]");
      if (!control) return;
      updateQuickControl(control);
      saveQuickSetting(control);
    });

    subtitleControlsPanel.addEventListener("click", async (event) => {
      const action = event.target.closest("[data-action]")?.dataset.action;
      if (action === "minimize") {
        settings.subtitleControlsMinimized = !settings.subtitleControlsMinimized;
        syncSubtitleControlsMinimized();
        requestAnimationFrame(positionDebugPanel);
        try {
          await runtimeMessage({
            type: "SAVE_SETTINGS",
            settings: { subtitleControlsMinimized: settings.subtitleControlsMinimized }
          });
        } catch (error) {
          showSubtitleControlsStatus("Could not save panel state", true);
          console.warn("[LST] Could not save subtitle controls state:", error);
        }
      } else if (action === "hide") {
        settings.showSubtitleControls = false;
        updateOverlayPanelVisibility();
        try {
          await runtimeMessage({
            type: "SAVE_SETTINGS",
            settings: { showSubtitleControls: false }
          });
        } catch (error) {
          console.warn("[LST] Could not hide subtitle controls:", error);
        }
      } else if (action === "settings") {
        runtimeMessage({ type: "OPEN_OPTIONS" }).catch((error) => {
          showSubtitleControlsStatus("Could not open settings", true);
          console.warn("[LST] Could not open settings:", error);
        });
      }
    });
  }

  function quickPillStatus() {
    if (pausedCachingPromise) return { label: "Caching", state: "buffering" };
    if (currentStatus.precomputing) return { label: "Precomputing", state: "buffering" };
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
    if (currentStatus.requestState === "error") return { label: "Error", state: "error" };
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
    const ahead = quickPillsPanel.querySelector("#lst-pill-ahead");
    if (ahead) {
      ahead.textContent = currentStatus.cachedAheadSeconds > 0
        ? `· ${formatAheadDuration(currentStatus.cachedAheadSeconds)} ahead`
        : "";
    }
    for (const control of quickPillsPanel.querySelectorAll("[data-pill-setting]")) {
      control.checked = settings[control.dataset.pillSetting] !== false;
    }
    const timing = clamp(settings.subtitleTimingOffsetMs, -2000, 2000, 0);
    const timingOutput = quickPillsPanel.querySelector("#lst-pill-timing-value");
    if (timingOutput) timingOutput.textContent = `${timing > 0 ? "+" : ""}${timing} ms`;
  }

  function bindQuickPills() {
    quickPillsPanel.addEventListener("click", (event) => {
      const action = event.target.closest("[data-pill-action]")?.dataset.pillAction;
      if (action === "toggle") {
        setQuickPillsMenu(quickPillsMenu.hidden);
      } else if (["earlier", "timing-reset", "later"].includes(action)) {
        const current = clamp(settings.subtitleTimingOffsetMs, -2000, 2000, 0);
        settings.subtitleTimingOffsetMs = action === "timing-reset"
          ? 0
          : clamp(current + (action === "later" ? 100 : -100), -2000, 2000, 0);
        applySubtitleAppearance();
        runtimeMessage({
          type: "SAVE_SETTINGS",
          settings: { subtitleTimingOffsetMs: settings.subtitleTimingOffsetMs }
        }).catch((error) => setStatus(`Could not save subtitle timing: ${error.message}`, true));
      } else if (action === "settings") {
        setQuickPillsMenu(false);
        runtimeMessage({ type: "OPEN_OPTIONS" }).catch((error) => {
          setStatus(`Could not open settings: ${error.message}`, true);
        });
      }
    });

    quickPillsPanel.addEventListener("change", (event) => {
      const control = event.target.closest("[data-pill-setting]");
      if (!control) return;
      const key = control.dataset.pillSetting;
      settings[key] = control.checked;
      applySubtitleAppearance();
      runtimeMessage({ type: "SAVE_SETTINGS", settings: { [key]: settings[key] } })
        .catch((error) => setStatus(`Could not save quick setting: ${error.message}`, true));
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
    quickPillsPanel.querySelector("#lst-pill-trigger")
      ?.setAttribute("aria-expanded", String(open));
  }

  function syncSubtitleControls() {
    if (!subtitleControlsPanel) return;
    syncSubtitleControlsMinimized();
    for (const control of subtitleControlsPanel.querySelectorAll("[data-setting]")) {
      const value = settings[control.dataset.setting];
      if (control.type === "checkbox") control.checked = value !== false;
      else control.value = value;
    }

    const formats = {
      subtitleVerticalPosition: (value) => `${value}%`,
      translatedFontSize: (value) => `${value}px`,
      originalFontSize: (value) => `${value}px`,
      subtitleMaxWidth: (value) => `${value}%`,
      subtitleBackgroundOpacity: (value) => `${value}%`,
      subtitleTimingOffsetMs: (value) => `${Number(value) > 0 ? "+" : ""}${value}ms`
    };
    for (const output of subtitleControlsPanel.querySelectorAll("[data-output-for]")) {
      const key = output.dataset.outputFor;
      output.textContent = formats[key]?.(settings[key]) || "";
    }
  }

  function syncSubtitleControlsMinimized() {
    if (!subtitleControlsPanel) return;
    const minimized = settings.subtitleControlsMinimized === true;
    const body = subtitleControlsPanel.querySelector("#lst-controls-body");
    const button = subtitleControlsPanel.querySelector('[data-action="minimize"]');

    subtitleControlsPanel.dataset.minimized = String(minimized);
    if (body) body.hidden = minimized;
    if (button) {
      button.textContent = minimized ? "Expand" : "Minimize";
      button.setAttribute("aria-expanded", String(!minimized));
      button.setAttribute(
        "aria-label",
        minimized ? "Expand subtitle controls" : "Minimize subtitle controls"
      );
    }
  }

  function positionDebugPanel() {
    if (!debugPanel) return;
    const controlsVisible = subtitleControlsPanel?.style.display !== "none";
    const top = controlsVisible
      ? Math.round(subtitleControlsPanel.getBoundingClientRect().bottom + 12)
      : 12;
    debugPanel.style.setProperty("top", `${top}px`, "important");
    debugPanel.style.maxHeight = `max(120px, calc(100vh - ${top + 12}px))`;
  }

  function updateOverlayPanelVisibility() {
    if (!subtitleControlsPanel) return;
    subtitleControlsPanel.style.display = settings.showSubtitleControls ? "block" : "none";
    syncSubtitleControls();
    requestAnimationFrame(positionDebugPanel);
  }

  function formatMs(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value <= 0) return "—";
    return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`;
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
    const latest = diagnostics.length ? diagnostics[diagnostics.length - 1] : null;

    const lines = [
      `model       ${settings.model || "—"}`,
      `target      ${settings.targetLanguage || "—"}`,
      `track       ${currentStatus.cueCount || 0} cues`,
      `cached      ${currentStatus.translatedCount || 0}/${currentStatus.cueCount || 0} (${currentStatus.progressPercent || 0}%)`,
      `cache ahead ${formatAheadDuration(currentStatus.cachedAheadSeconds)}`,
      `precompute  ${currentStatus.precomputing ? "RUNNING" : "idle"} · batch ${currentStatus.currentBatch || 0}/${currentStatus.totalBatches || 0}`,
      `request     ${currentStatus.requestState || "idle"} · ${formatMs(currentStatus.lastRequestMs)}`,
      `result      ${currentStatus.lastRequestTranslated || 0}/${currentStatus.lastRequestRequested || 0} translated · ${currentStatus.lastRequestFailed || 0} failed`,
      `ollama      ${currentStatus.lastOllamaMode || "—"}`,
      `playback    ${currentStatus.playbackMode || "waiting"}`,
      `video       ${Number(currentStatus.videoTime || 0).toFixed(2)}s`,
      `sync offset ${clamp(settings.subtitleTimingOffsetMs, -2000, 2000, 0)}ms`,
      `cue         ${currentStatus.activeCueStart == null ? "—" : `${Number(currentStatus.activeCueStart).toFixed(2)}–${Number(currentStatus.activeCueEnd).toFixed(2)}s`}`,
      `in-flight   ${translationInFlight.size}`,
      `source      ${shortUrl(cueSourceUrl)}`
    ];

    if (currentStatus.currentText) {
      lines.push(`current     ${truncate(currentStatus.currentText, 135)}`);
    }
    if (currentStatus.lastTranslatedText) {
      lines.push(`translated  ${truncate(currentStatus.lastTranslatedText, 135)}`);
    }
    if (latest?.stage) {
      lines.push(`diag stage  ${latest.stage}`);
    }
    if (latest?.idRecovery) {
      lines.push(`id match    ${latest.idRecovery}`);
    }
    if (latest?.returnedIds?.length) {
      lines.push(`return ids  ${truncate(latest.returnedIds.join(" | "), 150)}`);
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
      settings.showStatusMessages && statusMessageRequestedVisible ? "block" : "none";
    updateDebugPanel();
  }

  function render(original, translated) {
    ensureOverlay();

    if (!settings.enabled) {
      overlay.style.display = "none";
      return;
    }

    overlay.style.display = "block";
    originalLine.style.display =
      settings.showOriginal && original ? "block" : "none";
    originalLine.textContent = original || "";

    translatedLine.style.display =
      settings.showTranslated && translated ? "block" : "none";
    translatedLine.textContent = translated || "";
  }

  function clearRenderedSubtitle() {
    render("", "");
    lastRenderedCueKey = "";
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

  function subtitleLookupTime(videoTime) {
    // Positive values delay LST subtitles; negative values show them earlier.
    return Number(videoTime) - clamp(settings.subtitleTimingOffsetMs, -2000, 2000, 0) / 1000;
  }

  function isTimedCueStillCurrent(key) {
    const video = document.querySelector("video");
    if (!video || lastRenderedCueKey !== key) return false;
    const match = findCueAt(subtitleLookupTime(video.currentTime));
    return Boolean(match && cueKey(match.cue) === key);
  }

  async function getCachedTranslations(selectedCues) {
    const keys = selectedCues.map(cueKey);
    if (!keys.length) return {};

    const response = await runtimeMessage({
      type: "CACHE_GET",
      cacheId: cacheId(),
      keys
    });

    const entries = response.entries || {};
    rememberCachedEntries(entries);
    return entries;
  }

  function rememberCachedEntries(entries) {
    for (const key of Object.keys(entries || {})) knownCachedKeys.add(key);
    refreshCacheCoverage();
  }

  function refreshCacheCoverage(videoTime) {
    currentStatus.translatedCount = cues.reduce(
      (count, cue) => count + (knownCachedKeys.has(cueKey(cue)) ? 1 : 0),
      0
    );
    updateProgress();

    const video = document.querySelector("video");
    const rawTime = Number.isFinite(Number(videoTime))
      ? Number(videoTime)
      : Number(video?.currentTime);
    if (!Number.isFinite(rawTime) || !cues.length) {
      currentStatus.cachedAheadSeconds = 0;
      return;
    }

    const time = subtitleLookupTime(rawTime);
    let coveredUntil = time;
    for (const cue of cues) {
      if (cue.end <= time) continue;
      if (!knownCachedKeys.has(cueKey(cue))) break;
      coveredUntil = Math.max(coveredUntil, cue.end);
    }
    currentStatus.cachedAheadSeconds = Math.max(0, coveredUntil - time);
  }

  async function translateCues(selectedCues) {
    const deduped = [];
    const seen = new Set();

    for (const cue of selectedCues) {
      const key = cueKey(cue);
      if (seen.has(key) || translationInFlight.has(key)) continue;
      seen.add(key);
      deduped.push(cue);
    }

    if (!deduped.length) {
      return { entries: {}, failures: [] };
    }

    const cached = await getCachedTranslations(deduped);
    const missing = deduped.filter(
      (cue) => !Object.prototype.hasOwnProperty.call(cached, cueKey(cue))
    );

    if (!missing.length) {
      return { entries: cached, failures: [] };
    }

    for (const cue of missing) {
      translationInFlight.set(cueKey(cue), true);
    }

    try {
      currentStatus.requestState = "running";
      currentStatus.lastRequestRequested = missing.length;
      currentStatus.lastRequestTranslated = 0;
      currentStatus.lastRequestFailed = 0;
      updateDebugPanel();

      const requestStartedAt = Date.now();
      const response = await runtimeMessage({
        type: "TRANSLATE_BATCH",
        model: settings.model,
        targetLanguage: settings.targetLanguage,
        requestTimeoutSeconds: settings.requestTimeoutSeconds,
        items: missing.map((cue) => ({
          id: cueKey(cue),
          text: cue.text
        }))
      });

      currentStatus.requestState = "done";
      currentStatus.lastRequestMs =
        response.summary?.elapsedMs || (Date.now() - requestStartedAt);
      currentStatus.lastRequestRequested =
        response.summary?.requested ?? missing.length;
      currentStatus.lastRequestTranslated =
        response.summary?.translated ?? (response.translations || []).length;
      currentStatus.lastRequestFailed =
        response.summary?.failed ?? (response.failures || []).length;
      currentStatus.lastDiagnostics = response.diagnostics || [];

      const latestDiag = currentStatus.lastDiagnostics.length
        ? currentStatus.lastDiagnostics[currentStatus.lastDiagnostics.length - 1]
        : null;

      currentStatus.lastOllamaMode =
        latestDiag?.idRecovery
          ? `${latestDiag.mode || "structured"} / ${latestDiag.idRecovery}`
          : (latestDiag?.mode || latestDiag?.stage || "");

      currentStatus.lastOllamaRaw = latestDiag?.rawResponse || "";
      updateDebugPanel();

      const newEntries = {};
      for (const entry of response.translations || []) {
        if (entry.text) newEntries[entry.id] = entry.text;
      }
      rememberCachedEntries(newEntries);

      if (Object.keys(newEntries).length) {
        await runtimeMessage({
          type: "CACHE_SET",
          cacheId: cacheId(),
          entries: newEntries,
          metadata: cacheMetadata()
        });
      }

      return {
        entries: { ...cached, ...newEntries },
        failures: response.failures || []
      };
    } catch (error) {
      currentStatus.requestState = "error";
      currentStatus.lastError = error.message;
      if (error?.diagnostics) {
        currentStatus.lastDiagnostics = [{
          stage: "extension-request-error",
          ...error.diagnostics
        }];
      }
      updateDebugPanel();
      throw error;
    } finally {
      for (const cue of missing) {
        translationInFlight.delete(cueKey(cue));
      }
      updateDebugPanel();
    }
  }

  async function ensureCueTranslated(cue, index) {
    if (!cue || !settings.model) return;

    const key = cueKey(cue);
    const cached = await getCachedTranslations([cue]);

    if (cached[key]) {
      currentStatus.playbackMode = "timed-text cache";
      currentStatus.lastTranslatedText = truncate(cached[key]);
      if (isTimedCueStillCurrent(key)) render(cue.text, cached[key]);
    } else {
      const currentResult = await translateCues([cue]);
      if (currentResult.entries[key]) {
        currentStatus.playbackMode = "timed-text realtime";
        currentStatus.lastTranslatedText = truncate(currentResult.entries[key]);
        if (isTimedCueStillCurrent(key)) render(cue.text, currentResult.entries[key]);
      }
    }

    if (settings.autoTranslateAhead && cues.length) {
      maintainLookAhead(cue, index).catch((error) => {
        console.warn("[LST] Look-ahead translation failed:", error);
        setStatus(`Could not maintain the translation buffer: ${error.message}`, true);
      });
    }
  }

  async function maintainLookAhead(currentCue, index) {
    const seconds = Math.max(30, Number(settings.lookAheadSeconds) || 30);
    const playbackTime = Number(document.querySelector("video")?.currentTime);
    const deadline = Math.max(
      currentCue.start,
      Number.isFinite(playbackTime) ? playbackTime : currentCue.start
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
      setStatus(`Preparing translations at least ${seconds} seconds ahead…`, true);
    }

    const batchSize = Math.max(1, Number(settings.batchSize) || 8);
    let failed = 0;
    try {
      for (let i = 0; i < ahead.length; i += batchSize) {
        const result = await translateCues(ahead.slice(i, i + batchSize));
        failed += result.failures.length;
      }
      if (failed) {
        setStatus(`${failed} upcoming subtitle${failed === 1 ? "" : "s"} could not be prepared.`, true);
      } else if (!lookAheadReadyNoticeShown) {
        lookAheadReadyNoticeShown = true;
        setStatus(`Translation buffer ready at least ${seconds} seconds ahead.`, true);
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
    ) return;

    pausedCachingPromise = runPausedCaching(video).finally(() => {
      pausedCachingPromise = null;
      refreshCacheCoverage(video.currentTime);
      updateQuickPills();
    });
    updateQuickPills();
  }

  async function runPausedCaching(video) {
    if (!pausedCacheNoticeShown) {
      pausedCacheNoticeShown = true;
      setStatus("Paused — building more of this episode's translation cache…", true);
    }

    while (video.paused && settings.cacheWhilePaused && !precomputeInProgress) {
      const playbackTime = subtitleLookupTime(video.currentTime);
      const remaining = cues.filter((cue) =>
        cue.end > playbackTime &&
        !knownCachedKeys.has(cueKey(cue)) &&
        !pausedCacheFailedKeys.has(cueKey(cue))
      );

      if (!remaining.length) {
        if (!pausedCacheCompleteNoticeShown) {
          pausedCacheCompleteNoticeShown = true;
          setStatus("Paused cache complete from the current position to the end.", true);
        }
        return;
      }

      const available = remaining.filter((cue) =>
        !translationInFlight.has(cueKey(cue)) && !lookAheadQueued.has(cueKey(cue))
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
        `${currentStatus.translatedCount}/${cues.length} cues`,
        true
      );
    }
  }

  async function playbackLoop() {
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
          true
        );
      }
    }

    currentStatus.videoTime = video.currentTime;
    const match = findCueAt(subtitleLookupTime(video.currentTime));

    if (!match) {
      if (!noTimedCueSince) noTimedCueSince = performance.now();
      currentStatus.activeCueStart = null;
      currentStatus.activeCueEnd = null;
      updateDebugPanel();
      // Give the DOM fallback a short handoff window, then clear a stale line
      // when Netflix is also between subtitles.
      if (
        lastRenderedCueKey &&
        performance.now() - noTimedCueSince > 220 &&
        !findNetflixRenderedSubtitle()
      ) {
        clearRenderedSubtitle();
      }
      requestAnimationFrame(playbackLoop);
      return;
    }

    noTimedCueSince = 0;
    lastTimedCueMatchAt = Date.now();
    currentStatus.activeCueStart = match.cue.start;
    currentStatus.activeCueEnd = match.cue.end;
    updateDebugPanel();
    const key = cueKey(match.cue);

    if (key !== lastRenderedCueKey) {
      lastRenderedCueKey = key;
      currentStatus.playbackMode = "timed-text pending";
      render(match.cue.text, "");

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
      document.querySelector(".player-timedtext-text-container")
    ].filter(Boolean);

    for (const container of candidates) {
      const text = normalizeText(container.innerText || container.textContent || "");
      if (text) return text;
    }

    return "";
  }

  async function handleFallbackRenderedSubtitle() {
    if (!settings.enabled || !settings.model) return;

    const text = findNetflixRenderedSubtitle();
    if (!text) {
      if (lastFallbackText && String(currentStatus.playbackMode).startsWith("DOM")) {
        lastFallbackText = "";
        clearRenderedSubtitle();
      }
      return;
    }
    if (text === lastFallbackText) return;

    const video = document.querySelector("video");
    const timedMatch = video && cues.length
      ? findCueAt(subtitleLookupTime(video.currentTime))
      : null;
    const timedText = timedMatch ? normalizeText(timedMatch.cue.text) : "";

    // If the captured timed-text track clearly matches the subtitle Netflix is
    // displaying, let the time-synced path handle it. Otherwise the DOM is the
    // source of truth and guarantees that visible subtitles can still translate.
    if (timedText && timedText === text && Date.now() - lastTimedCueMatchAt < 1500) {
      return;
    }

    lastFallbackText = text;
    const fallbackCue = fallbackCueForText(text);
    const key = cueKey(fallbackCue);

    try {
      const result = await translateCues([fallbackCue]);
      const translated = result.entries[key] || "";

      if (translated && lastFallbackText === text) {
        currentStatus.playbackMode =
          cues.length ? "DOM fallback (timing mismatch)" : "DOM realtime";
        currentStatus.lastTranslatedText = truncate(translated);
        render(text, translated);

        if (!precomputeInProgress) {
          setStatus(
            cues.length
              ? "Using visible-subtitle fallback while the captured track is out of sync."
              : "Realtime DOM mode — waiting to capture a full subtitle track.",
            true
          );
        }
      }

      if (result.failures.length) {
        currentStatus.lastError = result.failures[0].error || "Realtime translation failed";
      }
    } catch (error) {
      currentStatus.lastError = error.message;
      setStatus(`Realtime translation error: ${error.message}`, true);
    }
  }

  function startFallbackObserver() {
    const observer = new MutationObserver(() => {
      clearTimeout(fallbackTimer);
      fallbackTimer = setTimeout(handleFallbackRenderedSubtitle, 40);
    });

    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true
    });

    // Netflix sometimes updates subtitle layout without a useful mutation on the
    // exact text node we observed. This lightweight poll keeps the fallback honest.
    setInterval(handleFallbackRenderedSubtitle, 350);
  }

  async function acceptSubtitleDocument(url, text) {
    const parsed = parseSubtitleDocument(text);
    if (!parsed.length) return;

    const signature =
      `${url}|${parsed.length}|${parsed[0]?.start}|${parsed.at(-1)?.end}`;
    const currentSignature =
      `${cueSourceUrl}|${cues.length}|${cues[0]?.start}|${cues.at(-1)?.end}`;

    if (signature === currentSignature) return;

    cues = parsed.sort((a, b) => a.start - b.start);
    cueSourceUrl = url || "captured";
    cueVideoId = getVideoId();
    knownCachedKeys = new Set();
    pausedCacheFailedKeys = new Set();

    currentStatus.captured = true;
    currentStatus.cueCount = cues.length;

    const allCached = await getCachedTranslations(cues);
    currentStatus.translatedCount = Object.keys(allCached).length;
    updateProgress();

    setStatus(
      `Captured ${cues.length} subtitle cues · ${currentStatus.translatedCount}/${cues.length} cached.`,
      true
    );
  }

  async function precomputeAll() {
    if (precomputeInProgress) return;
    if (!settings.model) {
      throw new Error("Choose an Ollama model in extension settings first.");
    }
    if (!cues.length) {
      throw new Error(
        "No full subtitle track captured yet. Turn on a Netflix subtitle track, then retry."
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

      const missing = cues.filter(
        (cue) => !Object.prototype.hasOwnProperty.call(cached, cueKey(cue))
      );

      const batchSize = Math.max(1, Number(settings.batchSize) || 16);
      currentStatus.totalBatches = Math.ceil(missing.length / batchSize);
      currentStatus.currentBatch = 0;
      updateProgress();

      if (!missing.length) {
        setStatus(`Precompute already complete: ${cues.length}/${cues.length} cached.`, true);
        return;
      }

      for (let i = 0; i < missing.length; i += batchSize) {
        if (precomputeCancelled) {
          setStatus(
            `Precompute stopped at ${currentStatus.translatedCount}/${cues.length}.`,
            true
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
          260
        );
        currentStatus.batchStartedAt = Date.now();

        setStatus(
          `Precompute ${currentStatus.progressPercent}% · ` +
          `${currentStatus.translatedCount}/${cues.length} cached · ` +
          `batch ${batchNumber}/${currentStatus.totalBatches}\n` +
          `${currentStatus.currentText}`,
          true
        );

        const result = await translateCues(batch);

        const successful = Object.keys(result.entries).filter((key) =>
          batch.some((cue) => cueKey(cue) === key)
        ).length;

        currentStatus.translatedCount += successful;
        currentStatus.failedCount += result.failures.length;

        if (result.failures.length) {
          currentStatus.lastError = result.failures[0].error || "One or more cues failed";
        }

        const lastSuccess = [...batch]
          .reverse()
          .find((cue) => result.entries[cueKey(cue)]);

        if (lastSuccess) {
          currentStatus.lastTranslatedText = truncate(
            result.entries[cueKey(lastSuccess)],
            180
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
          `Precompute finished at ${currentStatus.progressPercent}% · ` +
          `${currentStatus.translatedCount}/${cues.length} cached · ` +
          `${currentStatus.failedCount} failed.`,
          true
        );
      } else {
        setStatus(
          `Precompute complete: ${cues.length}/${cues.length} cues cached locally.`,
          true
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
        case "GET_PAGE_STATUS":
          sendResponse({
            ok: true,
            status: {
              ...currentStatus,
              videoId: getVideoId(),
              sourceUrl: cueSourceUrl,
              enabled: settings.enabled,
              model: settings.model,
              targetLanguage: settings.targetLanguage
            }
          });
          return;

        case "START_PRECOMPUTE":
          sendResponse({ ok: true, ...startPrecomputeDetached() });
          return;

        case "CANCEL_PRECOMPUTE":
          precomputeCancelled = true;
          sendResponse({ ok: true });
          return;

        case "RELOAD_SETTINGS": {
          const previousCacheId = cacheId();
          await loadSettings();
          if (cacheId() !== previousCacheId) {
            knownCachedKeys = new Set();
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

  async function init() {
    await loadSettings();
    ensureOverlay();
    setStatus("Waiting for Netflix subtitles…", true);
    startFallbackObserver();
    requestAnimationFrame(playbackLoop);
  }

  init();
})();
