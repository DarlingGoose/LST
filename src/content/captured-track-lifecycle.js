// Captured-track handoff state.
//
// Streaming players can fetch the next episode's subtitle document before the
// content runtime notices that the episode changed. This module owns that one
// held document and decides when it may be dropped or offered to the player.
// Parsing, DOM reads, diagnostics, and installing a track remain caller effects.
(() => {
  const DEFAULT_FRESH_MS = 120_000;
  const DEFAULT_RESTARTED_ITEM_SECONDS = 60;

  function knownIdentity(value) {
    const normalized = String(value || "").trim();
    return normalized && normalized !== "unknown" ? normalized : "";
  }

  function createCapturedTrackLifecycle({
    freshMs = DEFAULT_FRESH_MS,
    restartedItemSeconds = DEFAULT_RESTARTED_ITEM_SECONDS,
    now = () => Date.now(),
  } = {}) {
    let held = null;
    let askedForRenderedLine = "";

    function ageMs(document = held) {
      return document
        ? Math.max(0, Number(now()) - (Number(document.at) || 0))
        : null;
    }

    function isFresh(document = held) {
      const age = ageMs(document);
      return age != null && age <= freshMs;
    }

    function consume(reason, details = {}) {
      if (!held) return { action: "keep", reason: "no-held-document" };
      const document = held;
      held = null;
      askedForRenderedLine = "";
      return {
        action: "adopt",
        reason,
        details: { ...details },
        document,
        ageMs: ageMs(document),
      };
    }

    return Object.freeze({
      get current() {
        return held;
      },
      hold({
        url = "",
        text = "",
        details = {},
        videoId = "",
        pageVideoId = "",
        videoTime,
        foldedLines = [],
        at = now(),
      } = {}) {
        const folded = new Set(foldedLines);
        if (typeof text !== "string" || !text.trim() || !folded.size) {
          return { action: "refuse", reason: "empty-document" };
        }
        held = {
          url: String(url || ""),
          text,
          details: { ...details },
          videoId: String(videoId || ""),
          pageVideoId: String(pageVideoId || ""),
          videoTime: Number(videoTime),
          at: Number(at) || Number(now()),
          folded,
          restartOffered: false,
        };
        askedForRenderedLine = "";
        return { action: "held", reason: "document-held", document: held };
      },
      ageMs,
      snapshot() {
        return {
          held: Boolean(held),
          ageMs: ageMs(),
          videoId: held?.videoId || "",
          pageVideoId: held?.pageVideoId || "",
        };
      },
      resetRenderedLine() {
        askedForRenderedLine = "";
      },
      clearIfDocument(text) {
        if (!held || held.text !== text) return false;
        held = null;
        askedForRenderedLine = "";
        return true;
      },
      dropIfCurrentDocument(text, decision = {}) {
        if (!decision.incomingWithinExisting || !held || held.text !== text) {
          return { action: "keep", reason: "document-not-current-track" };
        }
        const document = held;
        held = null;
        askedForRenderedLine = "";
        return {
          action: "drop",
          reason: "document-is-current-track",
          document,
        };
      },
      offerEmptyTrack({
        reason = "track-empty",
        hasTrack = false,
        currentVideoId = "",
        currentPageVideoId = "",
      } = {}) {
        if (!held) return { action: "keep", reason: "no-held-document" };
        if (hasTrack) return { action: "keep", reason: "track-not-empty" };

        const capturedVideoId = knownIdentity(held.videoId);
        const capturedPageVideoId = knownIdentity(held.pageVideoId);
        const videoId = knownIdentity(currentVideoId);
        const addressId = knownIdentity(currentPageVideoId);
        const capturedAnotherAddress = Boolean(
          capturedPageVideoId && addressId && capturedPageVideoId !== addressId,
        );
        const namesAnotherEpisode = Boolean(
          capturedVideoId && videoId && capturedVideoId !== videoId,
        );
        if (
          held.details?.capture === "playback-resources" &&
          capturedAnotherAddress &&
          namesAnotherEpisode
        ) {
          return {
            action: "keep",
            reason: "held-document-other-episode",
            document: held,
          };
        }
        if (!isFresh()) {
          return {
            action: "keep",
            reason: "held-document-stale",
            document: held,
            ageMs: ageMs(),
          };
        }
        return consume(reason);
      },
      offerRestart({ videoTime } = {}) {
        if (!held) return { action: "keep", reason: "no-held-document" };
        if (!isFresh()) return { action: "keep", reason: "held-document-stale" };
        if (held.restartOffered) {
          return { action: "keep", reason: "restart-already-offered" };
        }
        const currentTime = Number(videoTime);
        const capturedTime = Number(held.videoTime);
        if (!Number.isFinite(currentTime) || !Number.isFinite(capturedTime)) {
          return { action: "keep", reason: "video-time-unavailable" };
        }
        if (
          !(currentTime < restartedItemSeconds &&
            capturedTime - currentTime > restartedItemSeconds)
        ) {
          return { action: "keep", reason: "item-not-restarted" };
        }
        held.restartOffered = true;
        return consume("item-restarted-in-held-document", {
          trackReason: "held-document-for-restarted-item",
          capturedVideoTimeMs: Math.round(capturedTime * 1000),
          videoTimeMs: Math.round(currentTime * 1000),
        });
      },
      offerRenderedLine({ foldedText = "", currentTrackHasLine = false } = {}) {
        if (!held) return { action: "keep", reason: "no-held-document" };
        if (!isFresh()) return { action: "keep", reason: "held-document-stale" };
        const key = String(foldedText || "");
        if (!key || !held.folded.has(key)) {
          return { action: "keep", reason: "rendered-line-not-held" };
        }
        if (askedForRenderedLine === key) {
          return { action: "keep", reason: "rendered-line-already-offered" };
        }
        askedForRenderedLine = key;
        if (currentTrackHasLine) {
          return { action: "keep", reason: "rendered-line-in-current-track" };
        }
        return consume("rendered-line-in-held-document", {
          trackReason: "held-document-matches-rendered-line",
        });
      },
    });
  }

  const api = Object.freeze({
    DEFAULT_FRESH_MS,
    DEFAULT_RESTARTED_ITEM_SECONDS,
    createCapturedTrackLifecycle,
  });
  globalThis.LSTCapturedTrackLifecycle = api;
  if (typeof module !== "undefined" && module?.exports) module.exports = api;
})();
