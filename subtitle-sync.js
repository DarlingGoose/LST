(() => {
  "use strict";

  function simplifySubtitleText(text) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim()
      .replace(/\s+/g, " ")
      .toLocaleLowerCase()
      .replace(/[\p{P}\p{S}\s]+/gu, "");
  }

  function findUniqueSimplifiedCue(cues, text) {
    const simplified = simplifySubtitleText(text);
    if (simplified.length < 2) return null;

    let match = null;
    for (let index = 0; index < cues.length; index++) {
      if (simplifySubtitleText(cues[index]?.text) !== simplified) continue;
      if (match) return null;
      match = { cue: cues[index], index };
    }
    return match;
  }

  function isInterCueGapMatch(cues, match, naturalTime, naturalMatch) {
    if (!match || naturalMatch || naturalTime < match.cue.end) return false;
    const nextCue = cues[match.index + 1];
    return Boolean(nextCue && naturalTime < nextCue.start);
  }

  globalThis.LSTSubtitleSync = Object.freeze({
    findUniqueSimplifiedCue,
    isInterCueGapMatch,
    simplifySubtitleText,
  });
})();
