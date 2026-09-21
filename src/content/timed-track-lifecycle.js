// Timed-track synchronization state.
//
// The content runtime decides whether rendered text matches a cue and performs
// diagnostics/rendering effects. This module owns how those observations move a
// captured timeline between unverified, verified, and mismatch states.
(() => {
  const STATE = Object.freeze({
    unverified: "unverified",
    verified: "verified",
    mismatch: "mismatch",
  });

  function createTimedTrackLifecycle({ mismatchGraceMs = 300 } = {}) {
    let state = STATE.unverified;
    let automaticOffsetSeconds = 0;
    let lastRenderedText = "";
    let mismatchSince = 0;
    let mismatchReason = "";
    let mismatchSequence = 0;
    let activeMismatchId = 0;
    let noCueSince = 0;

    function mismatchDetails(at) {
      return {
        mismatchId: activeMismatchId,
        durationMs: mismatchSince
          ? Math.max(0, Math.round(Number(at) - mismatchSince))
          : null,
        previousReason: mismatchReason || "confirmed-mismatch",
      };
    }

    function clearMismatch({ clearId = true } = {}) {
      mismatchSince = 0;
      mismatchReason = "";
      if (clearId) activeMismatchId = 0;
    }

    return Object.freeze({
      get state() {
        return state;
      },
      get automaticOffsetSeconds() {
        return automaticOffsetSeconds;
      },
      get lastRenderedText() {
        return lastRenderedText;
      },
      get verified() {
        return state === STATE.verified;
      },
      get mismatched() {
        return state === STATE.mismatch;
      },
      snapshot() {
        return {
          state,
          automaticOffsetSeconds,
          lastRenderedText,
          mismatchSince,
          mismatchReason,
          mismatchSequence,
          activeMismatchId,
          noCueSince,
        };
      },
      reset({ nextState = STATE.unverified, resetSequence = false } = {}) {
        state = nextState === STATE.verified ? STATE.verified : STATE.unverified;
        automaticOffsetSeconds = 0;
        lastRenderedText = "";
        clearMismatch();
        noCueSince = 0;
        if (resetSequence) mismatchSequence = 0;
      },
      withdraw() {
        state = STATE.unverified;
        automaticOffsetSeconds = 0;
        lastRenderedText = "";
        clearMismatch();
      },
      verify(renderedText, at) {
        const resolved =
          mismatchSince || state === STATE.mismatch
            ? mismatchDetails(at)
            : null;
        state = STATE.verified;
        lastRenderedText = String(renderedText || "");
        clearMismatch();
        return { resolved };
      },
      anchor({ renderedText = "", cueStart, videoTime } = {}) {
        automaticOffsetSeconds = Number(cueStart) + 0.04 - Number(videoTime);
        state = STATE.verified;
        lastRenderedText = String(renderedText || "");
        clearMismatch();
        return { automaticOffsetSeconds };
      },
      beginMismatch(reason, at) {
        const normalizedReason = String(reason || "unknown-text");
        const timestamp = Number(at);
        let started = false;
        if (!mismatchSince || mismatchReason !== normalizedReason) {
          mismatchSince = timestamp;
          mismatchReason = normalizedReason;
          activeMismatchId = ++mismatchSequence;
          started = true;
        }
        return {
          started,
          mismatchId: activeMismatchId,
          reason: mismatchReason,
          graceMs: mismatchGraceMs,
          elapsedMs: Math.max(0, timestamp - mismatchSince),
          withinGrace: timestamp - mismatchSince < mismatchGraceMs,
        };
      },
      confirmMismatch(renderedText, at) {
        const newlyConfirmed = state !== STATE.mismatch;
        const details = mismatchDetails(at);
        state = STATE.mismatch;
        lastRenderedText = String(renderedText || "");
        return { newlyConfirmed, ...details };
      },
      reanchor({ renderedText = "", cueStart, videoTime, at } = {}) {
        const details = mismatchDetails(at);
        automaticOffsetSeconds = Number(cueStart) + 0.04 - Number(videoTime);
        state = STATE.verified;
        lastRenderedText = String(renderedText || "");
        clearMismatch();
        return { ...details, automaticOffsetSeconds };
      },
      noteIdle(at) {
        if (!mismatchSince && state !== STATE.mismatch) {
          return { reported: false, verified: state === STATE.verified };
        }
        const details = mismatchDetails(at);
        // Silence cannot resolve a confirmed mismatch. It only ends a pending
        // grace window; a later matching line must verify the track again.
        clearMismatch({ clearId: state !== STATE.mismatch });
        return {
          reported: true,
          verified: state === STATE.verified,
          ...details,
        };
      },
      noteNoCue(at) {
        if (!noCueSince) noCueSince = Number(at);
        return noCueSince;
      },
      noCueDuration(at) {
        return noCueSince ? Math.max(0, Number(at) - noCueSince) : 0;
      },
      clearNoCue() {
        noCueSince = 0;
      },
    });
  }

  const api = Object.freeze({ STATE, createTimedTrackLifecycle });
  globalThis.LSTTimedTrackLifecycle = api;
  if (typeof module !== "undefined" && module?.exports) module.exports = api;
})();
