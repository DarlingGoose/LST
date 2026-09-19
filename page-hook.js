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
  const URL_PATTERN_CACHE = new Map();
  // The page's own fetch, kept before the wrapper below replaces it. The
  // document a listing names is fetched with this one, so LST's own request is
  // never observed and handed back to itself.
  const originalFetch = window.fetch;

  function playbackSite() {
    return window.LSTPlaybackSite || null;
  }

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
    window.postMessage(
      {
        source: SOURCE,
        type: "SUBTITLE_DOCUMENT",
        payload: { url: String(url || ""), text, site: siteId, ...extra }
      },
      "*"
    );
    return true;
  }

  // A reason only the page world can see: whether a listing named a track, and
  // whether the track itself could be read. It carries counts, a reason and a
  // language code — never subtitle text — so the event log can say what happened
  // on a service LST has no other view of.
  function note(siteId, event, details = {}) {
    window.postMessage(
      {
        source: SOURCE,
        type: "SUBTITLE_CAPTURE",
        payload: { site: siteId, event, ...details },
      },
      "*",
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

  // The track itself, fetched here in the page world. These URLs are signed and
  // short-lived, so the document is read now and never asked for again; a
  // request that fails leaves nothing behind but a reason.
  async function fetchTrackText(url) {
    if (typeof originalFetch !== "function") return "";
    try {
      const response = await originalFetch.call(window, url);
      if (!response?.ok) return "";
      return await response.text();
    } catch {
      return "";
    }
  }

  // A listing that arrived over XHR, in whichever response type the player
  // asked for. Anything unreadable is reported rather than guessed at.
  function xhrJson(xhr) {
    try {
      if (xhr.responseType === "json") return xhr.response || null;
      if (xhr.responseType && xhr.responseType !== "" && xhr.responseType !== "text") {
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
    if (!identity) return;
    window.postMessage(
      {
        source: SOURCE,
        type: "EPISODE_IDENTITY",
        payload: { site: detected.siteId, ...identity },
      },
      "*",
    );
  }

  async function captureTimedTextFromListing(detected, payload) {
    const site = detected.site;
    publishListingIdentity(detected, payload);
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
    if (alreadyCaptured(track.url)) return;

    const text = await fetchTrackText(track.url);
    const captured = publish(detected.siteId, track.url, text, {
      capture: "playback-resources",
      language: track.languageCode,
      reason,
    });
    if (captured) rememberCaptured(track.url);
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

  async function inspectResponse(response) {
    const detected = currentSite();
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
      publish(detected.siteId, url, text);
    } catch {
      // Never let diagnostics interfere with playback.
    }
  }

  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    await inspectResponse(response);
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__notSubtitleUrl = String(url || "");
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (currentSite()) {
      this.addEventListener("load", function () {
        const detected = currentSite();
        if (!detected) return;
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

          const type = (this.getResponseHeader("content-type") || "").toLowerCase();

          if (
            !matchesSubtitleType(detected.site, type) &&
            !matchesSubtitleUrl(detected.site, url)
          ) {
            return;
          }
          if (this.responseType && this.responseType !== "" && this.responseType !== "text") {
            return;
          }

          publish(detected.siteId, url, this.responseText);
        } catch {
          // Ignore capture failures.
        }
      });
    }

    return originalSend.apply(this, args);
  };
})();
