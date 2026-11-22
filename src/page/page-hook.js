// LST page-world subtitle capture.
//
// Runs in the page's own world so it can observe the fetch/XHR traffic the
// player makes for timed text. Everything site-specific — which pages can play,
// which URL shapes carry a subtitle document, which content types are timed
// text, which URL lists a title's subtitle assets, and which track in that
// listing is the episode's source — comes from playback-site.js, which the
// manifest loads immediately before this file. Nothing about either service is
// repeated here, and the message this file publishes says which service the
// document came from, so a document captured on one site can never be adopted
// on the other.
//
// Two things are captured. Netflix hands the player a timed-text document and
// this file publishes it as it goes past. Prime Video instead hands the player
// a *listing* of a title's assets, so this file reads the listing, picks the
// track the adapter names, fetches that one document here in the page world, and
// publishes it — the whole episode at once, rather than a line at a time as the
// player renders it. Fetching it here is what keeps the extension out of it:
// the request carries the page's own origin and cookies, so LST needs no CDN
// host permission, and the resolved document is used immediately because these
// URLs are signed and expire.
//
// This file stays small on purpose: it runs alongside the streaming service's
// own page code, and a thrown error or a slow observer would be felt by the
// player rather than by LST.

(() => {
  if (window.__lstLocalSubtitleTranslateHooked) return;
  window.__lstLocalSubtitleTranslateHooked = true;

  const SOURCE = "lst-local-subtitle-translate";
  const PAGE_CHANNEL = "page-capture";
  const CONTENT_CHANNEL = "content-capture";
  const URL_PATTERN_CACHE = new Map();
  const PENDING_CAPTURE_LIMIT = 8;
  const RECENT_DOCUMENT_LIMIT = 4;
  const RECENT_DOCUMENT_TTL_MS = 120_000;
  const REPLAY_COOLDOWN_MS = 8_000;
  const FETCH_RETRY_COOLDOWN_MS = 15_000;
  const INVALID_DOCUMENT_RETRY_COOLDOWN_MS = 60_000;
  const DIAGNOSTIC_COOLDOWN_MS = 15_000;
  const MAX_TIMING_RECOVERY_REQUESTS = 3;
  const pendingCaptures = new Map();
  // Acknowledged captures are no longer in pendingCaptures. Keep a separate,
  // small, expiring copy so episode transitions can recover one-shot documents.
  const recentDocuments = new Map();
  const latestListingIdentityBySite = new Map();
  const trackFetchesInFlight = new Map();
  const failedFetchUntil = new Map();
  const lastDiagnosticByKind = new Map();
  let nextCaptureEventId = 1;
  let lastResyncScheduledAt = 0;
  let scheduledResyncs = [];
  // The page's own fetch, kept before the wrapper below replaces it. The
  // document a listing names is fetched with this one, so LST's own request is
  // never observed and handed back to itself.
  const originalFetch = window.fetch;

  function playbackSite() {
    return window.LSTPlaybackSite || null;
  }

  function captureEventId() {
    return `${Date.now().toString(36)}-${nextCaptureEventId++}`;
  }

  function postCapture(type, payload, { retain = true } = {}) {
    const message = {
      source: SOURCE,
      channel: PAGE_CHANNEL,
      type,
      eventId: captureEventId(),
      payload,
    };
    if (retain) {
      while (pendingCaptures.size >= PENDING_CAPTURE_LIMIT) {
        pendingCaptures.delete(pendingCaptures.keys().next().value);
      }
      pendingCaptures.set(message.eventId, message);
    }
    window.postMessage({ ...message, delivery: "live" }, "*");
    return message.eventId;
  }

  function pageVideoId(detected) {
    try {
      return String(
        detected?.site?.videoIdFrom?.(detected.view)?.videoId || "",
      );
    } catch {
      return "";
    }
  }

  function captureOwner(detected) {
    const pageId = pageVideoId(detected);
    return {
      pageVideoId: pageId,
      // The Netflix /watch/<id> path names the episode. Prime's path can name
      // the series instead, so its episode ID must come from the listing.
      ownerVideoId: detected?.siteId === "netflix" ? pageId : "",
    };
  }

  function documentKey(payload) {
    return [
      payload.site || "",
      payload.ownerVideoId || "",
      payload.pageVideoId || "",
      payload.url || "",
    ].join("\u001f");
  }

  function expireRecentDocuments() {
    const now = Date.now();
    for (const [key, entry] of recentDocuments) {
      if (now - entry.at > RECENT_DOCUMENT_TTL_MS) recentDocuments.delete(key);
    }
    while (recentDocuments.size > RECENT_DOCUMENT_LIMIT) {
      recentDocuments.delete(recentDocuments.keys().next().value);
    }
  }

  function rememberDocument(payload) {
    expireRecentDocuments();
    const key = documentKey(payload);
    recentDocuments.delete(key);
    recentDocuments.set(key, {
      payload,
      at: Date.now(),
      lastReplayAt: 0,
    });
    expireRecentDocuments();
  }

  // The content runtime requests recovery only while it has no subtitle cues.
  // Re-publish the *document*, not the expired signed URL, using a new event ID
  // so the bridge can deliver it even after acknowledging its original event.
  function replayRecentDocument(detected, requestedVideoId = "") {
    expireRecentDocuments();
    const pageId = pageVideoId(detected);
    const latestListing = latestListingIdentityBySite.get(detected.siteId);
    const listingId =
      latestListing?.pageVideoId === pageId ? latestListing.videoId || "" : "";
    const requestedId =
      requestedVideoId && requestedVideoId !== "unknown"
        ? requestedVideoId
        : "";
    const targetId = String(requestedId || listingId || pageId || "");
    if (!targetId || targetId === "unknown") return false;

    const entries = [...recentDocuments.values()].reverse();
    for (const entry of entries) {
      const payload = entry.payload;
      if (payload.site !== detected.siteId) continue;
      if (payload.pageVideoId && pageId && payload.pageVideoId !== pageId)
        continue;

      if (payload.ownerVideoId) {
        if (payload.ownerVideoId !== targetId) continue;
      } else if (detected.siteId !== "netflix" || targetId !== pageId) {
        // A Prime document without catalog ownership cannot be proven to
        // belong to the episode on screen. Do not replay it across episodes.
        continue;
      }

      const now = Date.now();
      if (now - entry.lastReplayAt < REPLAY_COOLDOWN_MS) return true;
      // Pending/unacknowledged events are already replayed by the ready handshake.
      if (
        [...pendingCaptures.values()].some(
          (pending) =>
            pending.type === "SUBTITLE_DOCUMENT" &&
            documentKey(pending.payload || {}) === documentKey(payload),
        )
      )
        return true;

      entry.lastReplayAt = now;
      postCapture("SUBTITLE_DOCUMENT", { ...payload });
      note(detected.siteId, "capture-document-replayed", {
        reason: "matching-episode",
        ownerKnown: Boolean(payload.ownerVideoId),
      });
      return true;
    }
    return false;
  }

  function scheduleResync(videoId = "") {
    if (Date.now() - lastResyncScheduledAt < 2_000) return;
    lastResyncScheduledAt = Date.now();
    for (const timer of scheduledResyncs) clearTimeout(timer);
    resyncSubtitles(videoId);
    scheduledResyncs = [600, 1800].map((delay) =>
      setTimeout(() => resyncSubtitles(videoId), delay),
    );
  }

  // The isolated-world receiver can start before or after this hook. Its ready
  // message is repeated until acknowledged; every unacknowledged capture is
  // replayed when it arrives. Subtitle text remains bounded by the same event
  // and document-size limits as live capture.
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== SOURCE) return;
    if (event.data?.channel !== CONTENT_CHANNEL) return;
    if (event.data.type === "CAPTURE_EVENT_ACK") {
      pendingCaptures.delete(String(event.data.eventId || ""));
      return;
    }
    if (
      event.data.type === "CAPTURE_CONSUMER_READY" ||
      event.data.type === "CAPTURE_ROUTE_CHANGED"
    ) {
      if (event.data.type === "CAPTURE_CONSUMER_READY") {
        window.postMessage(
          {
            source: SOURCE,
            channel: PAGE_CHANNEL,
            type: "CAPTURE_BRIDGE_READY",
          },
          "*",
        );
        for (const message of pendingCaptures.values()) {
          window.postMessage({ ...message, delivery: "replay" }, "*");
        }
      }
      scheduleResync(event.data.videoId || "");
    }
  });

  // Which service is this page, and can something play on it? A detail page
  // that has not started playing is not a playback page, so nothing is captured
  // there. The answer is recomputed per event because both services navigate
  // without reloading the document.
  function currentSite() {
    const detected = playbackSite()?.detect?.(window.location);
    if (!detected?.site) return null;
    const page = detected.site.isPlaybackPage(detected.view);
    if (!page?.ok) return null;
    return detected;
  }

  // Timed text is recognised by its format, which is the same on every service:
  // WEBVTT, TTML, and TTML's DFXP profile.
  function isLikelySubtitleText(text) {
    if (!text || text.length < 20 || text.length > 5_000_000) return false;
    const head = text.slice(0, 4000);
    return (
      /\bWEBVTT\b/i.test(head) ||
      /<tt[\s>]/i.test(head) ||
      /<p\b[^>]*(?:begin|end)=/i.test(head)
    );
  }

  function matchesUrlPatterns(patterns, url) {
    for (const source of patterns || []) {
      if (!URL_PATTERN_CACHE.has(source)) {
        try {
          URL_PATTERN_CACHE.set(source, new RegExp(source, "i"));
        } catch {
          URL_PATTERN_CACHE.set(source, null);
        }
      }
      const pattern = URL_PATTERN_CACHE.get(source);
      if (pattern?.test(String(url || ""))) return true;
    }
    return false;
  }

  function matchesSubtitleUrl(site, url) {
    return matchesUrlPatterns(site?.timedText?.urlPatterns, url);
  }

  function matchesPlaybackResourcesUrl(site, url) {
    return matchesUrlPatterns(site?.playbackResources?.urlPatterns, url);
  }

  function matchesSubtitleType(site, contentType) {
    const types = site?.timedText?.contentTypes || [];
    return types.some((entry) => contentType.includes(entry));
  }

  function publish(siteId, url, text, extra = {}) {
    if (!isLikelySubtitleText(text)) return false;
    const payload = {
      url: String(url || ""),
      text,
      site: siteId,
      ...extra,
    };
    if (url) rememberCaptured(url);
    rememberDocument(payload);
    postCapture("SUBTITLE_DOCUMENT", payload);
    return true;
  }

  // A reason only the page world can see: whether a listing named a track, and
  // whether the track itself could be read. It carries counts, a reason and a
  // language code — never subtitle text — so the event log can say what happened
  // on a service LST has no other view of.
  function note(siteId, event, details = {}) {
    // Recovery checks may see dozens of Netflix media/CDN resources whose URLs
    // merely match a broad subtitle heuristic. One note per category is enough.
    const category = [
      siteId,
      event,
      details.reason || "",
      details.source || "",
      details.contentType || "",
    ].join("|");
    const now = Date.now();
    if (
      now - (lastDiagnosticByKind.get(category) || 0) <
      DIAGNOSTIC_COOLDOWN_MS
    ) {
      return;
    }
    lastDiagnosticByKind.set(category, now);
    if (lastDiagnosticByKind.size > 80) {
      lastDiagnosticByKind.delete(lastDiagnosticByKind.keys().next().value);
    }
    postCapture(
      "SUBTITLE_CAPTURE",
      { site: siteId, event, ...details },
      { retain: false },
    );
  }

  // Do not log actual response content or signed resource URLs. The first
  // characters are used to classify only, not included in diagnostics.
  function documentKind(text) {
    const head = String(text || "")
      .trimStart()
      .slice(0, 120);
    if (/^WEBVTT/i.test(head)) return "vtt";
    if (/<tt[\s>]/i.test(head)) return "ttml";
    if (/^<!doctype\s+html|^<html[\s>]/i.test(head)) return "html";
    if (/^[\[{]/.test(head)) return "json-like";
    if (/^<\?xml|^</.test(head)) return "xml-or-html";
    if (!head) return "empty";
    if (/[\u0000-\u0008\u000E-\u001F]/.test(head)) return "binary-like";
    return "other";
  }

  function noteNetworkCapture(detected, source, captured, text, details = {}) {
    note(
      detected.siteId,
      captured ? "capture-network-accepted" : "capture-network-rejected",
      {
        source,
        reason: captured
          ? "valid-subtitle-document"
          : "invalid-subtitle-document",
        status: Number(details.status) || 0,
        contentType: String(details.contentType || "")
          .split(";")[0]
          .slice(0, 80),
        chars: String(text || "").length,
        documentKind: documentKind(text),
        pageVideoId: pageVideoId(detected),
      },
    );
  }

  // The tracks already captured from a listing. The player asks for its
  // resources more than once in a session — a quality change, a resume, an ad
  // break — and the same track must not be fetched and handed over again. The
  // set is bounded because the URLs are long and there are few of them.
  const CAPTURED_TRACK_URLS = new Set();
  const CAPTURED_TRACK_LIMIT = 20;

  function alreadyCaptured(url) {
    return CAPTURED_TRACK_URLS.has(url);
  }

  function rememberCaptured(url) {
    if (CAPTURED_TRACK_URLS.size >= CAPTURED_TRACK_LIMIT) {
      CAPTURED_TRACK_URLS.delete(CAPTURED_TRACK_URLS.values().next().value);
    }
    CAPTURED_TRACK_URLS.add(url);
  }

  // Avoid concurrent refetches and repeated requests for signed URLs that just
  // failed. Recovery primarily replays already captured documents from memory.
  async function fetchTrackText(url, siteId = "", source = "unknown") {
    if (typeof originalFetch !== "function" || !url) return "";
    if (Date.now() < (failedFetchUntil.get(url) || 0)) return "";
    if (trackFetchesInFlight.has(url)) return trackFetchesInFlight.get(url);

    const request = (async () => {
      try {
        const response = await originalFetch.call(window, url);
        if (!response?.ok) {
          if (siteId)
            note(siteId, "capture-fetch-failed", {
              reason: "http-status",
              source,
              status: Number(response?.status) || 0,
            });
          failedFetchUntil.set(url, Date.now() + FETCH_RETRY_COOLDOWN_MS);
          return "";
        }
        const text = await response.text();
        if (!isLikelySubtitleText(text)) {
          if (siteId)
            note(siteId, "capture-fetch-failed", {
              reason: "invalid-subtitle-document",
              source,
              status: Number(response.status) || 0,
              contentType: String(response.headers?.get?.("content-type") || "")
                .split(";")[0]
                .slice(0, 80),
              chars: text.length,
              documentKind: documentKind(text),
            });
          failedFetchUntil.set(
            url,
            Date.now() + INVALID_DOCUMENT_RETRY_COOLDOWN_MS,
          );
          return "";
        }
        return text;
      } catch {
        if (siteId)
          note(siteId, "capture-fetch-failed", {
            reason: "request-failed",
            source,
          });
        failedFetchUntil.set(url, Date.now() + FETCH_RETRY_COOLDOWN_MS);
        return "";
      }
    })();
    trackFetchesInFlight.set(url, request);
    try {
      return await request;
    } finally {
      trackFetchesInFlight.delete(url);
      // Keep this auxiliary map bounded; these URLs are typically signed.
      while (failedFetchUntil.size > 32) {
        failedFetchUntil.delete(failedFetchUntil.keys().next().value);
      }
    }
  }

  function checkRecentResourceTimings(detected) {
    if (!detected || typeof window.performance?.getEntriesByType !== "function")
      return;
    try {
      const entries = window.performance.getEntriesByType("resource");
      let attempted = 0;
      for (
        let i = entries.length - 1;
        i >= 0 && i >= entries.length - 40;
        i--
      ) {
        if (attempted >= MAX_TIMING_RECOVERY_REQUESTS) break;
        const url = entries[i]?.name;
        if (
          url &&
          matchesSubtitleUrl(detected.site, url) &&
          !alreadyCaptured(url) &&
          Date.now() >= (failedFetchUntil.get(url) || 0) &&
          !trackFetchesInFlight.has(url)
        ) {
          attempted++;
          fetchTrackText(url, detected.siteId, "resource-timing-poll")
            .then((text) => {
              if (text && !alreadyCaptured(url)) {
                publish(detected.siteId, url, text, {
                  capture: "resource-timing",
                  ...captureOwner(detected),
                });
              }
            })
            .catch(() => {});
        }
      }
    } catch {}
  }

  function checkActiveTrack(detected) {
    if (!detected?.site?.activeTimedTextTrack) return;
    try {
      const found = detected.site.activeTimedTextTrack(window);
      if (found?.url && !alreadyCaptured(found.url)) {
        fetchTrackText(found.url, detected.siteId, "player-api")
          .then((text) => {
            if (text && !alreadyCaptured(found.url)) {
              publish(detected.siteId, found.url, text, {
                language: found.language || "",
                capture: "player-api",
                ...captureOwner(detected),
              });
            }
          })
          .catch(() => {});
      }
    } catch {}
  }

  function resyncSubtitles(requestedVideoId = "") {
    const detected = currentSite();
    if (!detected) return;
    if (replayRecentDocument(detected, requestedVideoId)) return;
    note(detected.siteId, "capture-resync-no-document", {
      reason: "no-matching-cached-document",
      requestedEpisodeKnown: Boolean(
        requestedVideoId && requestedVideoId !== "unknown",
      ),
      cachedDocumentCount: recentDocuments.size,
    });
    checkRecentResourceTimings(detected);
    checkActiveTrack(detected);
  }

  // A listing that arrived over XHR, in whichever response type the player
  // asked for. Anything unreadable is reported rather than guessed at.
  function xhrJson(xhr) {
    try {
      if (xhr.responseType === "json") return xhr.response || null;
      if (
        xhr.responseType &&
        xhr.responseType !== "" &&
        xhr.responseType !== "text"
      ) {
        return null;
      }
      return JSON.parse(xhr.responseText);
    } catch {
      return null;
    }
  }

  // The same listing names every timed-text track a title carries. The adapter
  // says which of them is the episode's source; this fetches that one and hands
  // it over exactly as a Netflix document is handed over, so everything after
  // the capture — parsing, precompute, the cache, the overlay — is the same code.
  //
  // The listing also names the episode itself, and that answer travels as its
  // own message because it is not a subtitle document: it is which episode the
  // player is showing, which is how LST recognizes the next episode on a page
  // whose URL never moves, and how a title Amazon never names in its document
  // title gets named at all. It is published first, so the identity is known
  // before the document that shares the listing arrives.
  function publishListingIdentity(detected, payload) {
    let identity = null;
    try {
      identity = detected.site?.playbackResources?.identity?.(payload) || null;
    } catch {
      identity = null;
    }
    if (!identity) return null;
    latestListingIdentityBySite.set(detected.siteId, {
      ...identity,
      pageVideoId: pageVideoId(detected),
    });
    postCapture("EPISODE_IDENTITY", {
      site: detected.siteId,
      ...identity,
    });
    return identity;
  }

  async function captureTimedTextFromListing(detected, payload) {
    const site = detected.site;
    const identity = publishListingIdentity(detected, payload);
    let tracks = [];
    let choice = null;
    try {
      tracks = site?.playbackResources?.tracks?.(payload) || [];
      choice = site?.playbackResources?.chooseTrack?.(tracks) || null;
    } catch {
      tracks = [];
      choice = null;
    }

    const track = choice?.track || null;
    const reason = choice?.reason || "listing-unreadable";
    if (!track?.url) {
      note(detected.siteId, "playback-resources-no-track", {
        reason,
        trackCount: tracks.length,
      });
      return;
    }
    const ownerVideoId = String(identity?.videoId || "");
    const ownerPageVideoId = pageVideoId(detected);
    expireRecentDocuments();
    // Skip an already captured *document for this episode*, not merely a URL:
    // different episodes could theoretically receive the same resource URL.
    if (
      [...recentDocuments.values()].some(
        ({ payload: saved }) =>
          saved.site === detected.siteId &&
          saved.url === track.url &&
          saved.ownerVideoId === ownerVideoId &&
          saved.pageVideoId === ownerPageVideoId,
      )
    ) {
      note(detected.siteId, "capture-duplicate-skipped", {
        reason: "document-already-retained",
        ownerKnown: Boolean(ownerVideoId),
      });
      return;
    }

    const text = await fetchTrackText(
      track.url,
      detected.siteId,
      "playback-resources",
    );
    const captured = publish(detected.siteId, track.url, text, {
      capture: "playback-resources",
      language: track.languageCode,
      reason,
      ownerVideoId,
      pageVideoId: ownerPageVideoId,
    });
    note(
      detected.siteId,
      captured
        ? "playback-resources-track-captured"
        : "playback-resources-track-unreadable",
      {
        reason,
        trackCount: tracks.length,
        language: track.languageCode || "unknown",
      },
    );
  }

  // Reading a listing is not finished when this returns: the track it names
  // still has to be fetched, and that is a whole episode's subtitle document.
  // The copy is taken here, synchronously, before the player can read the body
  // itself; the fetch that follows is left to run on its own, so the player's
  // own request is never held up by LST's.
  function capturePlaybackResources(detected, response) {
    let copy;
    try {
      copy = response.clone();
    } catch {
      return;
    }
    (async () => {
      let payload;
      try {
        payload = await copy.json();
      } catch {
        note(detected.siteId, "playback-resources-unreadable", {
          reason: "listing-not-json",
        });
        return;
      }
      await captureTimedTextFromListing(detected, payload);
    })().catch(() => {});
  }

  async function inspectResponse(response, requestDetected = null) {
    const detected = requestDetected || currentSite();
    if (!detected) return;
    try {
      const url = response.url || "";
      if (matchesPlaybackResourcesUrl(detected.site, url)) {
        capturePlaybackResources(detected, response);
        return;
      }

      const type = (response.headers.get("content-type") || "").toLowerCase();
      const length = Number(response.headers.get("content-length") || 0);

      if (
        !matchesSubtitleType(detected.site, type) &&
        !matchesSubtitleUrl(detected.site, url)
      ) {
        return;
      }
      if (length && length > 5_000_000) return;

      const text = await response.clone().text();

      const captured = publish(
        detected.siteId,
        url,
        text,
        captureOwner(detected),
      );

      noteNetworkCapture(detected, "fetch", captured, text, {
        status: response.status,
        contentType: type,
      });
    } catch {
      // Never let diagnostics interfere with playback.
    }
  }

  window.fetch = async function (...args) {
    const detectedAtRequest = currentSite();
    const response = await originalFetch.apply(this, args);
    await inspectResponse(response, detectedAtRequest);
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__notSubtitleUrl = String(url || "");
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const detectedAtRequest = currentSite();
    if (detectedAtRequest) {
      this.addEventListener("load", function () {
        const detected = detectedAtRequest;
        try {
          const url = this.responseURL || this.__notSubtitleUrl || "";
          if (matchesPlaybackResourcesUrl(detected.site, url)) {
            const payload = xhrJson(this);
            if (payload) {
              captureTimedTextFromListing(detected, payload).catch(() => {});
            } else {
              note(detected.siteId, "playback-resources-unreadable", {
                reason: "listing-not-json",
              });
            }
            return;
          }

          const type = (
            this.getResponseHeader("content-type") || ""
          ).toLowerCase();

          if (
            !matchesSubtitleType(detected.site, type) &&
            !matchesSubtitleUrl(detected.site, url)
          ) {
            return;
          }
          if (this.responseType === "" || this.responseType === "text") {
            const text = this.responseText;
            const captured = publish(
              detected.siteId,
              url,
              text,
              captureOwner(detected),
            );
            noteNetworkCapture(detected, "xhr", captured, text, {
              status: this.status,
              contentType: type,
            });
          } else if (
            this.responseType === "arraybuffer" &&
            this.response &&
            typeof TextDecoder !== "undefined"
          ) {
            try {
              const text = new TextDecoder("utf-8").decode(this.response);
              const captured = publish(
                detected.siteId,
                url,
                text,
                captureOwner(detected),
              );
              noteNetworkCapture(detected, "xhr", captured, text, {
                status: this.status,
                contentType: type,
              });
            } catch {}
          } else if (this.responseType === "blob" && this.response) {
            this.response
              .text()
              .then((text) => {
                const captured = publish(
                  detected.siteId,
                  url,
                  text,
                  captureOwner(detected),
                );
                noteNetworkCapture(detected, "xhr", captured, text, {
                  status: this.status,
                  contentType: type,
                });
              })
              .catch(() => {});
          }
        } catch {
          // Ignore capture failures.
        }
      });
    }

    return originalSend.apply(this, args);
  };

  if (typeof window.PerformanceObserver === "function") {
    try {
      const observer = new PerformanceObserver((list) => {
        const detected = currentSite();
        if (!detected) return;
        for (const entry of list.getEntries()) {
          const url = entry?.name;
          if (
            url &&
            matchesSubtitleUrl(detected.site, url) &&
            !alreadyCaptured(url)
          ) {
            fetchTrackText(url, detected.siteId, "resource-timing-observer")
              .then((text) => {
                if (text && !alreadyCaptured(url)) {
                  publish(detected.siteId, url, text, {
                    capture: "resource-timing",
                    ...captureOwner(detected),
                  });
                }
              })
              .catch(() => {});
          }
        }
      });
      observer.observe({ type: "resource", buffered: true });
    } catch {}
  }

  window.addEventListener("popstate", () => {
    scheduleResync();
  });
})();
