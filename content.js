(() => {
  const ext = globalThis.browser || globalThis.chrome;
  const SOURCE = "lst-local-subtitle-translate";

  const DEFAULTS = {
    enabled: true,
    model: "",
    targetLanguage: "English",
    showOriginal: true,
    autoTranslateAhead: true,
    aheadCount: 12,
    batchSize: 8,
    requestTimeoutSeconds: 75,
    showDebugPanel: true,
    debugPanelAlwaysOnTop: true
  };

  let settings = { ...DEFAULTS };
  let cues = [];
  let cueSourceUrl = "";

  let overlay;
  let originalLine;
  let translatedLine;
  let statusLine;
  let debugPanel;
  let debugPanelBody;

  let lastRenderedCueKey = "";
  let lastFallbackText = "";
  let fallbackTimer = null;
  let lastTimedCueMatchAt = 0;

  let translationInFlight = new Map();
  let precomputeInProgress = false;
  let precomputePromise = null;
  let precomputeCancelled = false;

  let currentStatus = {
    captured: false,
    cueCount: 0,
    translatedCount: 0,
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
    return `${getVideoId()}:${model}:${language}`;
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
        <div id="not-status"></div>
      `;
      document.documentElement.appendChild(overlay);

      originalLine = overlay.querySelector("#not-original");
      translatedLine = overlay.querySelector("#not-translated");
      statusLine = overlay.querySelector("#not-status");
    }

    if (!debugPanel?.isConnected) {
      debugPanel = document.createElement("div");
      debugPanel.id = "lst-debug-panel";
      debugPanel.innerHTML = `
        <div id="lst-debug-header">
          <strong>LST</strong>
          <span>v0.3.0</span>
        </div>
        <pre id="lst-debug-body"></pre>
      `;
      document.documentElement.appendChild(debugPanel);
      debugPanelBody = debugPanel.querySelector("#lst-debug-body");
    }

    updateDebugPanel();
    return overlay;
  }

  function formatMs(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value <= 0) return "—";
    return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`;
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
    if (!debugPanel || !debugPanelBody) return;

    const shouldShow =
      settings.showDebugPanel &&
      (settings.debugPanelAlwaysOnTop ||
        currentStatus.precomputing ||
        currentStatus.lastError);

    debugPanel.style.display = shouldShow ? "block" : "none";
    if (!shouldShow) return;

    const diagnostics = currentStatus.lastDiagnostics || [];
    const latest = diagnostics.length ? diagnostics[diagnostics.length - 1] : null;

    const lines = [
      `model       ${settings.model || "—"}`,
      `target      ${settings.targetLanguage || "—"}`,
      `track       ${currentStatus.cueCount || 0} cues`,
      `cached      ${currentStatus.translatedCount || 0}/${currentStatus.cueCount || 0} (${currentStatus.progressPercent || 0}%)`,
      `precompute  ${currentStatus.precomputing ? "RUNNING" : "idle"} · batch ${currentStatus.currentBatch || 0}/${currentStatus.totalBatches || 0}`,
      `request     ${currentStatus.requestState || "idle"} · ${formatMs(currentStatus.lastRequestMs)}`,
      `result      ${currentStatus.lastRequestTranslated || 0}/${currentStatus.lastRequestRequested || 0} translated · ${currentStatus.lastRequestFailed || 0} failed`,
      `ollama      ${currentStatus.lastOllamaMode || "—"}`,
      `playback    ${currentStatus.playbackMode || "waiting"}`,
      `video       ${Number(currentStatus.videoTime || 0).toFixed(2)}s`,
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
    ensureOverlay();
    statusLine.textContent = message || "";
    statusLine.style.display = visible && message ? "block" : "none";
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

    translatedLine.style.display = translated ? "block" : "none";
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

  async function getCachedTranslations(selectedCues) {
    const keys = selectedCues.map(cueKey);
    if (!keys.length) return {};

    const response = await runtimeMessage({
      type: "CACHE_GET",
      cacheId: cacheId(),
      keys
    });

    return response.entries || {};
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

      if (Object.keys(newEntries).length) {
        await runtimeMessage({
          type: "CACHE_SET",
          cacheId: cacheId(),
          entries: newEntries
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
      render(cue.text, cached[key]);
      return;
    }

    const currentResult = await translateCues([cue]);
    if (currentResult.entries[key]) {
      currentStatus.playbackMode = "timed-text realtime";
      currentStatus.lastTranslatedText = truncate(currentResult.entries[key]);
      render(cue.text, currentResult.entries[key]);
    }

    if (settings.autoTranslateAhead && cues.length) {
      const count = Math.max(0, Number(settings.aheadCount) || 0);
      const ahead = cues.slice(index + 1, index + 1 + count);
      const batchSize = Math.max(1, Number(settings.batchSize) || 16);

      for (let i = 0; i < ahead.length; i += batchSize) {
        translateCues(ahead.slice(i, i + batchSize)).catch((error) => {
          console.warn("[LST] Look-ahead translation failed:", error);
        });
      }
    }
  }

  async function playbackLoop() {
    ensureOverlay();

    const video = document.querySelector("video");
    if (!video || !settings.enabled) {
      requestAnimationFrame(playbackLoop);
      return;
    }

    if (!cues.length) {
      requestAnimationFrame(playbackLoop);
      return;
    }

    currentStatus.videoTime = video.currentTime;
    const match = findCueAt(video.currentTime);

    if (!match) {
      currentStatus.activeCueStart = null;
      currentStatus.activeCueEnd = null;
      updateDebugPanel();
      // Do not clear immediately. Netflix's rendered subtitle observer is allowed
      // to take over if the captured timed-text track does not line up with playback.
      requestAnimationFrame(playbackLoop);
      return;
    }

    lastTimedCueMatchAt = Date.now();
    currentStatus.activeCueStart = match.cue.start;
    currentStatus.activeCueEnd = match.cue.end;
    updateDebugPanel();
    const key = cueKey(match.cue);

    if (key !== lastRenderedCueKey) {
      lastRenderedCueKey = key;
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
    if (!text || text === lastFallbackText) return;

    const video = document.querySelector("video");
    const timedMatch = video && cues.length ? findCueAt(video.currentTime) : null;
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

      if (translated) {
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

        case "RELOAD_SETTINGS":
          await loadSettings();
          ensureOverlay();
          updateDebugPanel();
          sendResponse({ ok: true });
          return;

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
