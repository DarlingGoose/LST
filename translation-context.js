// LST translation context.
//
// One owner for the judgment "which surrounding lines are sent to the provider
// as reference, and why".
//
// It used to be an index-distance window in content.js: a cue was sent as
// context when it sat within two *indexes* of a requested line, the list was
// cut at twelve with no record of what had been dropped, and a line was
// labelled "before", "between" or "after" by comparing indexes against the
// first and last requested cue. Index distance is not dialogue. With an
// 86-second silence before the requested line, the two lines from the earlier
// scene were still sent, because they were two cue indexes away. With the
// requested lines spread through a batch, the twelve-item cut starved the later
// ones — the line immediately preceding the fourth requested cue was dropped
// while four lines crowded around the first. "Between" meant between two
// indexes, so a line five minutes away from either was described as sitting
// between them, and so was a line that directly preceded a later cue. A
// 1200-character lyric was sent whole. The background trimmed the list a second
// time with its own slice, and an item that arrived without a position was
// handed to the model as the invented label "nearby". Nothing recorded why
// context was empty.
//
// The rules live here now, stated once in named limits and decided on the cue
// timeline rather than on index arithmetic:
//
//   * a candidate is judged by the silence between it and its nearest requested
//     line, not by how many indexes away it is;
//   * a cue that ends before its nearest requested line is "before", one that
//     starts after it is "after", and one that overlaps it is "overlapping";
//   * the counts, the gap and the character budgets are declared in
//     CONTEXT_LIMITS, which the options page, the HUD and the README read
//     through describeLimits(), so the interface cannot describe a rule this
//     file does not implement;
//   * every admission and every refusal carries a reason, and a question this
//     file cannot answer — a requested line with no timeline, a reference line
//     with no position — is reported as unanswered rather than guessed at.
//
// Which cues are being translated, and what makes two cues the same cue, stay
// with the caller: cue identity is owned elsewhere. This file is handed the
// indexes of the requested cues and decides only what surrounds them. Nothing
// here touches the network, the DOM, or browser storage.

(() => {
  // The whole budget, in one place. describeLimits() renders these numbers for
  // the interface, and the test suite compares the interface text against them,
  // so a rule cannot change here without the description changing with it.
  const CONTEXT_LIMITS = Object.freeze({
    // Requested lines are answered by at most this many reference lines on each
    // side, plus a couple that overlap a requested line (a second line of the
    // same subtitle, or a line the batch skipped because it was cached).
    beforeCues: 2,
    afterCues: 2,
    overlappingCues: 2,
    // Hard ceiling for the whole list, whoever built it.
    maxItems: 6,
    // Silence longer than this is a scene break, not a pause in the dialogue,
    // so context is not taken across it.
    maxGapSeconds: 8,
    // A reference line is shortened to this before it is sent, and the list as
    // a whole is kept under the total so a request cannot grow without bound.
    maxTextChars: 240,
    maxTotalChars: 1000,
    // How far the scan walks from a requested cue before giving up. The gap
    // rule decides what is context; this only bounds the work per request.
    maxWalkSteps: 8,
    // Individual refusals kept in the report before they are counted instead.
    maxReportedRefusals: 5,
  });

  // Where a reference line sits relative to the requested line nearest to it.
  const CONTEXT_POSITION = Object.freeze({
    before: "before",
    overlapping: "overlapping",
    after: "after",
  });

  // Older builds called an overlapping line "between". Renaming it keeps the
  // context of a tab that is still running the previous content script, and the
  // rename is reported rather than applied silently.
  const POSITION_ALIASES = Object.freeze([
    { alias: "between", position: CONTEXT_POSITION.overlapping },
  ]);

  // Why a request carries the context it carries.
  const CONTEXT_REASON = Object.freeze({
    ok: "ok",
    disabled: "context-disabled",
    noTrackCues: "no-track-cues",
    noTargetCues: "no-target-cues",
    targetsNotInTrack: "targets-not-in-track",
    targetTimeUnknown: "target-time-unknown",
    noAdjacentCues: "no-adjacent-cues",
    gapTooLarge: "context-gap-too-large",
    budgetExceeded: "context-budget-exceeded",
    itemsInvalid: "context-items-invalid",
    nothingSent: "no-context-sent",
    allRejected: "context-items-rejected",
    unavailable: "translation-context-unavailable",
  });

  const DECISION = Object.freeze({
    skipped: "context-skipped",
    refused: "context-cue-refused",
    truncated: "context-text-truncated",
    included: "context-cue-included",
    summarized: "context-refusals-summarized",
    alias: "context-position-renamed",
    itemRefused: "context-item-refused",
    itemTruncated: "context-item-truncated",
    unavailable: "context-items-unavailable",
  });

  // Refusal reasons, so a dropped line can be traced to the rule that dropped
  // it without recording a word of the subtitle.
  const REFUSAL_REASON = Object.freeze({
    gapTooLarge: "gap-too-large",
    sideBudgetExceeded: "side-budget-exceeded",
    itemBudgetExceeded: "max-items-exceeded",
    totalBudgetExceeded: "total-budget-exceeded",
    noTimeline: "no-timeline",
    textEmpty: "text-empty",
    targetIndexInvalid: "target-index-invalid",
    notAnObject: "not-an-object",
    positionMissing: "position-missing",
    positionUnknown: "position-unknown",
    notAnArray: "not-an-array",
  });

  function toPosition(value) {
    const text = String(value ?? "").trim().toLowerCase();
    if (!text) return { position: "", reason: REFUSAL_REASON.positionMissing };
    if (Object.prototype.hasOwnProperty.call(CONTEXT_POSITION, text)) {
      return { position: text, reason: "", renamed: false };
    }
    const alias = POSITION_ALIASES.find((entry) => entry.alias === text);
    if (alias) return { position: alias.position, reason: "", renamed: true, alias: alias.alias };
    return { position: "", reason: REFUSAL_REASON.positionUnknown };
  }

  function normalizeContextText(value) {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Shorten at a word boundary when there is one, so a reference line is not
  // cut mid-word unless the line has no spaces at all.
  function shortenText(text, maxChars) {
    if (text.length <= maxChars) return text;
    const cut = text.slice(0, Math.max(1, maxChars - 1));
    const space = cut.lastIndexOf(" ");
    const body = space > cut.length * 0.6 ? cut.slice(0, space) : cut;
    return `${body.trimEnd()}…`;
  }

  // A cue's timeline, or null when it has none. A cue captured from the
  // rendered line rather than from a timed-text track has no times, and a
  // timeline that is missing cannot be measured.
  function cueSpan(cue) {
    if (!cue || typeof cue !== "object") return null;
    const start = Number(cue.start);
    const end = Number(cue.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (start < 0 || end < 0) return null;
    return { start, end: Math.max(start, end) };
  }

  // Seconds of silence between a candidate and one requested line. Overlapping
  // spans are zero apart: they are the same moment.
  function gapSeconds(span, target) {
    if (span.end <= target.start) return target.start - span.end;
    if (span.start >= target.end) return span.start - target.end;
    return 0;
  }

  function nearestTarget(span, targetSpans) {
    let best = null;
    for (const entry of targetSpans) {
      const gap = gapSeconds(span, entry.span);
      if (
        !best ||
        gap < best.gap ||
        (gap === best.gap && entry.index < best.entry.index)
      ) {
        best = { gap, entry };
      }
    }
    return best;
  }

  function positionFor(span, targetSpan) {
    if (span.end <= targetSpan.start) return CONTEXT_POSITION.before;
    if (span.start >= targetSpan.end) return CONTEXT_POSITION.after;
    return CONTEXT_POSITION.overlapping;
  }

  // A bounded, deterministic report: individual refusals up to a limit, then a
  // count, so a 5000-cue track cannot turn one request into a wall of events.
  function createReport() {
    const decisions = [];
    let refused = 0;
    let summarized = false;
    return {
      decisions,
      include(entry) {
        decisions.push(entry);
      },
      refuse(entry) {
        refused += 1;
        if (refused <= CONTEXT_LIMITS.maxReportedRefusals) decisions.push(entry);
      },
      count() {
        return refused;
      },
      summarize() {
        if (!summarized && refused > CONTEXT_LIMITS.maxReportedRefusals) {
          summarized = true;
          decisions.push({
            decision: DECISION.summarized,
            reason: "refusal-log-bounded",
            refused,
          });
        }
        return refused;
      },
    };
  }

  /**
   * Choose the reference lines for one request.
   *
   * `scope` is the track in playback order, `targetIndexes` are the positions of
   * the cues being translated as the caller's own cue identity found them, and
   * `requestedCount` is how many cues were asked for, so that a request whose
   * cues are not in the track can be reported as exactly that instead of as an
   * empty track.
   */
  function selectContext({ scope, targetIndexes, requestedCount, enabled = true } = {}) {
    const report = createReport();
    // How many cues the caller asked for. It is passed in so that a request
    // whose cues are not in the track can be told apart from a request that
    // asked for nothing at all, and it falls back to the indexes handed over.
    const requested = Number.isFinite(Number(requestedCount))
      ? Number(requestedCount)
      : (Array.isArray(targetIndexes) ? targetIndexes.length : 0);
    const finish = (reason, items = [], extra = {}) => ({
      reason,
      items,
      decisions: report.decisions,
      refused: report.summarize(),
      limits: CONTEXT_LIMITS,
      requested,
      targets: 0,
      candidates: 0,
      chars: 0,
      positions: { before: 0, after: 0, overlapping: 0 },
      ...extra,
    });

    if (!enabled) {
      report.include({ decision: DECISION.skipped, reason: CONTEXT_REASON.disabled });
      return finish(CONTEXT_REASON.disabled);
    }

    const track = Array.isArray(scope) ? scope : [];
    if (!track.length) {
      report.include({ decision: DECISION.skipped, reason: CONTEXT_REASON.noTrackCues });
      return finish(CONTEXT_REASON.noTrackCues);
    }

    if (!requested) {
      report.include({ decision: DECISION.skipped, reason: CONTEXT_REASON.noTargetCues });
      return finish(CONTEXT_REASON.noTargetCues);
    }

    // Timelines are read only where they are needed. A request asks about a
    // handful of cues, and reading the whole track for each of them would make
    // every playback tick pay for the episode's length.
    const spanCache = new Map();
    const spanAt = (index) => {
      if (!spanCache.has(index)) spanCache.set(index, cueSpan(track[index]));
      return spanCache.get(index);
    };

    const targetSpans = [];
    const targetSet = new Set();
    // How many requested cues were found in the track at all, which is a
    // different question from how many of them can be measured against a clock.
    let found = 0;
    for (const value of Array.isArray(targetIndexes) ? targetIndexes : []) {
      if (!Number.isInteger(value) || value < 0 || value >= track.length) {
        report.refuse({
          decision: DECISION.refused,
          reason: REFUSAL_REASON.targetIndexInvalid,
          index: Number.isFinite(Number(value)) ? Number(value) : -1,
        });
        continue;
      }
      if (targetSet.has(value)) continue;
      found += 1;
      const span = spanAt(value);
      if (!span) {
        report.refuse({
          decision: DECISION.refused,
          reason: REFUSAL_REASON.noTimeline,
          index: value,
          role: "target",
        });
        continue;
      }
      targetSet.add(value);
      targetSpans.push({ index: value, span });
    }

    if (!found) {
      report.include({
        decision: DECISION.skipped,
        reason: CONTEXT_REASON.targetsNotInTrack,
        requested,
      });
      return finish(CONTEXT_REASON.targetsNotInTrack);
    }

    if (!targetSpans.length) {
      // Every requested cue was found but none of them has a timeline, so there
      // is no clock to measure silence against. Guessing from indexes here is
      // exactly what used to send a line from another scene as context.
      report.include({
        decision: DECISION.skipped,
        reason: CONTEXT_REASON.targetTimeUnknown,
        targets: found,
      });
      return finish(CONTEXT_REASON.targetTimeUnknown);
    }

    // Walk out from every requested cue, both ways, stopping as soon as the
    // next line is more than the declared gap away from the nearest requested
    // line. Cue order is time order, so everything past that stop is farther
    // still.
    // The same line can be the neighbour of two requested lines, and both walks
    // reach it. It is kept once, counted against the requested line it is
    // actually nearest to, and a refusal is recorded once.
    const candidates = new Map();
    const refusedKeys = new Set();
    let gapRefusals = 0;
    const refuse = (entry) => {
      if (entry.reason === REFUSAL_REASON.gapTooLarge) gapRefusals += 1;
      const key = `${entry.index}:${entry.reason}`;
      if (refusedKeys.has(key)) return false;
      refusedKeys.add(key);
      return report.refuse(entry);
    };

    for (const target of targetSpans) {
      for (const step of [-1, 1]) {
        let cursor = target.index + step;
        let steps = 0;
        while (cursor >= 0 && cursor < track.length && steps < CONTEXT_LIMITS.maxWalkSteps) {
          steps += 1;
          if (targetSet.has(cursor)) {
            cursor += step;
            continue;
          }
          const span = spanAt(cursor);
          if (!span) {
            refuse({
              decision: DECISION.refused,
              reason: REFUSAL_REASON.noTimeline,
              index: cursor,
            });
            break;
          }
          const nearest = nearestTarget(span, targetSpans);
          const gapMs = Math.round(nearest.gap * 1000);
          if (nearest.gap > CONTEXT_LIMITS.maxGapSeconds) {
            refuse({
              decision: DECISION.refused,
              reason: REFUSAL_REASON.gapTooLarge,
              index: cursor,
              gapMs,
            });
            break;
          }
          if (!candidates.has(cursor)) {
            candidates.set(cursor, {
              index: cursor,
              span,
              position: positionFor(span, nearest.entry.span),
              gapMs,
              targetIndex: nearest.entry.index,
            });
          }
          cursor += step;
        }
      }
    }

    const sideBudget = {
      [CONTEXT_POSITION.before]: CONTEXT_LIMITS.beforeCues,
      [CONTEXT_POSITION.after]: CONTEXT_LIMITS.afterCues,
      [CONTEXT_POSITION.overlapping]: CONTEXT_LIMITS.overlappingCues,
    };

    // Rank every requested line's own reference lines by how close they are, and
    // keep at most the declared number on each side of it.
    const queues = new Map();
    for (const candidate of [...candidates.values()].sort((left, right) => left.index - right.index)) {
      if (!queues.has(candidate.targetIndex)) queues.set(candidate.targetIndex, []);
      queues.get(candidate.targetIndex).push(candidate);
    }
    for (const [targetIndex, list] of queues) {
      const counts = { before: 0, after: 0, overlapping: 0 };
      const queue = [];
      const ranked = [...list].sort(
        (left, right) => left.gapMs - right.gapMs || left.index - right.index,
      );
      for (const candidate of ranked) {
        if (counts[candidate.position] < sideBudget[candidate.position]) {
          counts[candidate.position] += 1;
          queue.push(candidate);
        } else {
          refuse({
            decision: DECISION.refused,
            reason: REFUSAL_REASON.sideBudgetExceeded,
            index: candidate.index,
            position: candidate.position,
            gapMs: candidate.gapMs,
          });
        }
      }
      queues.set(targetIndex, queue);
    }

    // Share the ceiling between the requested lines instead of spending it in
    // index order: every requested line is given its nearest reference line
    // before any of them is given a second one. Spending it in index order is
    // how the last lines of a wide batch used to lose their context with nothing
    // recorded to say so.
    const order = [...queues.keys()].sort((left, right) => left - right);
    const chosen = [];
    const chosenIndexes = new Set();
    for (let round = 0; chosen.length < CONTEXT_LIMITS.maxItems; round += 1) {
      let added = 0;
      for (const targetIndex of order) {
        if (chosen.length >= CONTEXT_LIMITS.maxItems) break;
        const queue = queues.get(targetIndex);
        if (round >= queue.length) continue;
        chosen.push(queue[round]);
        chosenIndexes.add(queue[round].index);
        added += 1;
      }
      if (!added) break;
    }
    for (const targetIndex of order) {
      for (const candidate of queues.get(targetIndex)) {
        if (chosenIndexes.has(candidate.index)) continue;
        refuse({
          decision: DECISION.refused,
          reason: REFUSAL_REASON.itemBudgetExceeded,
          index: candidate.index,
          gapMs: candidate.gapMs,
        });
      }
    }

    // Sent in playback order, so a model reading the list sees the scene in the
    // order the viewer will.
    const ordered = [...chosen].sort(
      (left, right) =>
        left.span.start - right.span.start ||
        left.span.end - right.span.end ||
        left.index - right.index,
    );

    const items = [];
    const positions = { before: 0, after: 0, overlapping: 0 };
    let totalChars = 0;
    for (const candidate of ordered) {
      const full = normalizeContextText(track[candidate.index]?.text);
      if (!full) {
        report.refuse({
          decision: DECISION.refused,
          reason: REFUSAL_REASON.textEmpty,
          index: candidate.index,
        });
        continue;
      }
      const text = shortenText(full, CONTEXT_LIMITS.maxTextChars);
      if (text !== full) {
        report.include({
          decision: DECISION.truncated,
          reason: "line-too-long",
          index: candidate.index,
          length: full.length,
          limit: CONTEXT_LIMITS.maxTextChars,
        });
      }
      if (totalChars + text.length > CONTEXT_LIMITS.maxTotalChars) {
        report.refuse({
          decision: DECISION.refused,
          reason: REFUSAL_REASON.totalBudgetExceeded,
          index: candidate.index,
          length: text.length,
        });
        continue;
      }
      totalChars += text.length;
      positions[candidate.position] += 1;
      report.include({
        decision: DECISION.included,
        reason: candidate.position,
        index: candidate.index,
        gapMs: candidate.gapMs,
      });
      items.push({
        position: candidate.position,
        startMs: Math.round(candidate.span.start * 1000),
        text,
      });
    }

    let reason = CONTEXT_REASON.ok;
    if (!items.length) {
      if (candidates.size) {
        // Every collected candidate had a timeline and was inside the gap, so
        // what kept them out was the budget rather than the distance.
        reason = CONTEXT_REASON.budgetExceeded;
      } else if (gapRefusals) {
        // The neighbouring cues existed but every one of them was across a
        // silence longer than the declared gap.
        reason = CONTEXT_REASON.gapTooLarge;
      } else {
        reason = CONTEXT_REASON.noAdjacentCues;
      }
    }

    return finish(reason, items, {
      targets: targetSpans.length,
      candidates: candidates.size,
      positions,
      chars: totalChars,
    });
  }

  /**
   * The boundary for context that arrives in a message.
   *
   * The background is handed items it did not build, so it validates rather than
   * trusts them: a line with no position, an empty line, and a line past the
   * budget are refused with a reason instead of being relabelled "nearby" or
   * sent whole. Running this over items that already came from selectContext
   * changes nothing, so the boundary can be applied twice.
   */
  function sanitizeContextItems(items) {
    const report = createReport();
    const finish = (reason, accepted = []) => ({
      reason,
      items: accepted,
      decisions: report.decisions,
      refused: report.summarize(),
      limits: CONTEXT_LIMITS,
    });

    if (items === undefined || items === null) {
      return finish(CONTEXT_REASON.nothingSent);
    }
    if (!Array.isArray(items)) {
      report.refuse({
        decision: DECISION.itemRefused,
        reason: REFUSAL_REASON.notAnArray,
        index: -1,
      });
      return finish(CONTEXT_REASON.itemsInvalid);
    }
    if (!items.length) return finish(CONTEXT_REASON.nothingSent);

    const accepted = [];
    let totalChars = 0;
    items.forEach((item, index) => {
      if (!item || typeof item !== "object") {
        report.refuse({
          decision: DECISION.itemRefused,
          reason: REFUSAL_REASON.notAnObject,
          index,
        });
        return;
      }
      if (accepted.length >= CONTEXT_LIMITS.maxItems) {
        report.refuse({
          decision: DECISION.itemRefused,
          reason: REFUSAL_REASON.itemBudgetExceeded,
          index,
        });
        return;
      }
      const verdict = toPosition(item.position);
      if (!verdict.position) {
        report.refuse({
          decision: DECISION.itemRefused,
          reason: verdict.reason,
          index,
        });
        return;
      }
      if (verdict.renamed) {
        report.include({
          decision: DECISION.alias,
          reason: "position-renamed",
          index,
          from: verdict.alias,
          to: verdict.position,
        });
      }
      const full = normalizeContextText(item.text);
      if (!full) {
        report.refuse({
          decision: DECISION.itemRefused,
          reason: REFUSAL_REASON.textEmpty,
          index,
        });
        return;
      }
      const text = shortenText(full, CONTEXT_LIMITS.maxTextChars);
      if (text !== full) {
        report.include({
          decision: DECISION.itemTruncated,
          reason: "line-too-long",
          index,
          length: full.length,
          limit: CONTEXT_LIMITS.maxTextChars,
        });
      }
      if (totalChars + text.length > CONTEXT_LIMITS.maxTotalChars) {
        report.refuse({
          decision: DECISION.itemRefused,
          reason: REFUSAL_REASON.totalBudgetExceeded,
          index,
          length: text.length,
        });
        return;
      }
      totalChars += text.length;
      // A missing start is unknown, not the epoch: Number(null) is 0, so the
      // value is checked before it is converted.
      const rawStart = item.startMs;
      const startMs =
        rawStart === null || rawStart === undefined || rawStart === ""
          ? null
          : Number(rawStart);
      accepted.push({
        position: verdict.position,
        startMs: Number.isFinite(startMs) ? startMs : null,
        text,
      });
    });

    let reason = CONTEXT_REASON.ok;
    if (!accepted.length) {
      reason = report.count() ? CONTEXT_REASON.allRejected : CONTEXT_REASON.nothingSent;
    }
    return finish(reason, accepted);
  }

  // The interface describes the rule by asking for it, so the options page, the
  // HUD and the README cannot drift from what selectContext actually does.
  function describeLimits() {
    const { beforeCues, afterCues, overlappingCues, maxItems, maxGapSeconds } =
      CONTEXT_LIMITS;
    return (
      `${beforeCues} line${beforeCues === 1 ? "" : "s"} before / ` +
      `${afterCues} after, ${overlappingCues} overlapping, ` +
      `${maxGapSeconds}s gaps, ${maxItems} max`
    );
  }

  const api = {
    CONTEXT_LIMITS,
    CONTEXT_POSITION,
    CONTEXT_REASON,
    DECISION,
    POSITION_ALIASES,
    REFUSAL_REASON,
    cueSpan,
    describeLimits,
    gapSeconds,
    normalizeContextText,
    positionFor,
    sanitizeContextItems,
    selectContext,
    shortenText,
  };

  globalThis.LSTTranslationContext = api;
  if (typeof module !== "undefined" && module?.exports) {
    module.exports = api;
  }
})();
