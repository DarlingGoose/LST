// Pure local-video identity and timeline helpers. File access, object URLs,
// playback, storage, and translation stay in the extension page that calls it.
(() => {
  "use strict";

  function normalizeText(value) {
    return String(value ?? "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();
  }

  function cueKey(cue) {
    return [
      Math.round(Number(cue?.start) * 1000),
      Math.round(Number(cue?.end) * 1000),
      normalizeText(cue?.text),
    ].join(":");
  }

  // Two independent 32-bit rolling hashes form a stable local identifier. This
  // is identity rather than a security boundary; keeping it number-only makes
  // hashing a large subtitle file cheap. Including both file facts and subtitle
  // text makes reopening the same pair find its cache while replacing either
  // file creates a different episode identity.
  function fingerprint(value) {
    const bytes = new TextEncoder().encode(String(value ?? ""));
    let left = 0x811c9dc5;
    let right = 0x9e3779b9;
    for (const byte of bytes) {
      left = Math.imul(left ^ byte, 0x01000193);
      right = Math.imul(right ^ byte, 0x85ebca6b);
      right ^= right >>> 13;
    }
    return [left, right]
      .map((part) => (part >>> 0).toString(16).padStart(8, "0"))
      .join("");
  }

  function fileFacts(file) {
    return [file?.name || "", Number(file?.size) || 0, Number(file?.lastModified) || 0];
  }

  function mediaIdentity(videoFile, subtitleFile, subtitleText) {
    const seed = JSON.stringify([
      "local-video-v1",
      fileFacts(videoFile),
      fileFacts(subtitleFile),
      String(subtitleText ?? ""),
    ]);
    return `local-${fingerprint(seed)}`;
  }

  function activeCuesAt(cues, time) {
    const position = Number(time);
    if (!Number.isFinite(position) || !Array.isArray(cues)) return [];
    return cues.filter((cue) =>
      Number(cue?.start) <= position && Number(cue?.end) > position,
    );
  }

  const api = Object.freeze({ activeCuesAt, cueKey, fingerprint, mediaIdentity, normalizeText });
  globalThis.LSTLocalVideo = api;
  if (typeof module !== "undefined" && module?.exports) module.exports = api;
})();
