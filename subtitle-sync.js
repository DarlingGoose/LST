(() => {
  "use strict";

  // A service renders the same line differently from the captured track:
  // DOM wrapping differs, entities come back re-encoded, quotes/dashes/ellipses
  // arrive from other Unicode blocks, widths mix, and a rendered line can be a
  // join of two adjacent cues. Identity therefore compares a folded key instead
  // of raw text, and time is used as the second signal when a folded key alone
  // cannot separate two cues.

  const ZERO_WIDTH_PATTERN = /[\u200b-\u200f\u2060\ufeff]/g;
  const SOFT_HYPHEN_PATTERN = /\u00ad/g;
  const SINGLE_QUOTE_PATTERN = /[\u2018\u2019\u201a\u201b\u2032\u02bc\u0060\u00b4]/g;
  const DOUBLE_QUOTE_PATTERN = /[\u201c\u201d\u201e\u201f\u2033\u00ab\u00bb]/g;
  const DASH_PATTERN = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g;
  const ELLIPSIS_PATTERN = /\u2026/g;
  const WHITESPACE_PATTERN = /[\s\u00a0]+/g;

  const MIN_LOOSE_TEXT_LENGTH = 2;
  // Cue boundaries are exact to about a frame; anything closer is a tie.
  const TIME_TIE_EPSILON_SECONDS = 0.05;

  const MATCH_TIER = Object.freeze({ none: 0, loose: 1, folded: 2 });

  const cueKeysByCue = new WeakMap();

  function foldSubtitleText(text) {
    return String(text || "")
      .normalize("NFKC")
      .replace(ZERO_WIDTH_PATTERN, "")
      .replace(SOFT_HYPHEN_PATTERN, "")
      .replace(SINGLE_QUOTE_PATTERN, "'")
      .replace(DOUBLE_QUOTE_PATTERN, '"')
      .replace(DASH_PATTERN, "-")
      .replace(ELLIPSIS_PATTERN, "...")
      .replace(WHITESPACE_PATTERN, " ")
      .trim();
  }

  function simplifySubtitleText(text) {
    return foldSubtitleText(text)
      .toLocaleLowerCase()
      .replace(/[\p{P}\p{S}\s]+/gu, "");
  }

  function cueKeys(cue) {
    if (!cue || typeof cue !== "object") {
      return {
        folded: foldSubtitleText(cue?.text),
        loose: simplifySubtitleText(cue?.text),
      };
    }
    const cached = cueKeysByCue.get(cue);
    if (cached) return cached;
    const keys = {
      folded: foldSubtitleText(cue?.text),
      loose: simplifySubtitleText(cue?.text),
    };
    cueKeysByCue.set(cue, keys);
    return keys;
  }

  function matchTier(left, right) {
    const foldedLeft = foldSubtitleText(left);
    if (!foldedLeft) return MATCH_TIER.none;
    if (foldedLeft === foldSubtitleText(right)) return MATCH_TIER.folded;
    const looseLeft = simplifySubtitleText(left);
    if (
      looseLeft.length >= MIN_LOOSE_TEXT_LENGTH &&
      looseLeft === simplifySubtitleText(right)
    ) {
      return MATCH_TIER.loose;
    }
    return MATCH_TIER.none;
  }

  function cueDistanceSeconds(cue, expectedTime) {
    const expected = Number(expectedTime);
    const start = Number(cue?.start);
    const end = Number(cue?.end);
    if (
      !Number.isFinite(expected) ||
      !Number.isFinite(start) ||
      !Number.isFinite(end)
    ) {
      return Infinity;
    }
    if (expected < start) return start - expected;
    if (expected >= end) return expected - end;
    return 0;
  }

  // Resolves the cue the rendered line belongs to. Candidates are ranked by how
  // much of their text survived normalization first, then by playback time. Playback
  // time is only allowed to separate equally good text candidates when the caller
  // states the track timeline is already trusted; on a timeline that may still be
  // offset, an unseparated line is reported as ambiguous instead of being guessed.
  function pickBest(candidates, tier, reason, trustTime) {
    if (candidates.length === 1) {
      return {
        ...candidates[0],
        tier,
        reason,
        resolvedBy: "unique",
        ambiguous: false,
        timeTrusted: trustTime,
        candidateCount: candidates.length,
      };
    }
    const ranked = [...candidates].sort((a, b) => a.distance - b.distance);
    const separable =
      trustTime &&
      Number.isFinite(ranked[0].distance) &&
      ranked[1].distance - ranked[0].distance > TIME_TIE_EPSILON_SECONDS;
    if (!separable) {
      return {
        cue: null,
        index: -1,
        tier,
        reason: "ambiguous",
        resolvedBy: "none",
        ambiguous: true,
        timeTrusted: trustTime,
        candidateCount: candidates.length,
      };
    }
    return {
      ...ranked[0],
      tier,
      reason,
      resolvedBy: "nearest",
      ambiguous: false,
      timeTrusted: trustTime,
      candidateCount: candidates.length,
    };
  }

  function findJoinedCandidate(list, loose, expectedTime, trustTime) {
    if (loose.length < MIN_LOOSE_TEXT_LENGTH * 2) return null;
    const matches = [];
    for (let index = 0; index + 1 < list.length; index++) {
      const first = list[index];
      const second = list[index + 1];
      const joined = `${cueKeys(first).loose}${cueKeys(second).loose}`;
      if (joined !== loose) continue;
      matches.push({
        cue: first,
        index,
        secondIndex: index + 1,
        distance: cueDistanceSeconds(first, expectedTime),
      });
    }
    if (!matches.length) return null;
    return pickBest(matches, MATCH_TIER.loose, "joined", trustTime);
  }

  function resolveCue(cues, text, expectedTime, options = {}) {
    const trustTime = options.trustTime !== false;
    const list = Array.isArray(cues) ? cues : [];
    const folded = foldSubtitleText(text);
    if (!folded) return null;
    const loose = simplifySubtitleText(text);

    const candidates = [];
    for (let index = 0; index < list.length; index++) {
      const cue = list[index];
      const keys = cueKeys(cue);
      let tier = MATCH_TIER.none;
      if (keys.folded === folded) tier = MATCH_TIER.folded;
      else if (loose.length >= MIN_LOOSE_TEXT_LENGTH && keys.loose === loose) {
        tier = MATCH_TIER.loose;
      }
      if (!tier) continue;
      candidates.push({
        cue,
        index,
        tier,
        distance: cueDistanceSeconds(cue, expectedTime),
      });
    }

    if (!candidates.length) {
      return findJoinedCandidate(list, loose, expectedTime, trustTime);
    }

    const tier = candidates.reduce(
      (best, entry) => Math.max(best, entry.tier),
      MATCH_TIER.none,
    );
    return pickBest(
      candidates.filter((entry) => entry.tier === tier),
      tier,
      tier === MATCH_TIER.folded ? "folded" : "loose",
      trustTime,
    );
  }

  function isInterCueGapMatch(cues, match, naturalTime, naturalMatch) {
    if (!match || naturalMatch || naturalTime < match.cue.end) return false;
    const nextCue = cues[match.index + 1];
    return Boolean(nextCue && naturalTime < nextCue.start);
  }

  // Captured documents ------------------------------------------------
  // A captured timed-text document is either the track LST is already using,
  // possibly rendered or re-encoded differently, a neighbouring part of that
  // track, or a different track entirely. The relationship is decided by cue
  // membership and time coverage, never by cue-count or duration ratios: a
  // fragment of the current track is a document whose cues the current track
  // already has, whatever its size.

  const TRACK_RELATIONSHIP = Object.freeze({
    none: "none",
    equivalent: "equivalent",
    superset: "superset",
    subset: "subset",
    sameTimeline: "same-timeline",
    extension: "extension",
    overlap: "overlap",
    disjoint: "disjoint",
  });

  function asCueList(cues) {
    return Array.isArray(cues)
      ? cues.filter((cue) => cue && typeof cue === "object")
      : [];
  }

  function cueTimingKey(cue) {
    const start = Number(cue?.start);
    const end = Number(cue?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
    return `${Math.round(start * 1000)}:${Math.round(end * 1000)}`;
  }

  function cueIdentityKey(cue) {
    if (!cue || typeof cue !== "object") return "";
    return `${cueTimingKey(cue)}:${cueKeys(cue).folded}`;
  }

  function countCueKeys(cues, keyOf) {
    const counts = new Map();
    for (const cue of cues) {
      const key = keyOf(cue);
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }

  function cueListRange(cues) {
    let start = Infinity;
    let end = -Infinity;
    for (const cue of cues) {
      const cueStart = Number(cue?.start);
      const cueEnd = Number(cue?.end);
      if (!Number.isFinite(cueStart) || !Number.isFinite(cueEnd)) continue;
      if (cueStart < start) start = cueStart;
      if (cueEnd > end) end = cueEnd;
    }
    return Number.isFinite(start) && Number.isFinite(end)
      ? { start, end, span: Math.max(0, end - start) }
      : { start: 0, end: 0, span: 0 };
  }

  // Replacing the current track loses every cue only that track has, so LST
  // adopts an incoming document only for a reason it can name: the document
  // contains the whole current track, it is a new part of the same track, it
  // holds the line the player is rendering while the current track does not, or
  // the current track was never confirmed by that rendering. What LST
  // could not decide is reported as `keep`, with the reason it could not decide.
  function resolveTrackDocument(existingCues, incomingCues, options = {}) {
    const existing = asCueList(existingCues);
    const incoming = asCueList(incomingCues);
    const trustExisting = options.trustExisting === true;
    const renderedText = foldSubtitleText(options.renderedText);
    const renderedMatches = (cues) =>
      Boolean(renderedText) &&
      cues.some((cue) => cueKeys(cue).folded === renderedText);

    const existingCounts = countCueKeys(existing, cueIdentityKey);
    const incomingCounts = countCueKeys(incoming, cueIdentityKey);

    let sharedCueCount = 0;
    let incomingOnlyCueCount = 0;
    for (const [key, count] of incomingCounts) {
      const shared = Math.min(count, existingCounts.get(key) || 0);
      sharedCueCount += shared;
      incomingOnlyCueCount += count - shared;
    }
    let existingOnlyCueCount = 0;
    for (const [key, count] of existingCounts) {
      existingOnlyCueCount += count - Math.min(count, incomingCounts.get(key) || 0);
    }

    const existingTimings = new Set(existing.map(cueTimingKey).filter(Boolean));
    const incomingTimings = new Set(incoming.map(cueTimingKey).filter(Boolean));
    let timingMatchCount = 0;
    for (const timing of incomingTimings) {
      if (existingTimings.has(timing)) timingMatchCount += 1;
    }
    const sameTimings =
      incomingTimings.size > 0 &&
      incomingTimings.size === existingTimings.size &&
      timingMatchCount === incomingTimings.size;

    const existingRange = cueListRange(existing);
    const incomingRange = cueListRange(incoming);
    const timeRangesOverlap = Boolean(
      existing.length &&
        incoming.length &&
        incomingRange.start < existingRange.end &&
        existingRange.start < incomingRange.end,
    );

    let relationship;
    if (!existing.length) relationship = TRACK_RELATIONSHIP.none;
    else if (!incomingOnlyCueCount && !existingOnlyCueCount) {
      relationship = TRACK_RELATIONSHIP.equivalent;
    } else if (!existingOnlyCueCount) relationship = TRACK_RELATIONSHIP.superset;
    else if (!incomingOnlyCueCount) relationship = TRACK_RELATIONSHIP.subset;
    else if (!sharedCueCount && !timeRangesOverlap) {
      relationship = TRACK_RELATIONSHIP.extension;
    } else if (sameTimings) relationship = TRACK_RELATIONSHIP.sameTimeline;
    else if (!sharedCueCount) relationship = TRACK_RELATIONSHIP.disjoint;
    else relationship = TRACK_RELATIONSHIP.overlap;

    const renderedMatchesIncoming = renderedMatches(incoming);
    const renderedMatchesExisting = renderedMatches(existing);

    let accept;
    let reason;
    if (relationship === TRACK_RELATIONSHIP.none) {
      accept = true;
      reason = "no-existing-track";
    } else if (relationship === TRACK_RELATIONSHIP.equivalent) {
      accept = false;
      reason = "equivalent-track";
    } else if (relationship === TRACK_RELATIONSHIP.superset) {
      accept = true;
      reason = "fuller-track";
    } else if (relationship === TRACK_RELATIONSHIP.subset) {
      accept = false;
      reason = "already-covered";
    } else if (relationship === TRACK_RELATIONSHIP.extension) {
      accept = true;
      reason = "track-extension";
    } else if (renderedMatchesIncoming && !renderedMatchesExisting) {
      accept = true;
      reason = "matches-rendered-line";
    } else if (renderedMatchesExisting && !renderedMatchesIncoming) {
      accept = false;
      reason = "matches-current-track";
    } else if (relationship === TRACK_RELATIONSHIP.sameTimeline) {
      accept = !trustExisting;
      reason = "same-timeline-different-text";
    } else if (relationship === TRACK_RELATIONSHIP.overlap) {
      accept = !trustExisting;
      reason = "partial-overlap";
    } else {
      accept = !trustExisting;
      reason = "unrelated-track";
    }

    return {
      accept,
      reason,
      relationship,
      // Keep every cue the current track has when the two documents are known
      // to describe the same track, so a later capture cannot drop an earlier
      // part of the episode.
      union:
        accept &&
        (relationship === TRACK_RELATIONSHIP.extension ||
          relationship === TRACK_RELATIONSHIP.superset),
      trustExisting,
      renderedMatchesIncoming,
      renderedMatchesExisting,
      timeRangesOverlap,
      existingCueCount: existing.length,
      incomingCueCount: incoming.length,
      sharedCueCount,
      incomingOnlyCueCount,
      existingOnlyCueCount,
      timingMatchCount,
      existingSpanSeconds: existingRange.span,
      incomingSpanSeconds: incomingRange.span,
    };
  }

  // Adopt the incoming document, substituting the current track's own cue
  // objects wherever both documents already agree on the same cue, so cache
  // keys and stored translations for those lines stay valid.
  function adoptTrackDocument(existingCues, incomingCues, options = {}) {
    const existing = asCueList(existingCues);
    const incoming = asCueList(incomingCues);
    const reuse = new Map();
    for (const cue of existing) {
      const key = cueIdentityKey(cue);
      const list = reuse.get(key);
      if (list) list.push(cue);
      else reuse.set(key, [cue]);
    }

    const adopted = [];
    const claimed = new Set();
    for (const cue of incoming) {
      const list = reuse.get(cueIdentityKey(cue));
      const twin = list && list.length ? list.shift() : null;
      if (twin) claimed.add(twin);
      adopted.push(twin || cue);
    }
    if (options.union === true) {
      for (const cue of existing) {
        if (!claimed.has(cue)) adopted.push(cue);
      }
    }

    return adopted.sort(
      (left, right) => (Number(left?.start) || 0) - (Number(right?.start) || 0),
    );
  }

  globalThis.LSTSubtitleSync = Object.freeze({
    MATCH_TIER,
    MIN_LOOSE_TEXT_LENGTH,
    TIME_TIE_EPSILON_SECONDS,
    TRACK_RELATIONSHIP,
    adoptTrackDocument,
    cueDistanceSeconds,
    cueIdentityKey,
    cueTimingKey,
    foldSubtitleText,
    isInterCueGapMatch,
    matchTier,
    resolveCue,
    resolveTrackDocument,
    simplifySubtitleText,
  });
})();
