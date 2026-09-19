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
// The rules live here now, stated once as named levels and decided on the cue
// timeline rather than on index arithmetic:
//
//   * a candidate is judged by the silence between it and its nearest requested
//     line, not by how many indexes away it is;
//   * a cue that ends before its nearest requested line is "before", one that
//     starts after it is "after", and one that overlaps it is "overlapping";
//   * how much context a request carries is the viewer's choice, stated once in
//     the level table below, and every amount the interface shows — the select,
//     the sentence under it, the HUD's own line and the README — is read from
//     that table through describeLevelLabel(), describeLevelSummary(),
//     describeLimits() and contextLevelOptions(), so no page can state a number
//     this file does not implement;
//   * the character budgets that bound the work rather than the dialogue, and
//     the ceilings a stored level is clamped to, are declared here too, so a
//     hand-edited or future value cannot make one request grow without bound;
//   * every admission and every refusal carries a reason, and a question this
//     file cannot answer — a requested line with no timeline, a reference line
//     with no position — is reported as unanswered rather than guessed at.
//
// Which cues are being translated, and what makes two cues the same cue, stay
// with the caller: cue identity is owned elsewhere. This file is handed the
// indexes of the requested cues and decides only what surrounds them. Nothing
// here touches the network, the DOM, or browser storage.

(() => {
  // The whole budget, in one place, as one row per amount the viewer can choose.
  // Requested lines are answered by at most the declared number of reference
  // lines on each side, plus a couple that overlap a requested line (a second
  // line of the same subtitle, or a line the batch skipped because it was
  // cached), and silence longer than the declared gap is a scene break rather
  // than a pause in the dialogue, so context is not taken across it.
  //
  // maxItems is deliberately not written down: it is the sum of the three sides,
  // so a level can never promise more lines per request than it has places to
  // put them, and the number the interface shows cannot disagree with the
  // numbers that decide it.
  const CONTEXT_LEVEL_ROWS = Object.freeze([
    Object.freeze({
      id: "minimal",
      label: "Minimal",
      beforeCues: 1,
      afterCues: 1,
      overlappingCues: 1,
      maxGapSeconds: 5,
    }),
    Object.freeze({
      id: "standard",
      label: "Standard",
      beforeCues: 2,
      afterCues: 2,
      overlappingCues: 2,
      maxGapSeconds: 8,
    }),
    Object.freeze({
      id: "wide",
      label: "Wide",
      beforeCues: 4,
      afterCues: 4,
      overlappingCues: 2,
      maxGapSeconds: 12,
    }),
  ]);

  // What a request carries when the viewer has chosen nothing. It is the amounts
  // this feature shipped with, so an install that never opens the setting
  // translates exactly as it did before the choice existed.
  const CONTEXT_LEVEL_DEFAULT = "standard";

  // The widest a level may ask for. A stored value written by a newer version,
  // or edited by hand, is clamped to this rather than trusted.
  const CONTEXT_LEVEL_CEILING = Object.freeze({
    beforeCues: 8,
    afterCues: 8,
    overlappingCues: 4,
    maxGapSeconds: 30,
    maxItems: 20,
  });

  // What bounds the work rather than the dialogue: how long one reference line
  // may be, how much text the whole list may carry, how far a scan walks from a
  // requested cue before giving up, and how many refusals are reported
  // individually before they are counted instead. None of this is the viewer's
  // to choose; it exists so one request cannot grow without bound.
  const CONTEXT_ARCHITECTURE = Object.freeze({
    maxTextChars: 240,
    maxTotalChars: 1000,
    maxWalkSteps: 8,
    maxReportedRefusals: 5,
  });

  function clampCount(value, ceiling) {
    const count = Math.floor(Number(value));
    if (!Number.isFinite(count)) return null;
    return Math.max(0, Math.min(ceiling, count));
  }

  // A row, or anything that arrived claiming to be one, turned into the whole
  // budget a request is built under: the sides, the ceiling they add up to, and
  // the architecture that bounds the work. What a row does not state is taken
  // from the level it stands on, so a partial or hand-edited budget cannot end
  // up with no sides at all, and every amount it does state is clamped.
  function budgetFrom(row, base) {
    const source = row && typeof row === "object" ? row : {};
    const fallback = base && typeof base === "object" ? base : {};
    const declared = (field) => {
      const value = source[field];
      return value === undefined || value === null || value === "" ? fallback[field] : value;
    };
    const beforeCues = clampCount(declared("beforeCues"), CONTEXT_LEVEL_CEILING.beforeCues) ?? 0;
    const afterCues = clampCount(declared("afterCues"), CONTEXT_LEVEL_CEILING.afterCues) ?? 0;
    const overlappingCues =
      clampCount(declared("overlappingCues"), CONTEXT_LEVEL_CEILING.overlappingCues) ?? 0;
    const maxGapSeconds = Math.max(
      0,
      Math.min(CONTEXT_LEVEL_CEILING.maxGapSeconds, Number(declared("maxGapSeconds")) || 0),
    );
    const id = typeof source.id === "string" && source.id ? source.id : fallback.id;
    return Object.freeze({
      id: id || CONTEXT_LEVEL_DEFAULT,
      label:
        typeof source.label === "string" && source.label
          ? source.label
          : typeof fallback.label === "string"
            ? fallback.label
            : "",
      beforeCues,
      afterCues,
      overlappingCues,
      maxItems: Math.min(
        CONTEXT_LEVEL_CEILING.maxItems,
        Math.max(1, beforeCues + afterCues + overlappingCues),
      ),
      maxGapSeconds,
      ...CONTEXT_ARCHITECTURE,
    });
  }

  const CONTEXT_LEVELS = Object.freeze(CONTEXT_LEVEL_ROWS.map((row) => budgetFrom(row)));
  const CONTEXT_LEVEL_BY_ID = new Map(CONTEXT_LEVELS.map((level) => [level.id, level]));

  // The budget in force when nothing else is asked for, kept under its own name
  // because "the limits" is what the HUD and the event log speak of.
  const CONTEXT_LIMITS = CONTEXT_LEVEL_BY_ID.get(CONTEXT_LEVEL_DEFAULT);

  /**
   * The budget a stored setting names.
   *
   * A level id is looked up, an unknown or missing value falls back to the
   * default rather than to no context at all, and a budget that arrives as an
   * object is read as an amendment to the level it names — or to the default —
   * with every amount clamped to the ceilings above instead of trusted. Every
   * caller resolves the same way, so the content script and the background
   * cannot disagree about what the viewer chose.
   */
  function resolveBudget(value) {
    if (typeof value === "string") {
      return CONTEXT_LEVEL_BY_ID.get(value.trim().toLowerCase()) || CONTEXT_LIMITS;
    }
    if (value && typeof value === "object") {
      const named =
        typeof value.id === "string"
          ? CONTEXT_LEVEL_BY_ID.get(value.id.trim().toLowerCase())
          : null;
      return budgetFrom(value, named || CONTEXT_LIMITS);
    }
    return CONTEXT_LIMITS;
  }

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
        if (refused <= CONTEXT_ARCHITECTURE.maxReportedRefusals) decisions.push(entry);
      },
      count() {
        return refused;
      },
      summarize() {
        if (!summarized && refused > CONTEXT_ARCHITECTURE.maxReportedRefusals) {
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
   * empty track. `level` is the amount of context the viewer chose; an unknown
   * value falls back to the default level rather than to no context at all.
   */
  function selectContext({
    scope,
    targetIndexes,
    requestedCount,
    enabled = true,
    level,
  } = {}) {
    const budget = resolveBudget(level);
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
      limits: budget,
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
        while (cursor >= 0 && cursor < track.length && steps < budget.maxWalkSteps) {
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
          if (nearest.gap > budget.maxGapSeconds) {
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
      [CONTEXT_POSITION.before]: budget.beforeCues,
      [CONTEXT_POSITION.after]: budget.afterCues,
      [CONTEXT_POSITION.overlapping]: budget.overlappingCues,
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
    for (let round = 0; chosen.length < budget.maxItems; round += 1) {
      let added = 0;
      for (const targetIndex of order) {
        if (chosen.length >= budget.maxItems) break;
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
      const text = shortenText(full, budget.maxTextChars);
      if (text !== full) {
        report.include({
          decision: DECISION.truncated,
          reason: "line-too-long",
          index: candidate.index,
          length: full.length,
          limit: budget.maxTextChars,
        });
      }
      if (totalChars + text.length > budget.maxTotalChars) {
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
   *
   * `level` is the amount of context the viewer chose, so the boundary is the
   * one the request was built under rather than a fixed guess; an unknown value
   * falls back to the default level.
   */
  function sanitizeContextItems(items, level) {
    const budget = resolveBudget(level);
    const report = createReport();
    const finish = (reason, accepted = []) => ({
      reason,
      items: accepted,
      decisions: report.decisions,
      refused: report.summarize(),
      limits: budget,
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
      if (accepted.length >= budget.maxItems) {
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
      const text = shortenText(full, budget.maxTextChars);
      if (text !== full) {
        report.include({
          decision: DECISION.itemTruncated,
          reason: "line-too-long",
          index,
          length: full.length,
          limit: budget.maxTextChars,
        });
      }
      if (totalChars + text.length > budget.maxTotalChars) {
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
  function describeLimits(value) {
    const { beforeCues, afterCues, overlappingCues, maxItems, maxGapSeconds } =
      resolveBudget(value);
    return (
      `${beforeCues} line${beforeCues === 1 ? "" : "s"} before / ` +
      `${afterCues} after, ${overlappingCues} overlapping, ` +
      `${maxGapSeconds}s gaps, ${maxItems} max`
    );
  }

  // How a level is named in the control the viewer picks it with. The amount is
  // in the name, so a closed select still says what it is set to.
  function describeLevelLabel(value) {
    const budget = resolveBudget(value);
    const side =
      budget.beforeCues === budget.afterCues
        ? `${budget.beforeCues} source line${budget.beforeCues === 1 ? "" : "s"} each side`
        : `${budget.beforeCues} before / ${budget.afterCues} after`;
    return budget.label ? `${budget.label} — ${side}` : side;
  }

  // What a level means, said once, for the sentence under the control. The
  // numbers in it are the ones a request under that level is actually built
  // with, so the page cannot promise a rule this file does not implement.
  function describeLevelSummary(value) {
    const { beforeCues, afterCues, maxItems, maxGapSeconds } = resolveBudget(value);
    const sides =
      beforeCues === afterCues
        ? `up to ${beforeCues} nearby source line${beforeCues === 1 ? "" : "s"} before and after each new translation`
        : `up to ${beforeCues} nearby source lines before and ${afterCues} after each new translation`;
    return (
      `Sends ${sides}, at most ${maxItems} lines per request, to the selected provider. ` +
      `A reference line is never taken across a silence longer than ${maxGapSeconds} seconds, ` +
      `so a line from the previous scene is not offered as context.`
    );
  }

  // The choices themselves, in the order the interface offers them. Each one
  // carries its own name and sentence so a page never types an amount.
  function contextLevelOptions() {
    return CONTEXT_LEVELS.map((level) => ({
      id: level.id,
      label: describeLevelLabel(level.id),
      summary: describeLevelSummary(level.id),
      maxItems: level.maxItems,
    }));
  }

  const api = {
    CONTEXT_ARCHITECTURE,
    CONTEXT_LEVELS,
    CONTEXT_LEVEL_CEILING,
    CONTEXT_LEVEL_DEFAULT,
    CONTEXT_LIMITS,
    CONTEXT_POSITION,
    CONTEXT_REASON,
    DECISION,
    POSITION_ALIASES,
    REFUSAL_REASON,
    contextLevelOptions,
    cueSpan,
    describeLevelLabel,
    describeLevelSummary,
    describeLimits,
    gapSeconds,
    normalizeContextText,
    positionFor,
    resolveBudget,
    sanitizeContextItems,
    selectContext,
    shortenText,
  };

  globalThis.LSTTranslationContext = api;
  if (typeof module !== "undefined" && module?.exports) {
    module.exports = api;
  }
})();
