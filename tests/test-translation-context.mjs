import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { repositoryPath } from "./helpers/repository-path.mjs";

const read = (name) => fs.readFile(new URL(repositoryPath(name), import.meta.url), "utf8");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Layer 1 — the context module on its own.

const contextSource = await read("translation-context.js");
const context = vm.createContext({});
vm.runInContext(contextSource, context, { filename: "translation-context.js" });
const translateContext = context.LSTTranslationContext;

const {
  CONTEXT_LIMITS,
  CONTEXT_LEVELS,
  CONTEXT_LEVEL_CEILING,
  CONTEXT_LEVEL_DEFAULT,
  CONTEXT_POSITION,
  CONTEXT_REASON,
  REFUSAL_REASON,
} = translateContext;

assert.equal(CONTEXT_LIMITS.beforeCues, 2);
assert.equal(CONTEXT_LIMITS.afterCues, 2);
assert.equal(CONTEXT_LIMITS.maxGapSeconds, 8);
assert.ok(CONTEXT_LIMITS.maxItems >= 4, "the ceiling must fit both sides");

// The description the interface reads is built from the limits themselves, so a
// changed rule cannot leave the options page describing the old one.
assert.match(translateContext.describeLimits(), /2 lines before \/ 2 after/);
assert.match(translateContext.describeLimits(), /8s gaps/);
assert.match(translateContext.describeLimits(), /6 max/);

const cue = (start, end, text) => ({ start, end, text });
// Module results live in another realm, so they are normalised before they are
// compared with the objects this file builds.
const plain = (value) => JSON.parse(JSON.stringify(value));
const host = (values) => Array.from(values);

// How much context a request carries is the viewer's choice, stated once as
// levels. The default is the amount this feature shipped with, so an install
// that never opens the setting translates exactly as it did.
assert.equal(CONTEXT_LEVEL_DEFAULT, "standard");
assert.equal(CONTEXT_LIMITS, translateContext.resolveBudget(CONTEXT_LEVEL_DEFAULT));
assert.ok(CONTEXT_LEVELS.length >= 2, "there must be an amount to choose between");
assert.deepEqual(
  host(CONTEXT_LEVELS.map((level) => level.id)),
  [...new Set(host(CONTEXT_LEVELS.map((level) => level.id)))],
  "level ids are unique",
);

for (const level of CONTEXT_LEVELS) {
  assert.ok(level.label, `level ${level.id} needs a name for the control`);
  assert.equal(
    level.maxItems,
    level.beforeCues + level.afterCues + level.overlappingCues,
    `level ${level.id} promises a number of lines per request it cannot fill`,
  );
  assert.equal(
    level.beforeCues,
    level.afterCues,
    `level ${level.id} must not favour one side of the line being translated`,
  );
  assert.ok(
    level.maxGapSeconds > 0 && level.maxGapSeconds <= CONTEXT_LEVEL_CEILING.maxGapSeconds,
    `level ${level.id} declares a silence outside the ceiling`,
  );
  for (const field of ["beforeCues", "afterCues", "overlappingCues"]) {
    assert.ok(
      level[field] <= CONTEXT_LEVEL_CEILING[field],
      `level ${level.id} asks for more ${field} than the ceiling allows`,
    );
  }
}

// A wider level is wider in every direction, so the order the interface offers
// the amounts in is the order of the amounts themselves.
for (let index = 1; index < CONTEXT_LEVELS.length; index += 1) {
  const previous = CONTEXT_LEVELS[index - 1];
  const level = CONTEXT_LEVELS[index];
  assert.ok(level.beforeCues > previous.beforeCues, `${level.id} must send more lines before`);
  assert.ok(level.afterCues > previous.afterCues, `${level.id} must send more lines after`);
  assert.ok(level.maxItems > previous.maxItems, `${level.id} must allow more lines per request`);
  assert.ok(level.maxGapSeconds > previous.maxGapSeconds, `${level.id} must reach further`);
}

// An unknown amount, or one a future build wrote, resolves to the amount LST
// would actually use rather than to no context at all or to an unbounded one.
assert.equal(translateContext.resolveBudget().id, CONTEXT_LEVEL_DEFAULT);
assert.equal(translateContext.resolveBudget("").id, CONTEXT_LEVEL_DEFAULT);
assert.equal(translateContext.resolveBudget("nonsense").id, CONTEXT_LEVEL_DEFAULT);
assert.equal(
  translateContext.resolveBudget(" WIDE ").id,
  "wide",
  "a stored amount is matched, not mistyped",
);
assert.equal(
  translateContext.resolveBudget({ beforeCues: 999 }).beforeCues,
  CONTEXT_LEVEL_CEILING.beforeCues,
  "a hand-edited budget is clamped rather than trusted",
);
assert.equal(
  translateContext.resolveBudget({ id: "wide" }).maxItems,
  translateContext.resolveBudget("wide").maxItems,
  "a budget that names a level and states nothing else is that level",
);
assert.equal(
  translateContext.resolveBudget({ id: "minimal", beforeCues: 2 }).beforeCues,
  2,
  "a budget is read as an amendment to the level it names",
);

// The control and the sentence under it are built from the levels, so no page
// types an amount of its own.
assert.deepEqual(
  host(translateContext.contextLevelOptions().map((choice) => choice.id)),
  host(CONTEXT_LEVELS.map((level) => level.id)),
  "every level is offered, in the order they are declared",
);
for (const level of CONTEXT_LEVELS) {
  assert.match(
    translateContext.describeLevelLabel(level.id),
    new RegExp(`${level.beforeCues} source line`),
    `the control for ${level.id} must name its amount`,
  );
  const summary = translateContext.describeLevelSummary(level.id);
  assert.match(summary, new RegExp(`at most ${level.maxItems} lines per request`));
  assert.match(summary, new RegExp(`longer than ${level.maxGapSeconds} seconds`));
}

// The amount chosen is the amount used: the same track under a small level and a
// wide one does not carry the same lines.
{
  const ladder = [
    cue(0, 1, "one"),
    cue(2, 3, "two"),
    cue(4, 5, "target"),
    cue(6, 7, "three"),
    cue(8, 9, "four"),
  ];
  const under = (level) =>
    plain(
      translateContext.selectContext({
        scope: ladder,
        targetIndexes: [2],
        requestedCount: 1,
        level,
      }).items,
    ).map((item) => item.text);
  assert.deepEqual(under("minimal"), ["two", "three"]);
  assert.deepEqual(under("wide"), ["one", "two", "three", "four"]);
  assert.deepEqual(under(undefined), under(CONTEXT_LEVEL_DEFAULT), "an unstated amount is the default");
  assert.equal(
    plain(
      translateContext.selectContext({
        scope: ladder,
        targetIndexes: [2],
        requestedCount: 1,
        level: "wide",
      }).limits.id,
    ),
    "wide",
    "the report says which amount the choice was made under",
  );
}

assert.deepEqual(plain(translateContext.cueSpan(cue(1, 2, "x"))), { start: 1, end: 2 });
assert.equal(translateContext.cueSpan(cue(-1, -1, "rendered")), null, "a rendered line has no timeline");
assert.deepEqual(
  plain(translateContext.cueSpan(cue(5, 1, "backwards"))),
  { start: 5, end: 5 },
  "a backwards span is closed rather than trusted",
);
assert.equal(translateContext.cueSpan(null), null);

assert.equal(translateContext.gapSeconds(cue(0, 2, ""), { start: 5, end: 6 }), 3);
assert.equal(translateContext.gapSeconds(cue(10, 12, ""), { start: 5, end: 6 }), 4);
assert.equal(translateContext.gapSeconds(cue(5, 7, ""), { start: 5, end: 6 }), 0, "overlap is the same moment");
assert.equal(translateContext.positionFor(cue(0, 2, ""), { start: 5, end: 6 }), CONTEXT_POSITION.before);
assert.equal(translateContext.positionFor(cue(9, 11, ""), { start: 5, end: 6 }), CONTEXT_POSITION.after);
assert.equal(translateContext.positionFor(cue(5, 7, ""), { start: 5, end: 6 }), CONTEXT_POSITION.overlapping);

const select = (scope, targetIndexes, requestedCount = targetIndexes.length, enabled = true) =>
  translateContext.selectContext({ scope, targetIndexes, requestedCount, enabled });

// A silence longer than the declared gap is a scene break. The pre-refactor
// window sent the two lines from the earlier scene because they were two cue
// indexes away; those lines are 86 seconds of story away from the request.
const crossing = [
  cue(0, 2, "We should go back."),
  cue(2, 4, "The road is closed."),
  cue(4, 6, "Then we walk."),
  cue(90, 92, "Is anyone there?"),
  cue(92, 94, "Answer me."),
  cue(94, 96, "Please."),
];
{
  const selection = select(crossing, [3]);
  assert.equal(selection.reason, CONTEXT_REASON.ok);
  assert.deepEqual(
    host(selection.items.map((item) => item.startMs)),
    [92000, 94000],
  );
  assert.ok(
    selection.items.every((item) => item.position === CONTEXT_POSITION.after),
    "the lines after the request are the ones that belong to it",
  );
  assert.ok(
    !selection.items.some((item) => item.startMs < 80000),
    "nothing from across the silence is sent",
  );
  const refused = selection.decisions.filter(
    (decision) =>
      decision.decision === "context-cue-refused" &&
      decision.reason === REFUSAL_REASON.gapTooLarge,
  );
  assert.equal(refused.length, 1, "the line across the silence is reported once");
  assert.ok(refused[0].gapMs >= 80000 - 6000 - 4000);
  assert.equal(selection.refused, 1);
}

// The gap rule is the declared number, not a nearby one.
{
  const atLimit = [cue(0, 2, "earlier"), cue(2 + CONTEXT_LIMITS.maxGapSeconds, 4 + CONTEXT_LIMITS.maxGapSeconds, "target")];
  const atLimitSelection = select(atLimit, [1]);
  assert.equal(atLimitSelection.items.length, 1, "silence of exactly the gap is still context");

  const overLimit = [
    cue(0, 2, "earlier"),
    cue(2.5 + CONTEXT_LIMITS.maxGapSeconds, 4.5 + CONTEXT_LIMITS.maxGapSeconds, "target"),
  ];
  const overLimitSelection = select(overLimit, [1]);
  assert.equal(overLimitSelection.items.length, 0);
  assert.equal(overLimitSelection.reason, CONTEXT_REASON.gapTooLarge);
}

// A line that overlaps the request is context for the same moment, and says so.
{
  const overlapping = [
    cue(0, 2, "earlier"),
    cue(10, 12, "requested"),
    cue(10.5, 12, "the other half of the same subtitle"),
    cue(12, 14, "later"),
  ];
  const selection = select(overlapping, [1]);
  assert.deepEqual(
    host(selection.items.map((item) => item.position)),
    [CONTEXT_POSITION.before, CONTEXT_POSITION.overlapping, CONTEXT_POSITION.after],
  );
  assert.equal(selection.positions.overlapping, 1);
}

// Index distance is not dialogue: a line two indexes away across a silence is
// not context, and neither is a line five minutes away.
{
  const hole = [
    cue(0, 2, "Start of the scene."),
    cue(2, 4, "A"),
    cue(300, 302, "ten minutes later, unrelated"),
    cue(598, 600, "B"),
    cue(600, 602, "End of the scene."),
  ];
  const selection = select(hole, [0, 3]);
  assert.deepEqual(
    host(selection.items.map((item) => item.startMs)),
    [2000, 600000],
  );
  assert.ok(
    !selection.items.some((item) => item.text.includes("unrelated")),
    "the line in the middle of the silence is not context",
  );
}

// The ceiling is shared between the requested lines. Spending it in index order
// is how the last lines of a wide batch lost their context before.
{
  const wide = [];
  for (let index = 0; index < 30; index += 1) {
    wide.push(cue(index * 2, index * 2 + 2, `line ${index}`));
  }
  const targets = [0, 12, 20, 28];
  const selection = select(wide, targets);
  assert.equal(selection.items.length, CONTEXT_LIMITS.maxItems);
  const served = new Set(
    selection.items.map((item) => {
      let best = null;
      for (const targetIndex of targets) {
        const gap = Math.abs(wide[targetIndex].start * 1000 - item.startMs);
        if (!best || gap < best.gap) best = { gap, targetIndex };
      }
      return best.targetIndex;
    }),
  );
  assert.deepEqual(
    [...served].sort((left, right) => left - right),
    targets,
    "every requested line gets a reference line before any gets a second",
  );
  assert.ok(selection.refused > 0, "the lines that did not fit are counted");
  assert.ok(
    selection.decisions.some((decision) => decision.decision === "context-refusals-summarized"),
    "the refusal log is bounded rather than unbounded",
  );
}

// A requested line keeps at most the declared number of lines on each side.
{
  const many = [];
  for (let index = 0; index < 8; index += 1) many.push(cue(index, index + 1, `line ${index}`));
  const selection = select(many, [4]);
  assert.equal(
    selection.items.filter((item) => item.position === CONTEXT_POSITION.before).length,
    CONTEXT_LIMITS.beforeCues,
  );
  assert.equal(
    selection.items.filter((item) => item.position === CONTEXT_POSITION.after).length,
    CONTEXT_LIMITS.afterCues,
  );
  assert.ok(
    selection.decisions.some(
      (decision) =>
        decision.decision === "context-cue-refused" &&
        decision.reason === REFUSAL_REASON.sideBudgetExceeded,
    ),
    "a line dropped for the per-side budget is reported with its reason",
  );
}

// A long reference line is shortened before it is sent, and the shortening is
// reported with the length it had.
{
  const long = [cue(0, 4, "x".repeat(1200)), cue(4, 6, "requested")];
  const selection = select(long, [1]);
  assert.equal(selection.items.length, 1);
  assert.ok(selection.items[0].text.length <= CONTEXT_LIMITS.maxTextChars);
  const truncated = selection.decisions.find(
    (decision) => decision.decision === "context-text-truncated",
  );
  assert.ok(truncated, "shortening a line is recorded");
  assert.equal(truncated.reason, "line-too-long");
  assert.equal(truncated.length, 1200);
}

// The whole list stays inside the total character budget, and a line that does
// not fit is reported rather than dropped in silence.
{
  const crowded = [
    cue(14, 16, "b".repeat(300)),
    cue(16, 18, "b".repeat(300)),
    cue(20, 30, "requested"),
    cue(20.5, 29.5, "b".repeat(300)),
    cue(21, 29, "b".repeat(300)),
    cue(30, 32, "b".repeat(300)),
    cue(32, 34, "b".repeat(300)),
  ];
  const selection = select(crowded, [2]);
  const total = selection.items.reduce((sum, item) => sum + item.text.length, 0);
  assert.ok(total <= CONTEXT_LIMITS.maxTotalChars, `total ${total} should fit the budget`);
  assert.ok(selection.items.length >= 3);
  assert.ok(
    selection.decisions.some(
      (decision) =>
        decision.decision === "context-cue-refused" &&
        decision.reason === REFUSAL_REASON.totalBudgetExceeded,
    ),
  );
}

// Items are sent in playback order, so a model reads the scene in the order the
// viewer will.
{
  const selection = select(crossing, [4]);
  const starts = host(selection.items.map((item) => item.startMs));
  assert.deepEqual([...starts].sort((left, right) => left - right), starts);
  for (const item of selection.items) {
    assert.equal(typeof item.position, "string");
    assert.equal(typeof item.startMs, "number");
    assert.equal(typeof item.text, "string");
  }
}

// A track with no timeline at all cannot be measured, and is reported rather
// than guessed at from indexes.
{
  const selection = select([cue(-1, -1, "rendered line")], [0], 1);
  assert.equal(selection.reason, CONTEXT_REASON.targetTimeUnknown);
  assert.equal(selection.items.length, 0);
}

// Requested lines that are not in the track are told apart from a request that
// asked for nothing.
{
  const missing = translateContext.selectContext({
    scope: crossing,
    targetIndexes: [],
    requestedCount: 1,
  });
  assert.equal(missing.reason, CONTEXT_REASON.targetsNotInTrack);

  const none = translateContext.selectContext({
    scope: crossing,
    targetIndexes: [],
    requestedCount: 0,
  });
  assert.equal(none.reason, CONTEXT_REASON.noTargetCues);

  const noTrack = select([], [], 1);
  assert.equal(noTrack.reason, CONTEXT_REASON.noTrackCues);

  const disabled = select(crossing, [3], 1, false);
  assert.equal(disabled.reason, CONTEXT_REASON.disabled);
  assert.equal(disabled.items.length, 0);

  const invalid = translateContext.selectContext({
    scope: crossing,
    targetIndexes: [3, 99, -1, 3],
    requestedCount: 2,
  });
  assert.equal(invalid.targets, 1, "duplicate and out-of-range indexes are refused");
  assert.ok(
    invalid.decisions.some(
      (decision) => decision.reason === REFUSAL_REASON.targetIndexInvalid,
    ),
  );
}

// A line with no text is not context, and a cue with no timeline anywhere is
// reported by the reason it was refused.
{
  const selection = select([cue(0, 2, "   "), cue(2, 4, "requested")], [1]);
  assert.equal(selection.items.length, 0);
  assert.equal(selection.reason, CONTEXT_REASON.budgetExceeded);
  assert.ok(
    selection.decisions.some((decision) => decision.reason === REFUSAL_REASON.textEmpty),
  );

  const mixed = select([cue(-1, -1, "rendered"), cue(0, 2, "timed"), cue(2, 4, "requested")], [0, 2], 2);
  assert.equal(mixed.targets, 1, "only the requested line with a timeline is measured against");
  assert.ok(
    mixed.decisions.some(
      (decision) => decision.reason === REFUSAL_REASON.noTimeline && decision.role === "target",
    ),
  );
}

// The report carries kinds, reasons and counts — never a word of the subtitle.
{
  const selection = select(crossing, [3]);
  selection.decisions.push(...select(crossing, [3]).decisions);
  const serialized = JSON.stringify(selection.decisions);
  for (const item of crossing) {
    assert.doesNotMatch(serialized, new RegExp(item.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(serialized, /context-cue-included/);
}

// The message boundary: context that arrives from outside is validated, and a
// position the sender did not give is refused instead of renamed "nearby".
{
  const nothing = translateContext.sanitizeContextItems(undefined);
  assert.equal(nothing.reason, CONTEXT_REASON.nothingSent);
  assert.equal(nothing.refused, 0);
  assert.deepEqual([...nothing.items], []);
  assert.equal(translateContext.sanitizeContextItems([]).reason, CONTEXT_REASON.nothingSent);

  const notAnArray = translateContext.sanitizeContextItems("before");
  assert.equal(notAnArray.reason, CONTEXT_REASON.itemsInvalid);
  assert.equal(notAnArray.decisions[0].reason, REFUSAL_REASON.notAnArray);

  const mixedItems = translateContext.sanitizeContextItems([
    { position: "before", startMs: 1000, text: "kept" },
    { startMs: 2000, text: "no position" },
    { position: "sideways", startMs: 3000, text: "unknown position" },
    { position: "between", startMs: 4000, text: "older build" },
    { position: "after", startMs: 5000, text: "   " },
    { position: "after", startMs: null, text: "no start" },
    "not an object",
  ]);
  assert.equal(mixedItems.reason, CONTEXT_REASON.ok);
  assert.deepEqual(
    host(mixedItems.items.map((item) => [item.position, item.text])),
    [
      ["before", "kept"],
      ["overlapping", "older build"],
      ["after", "no start"],
    ],
  );
  assert.equal(mixedItems.refused, 4);
  const reasons = mixedItems.decisions.map((decision) => decision.reason);
  assert.ok(reasons.includes(REFUSAL_REASON.positionMissing));
  assert.ok(reasons.includes(REFUSAL_REASON.positionUnknown));
  assert.ok(reasons.includes(REFUSAL_REASON.textEmpty));
  assert.ok(reasons.includes(REFUSAL_REASON.notAnObject));
  assert.ok(
    !reasons.includes("nearby"),
    "the invented label is gone from the vocabulary",
  );
  assert.equal(mixedItems.items[2].startMs, null, "a missing start is reported as unknown");
  assert.ok(reasons.includes("position-renamed"), "the rename from between is reported");

  // The boundary can be applied twice: items that already passed it pass again.
  const again = translateContext.sanitizeContextItems([...mixedItems.items]);
  assert.deepEqual([...again.items], [...mixedItems.items]);
  assert.equal(again.refused, 0);

  const allRejected = translateContext.sanitizeContextItems([
    { position: "sideways", text: "a" },
    { position: "before", text: "" },
  ]);
  assert.equal(allRejected.reason, CONTEXT_REASON.allRejected);
  assert.equal(allRejected.items.length, 0);

  const many = translateContext.sanitizeContextItems(
    Array.from({ length: 12 }, (_, index) => ({
      position: "after",
      startMs: index * 1000,
      text: `line ${index}`,
    })),
  );
  assert.equal(many.items.length, CONTEXT_LIMITS.maxItems);
  assert.ok(many.decisions.some((decision) => decision.reason === REFUSAL_REASON.itemBudgetExceeded));

  const oversized = translateContext.sanitizeContextItems([
    { position: "before", startMs: 0, text: "y".repeat(900) },
  ]);
  assert.ok(oversized.items[0].text.length <= CONTEXT_LIMITS.maxTextChars);

  // The boundary is the amount the viewer chose, so a level is not cut down to
  // some other level's ceiling on the way to the provider.
  const shipped = (count) =>
    Array.from({ length: count }, (_, index) => ({
      position: "after",
      startMs: index * 1000,
      text: `shipped ${index}`,
    }));
  const small = translateContext.sanitizeContextItems(shipped(12), "minimal");
  assert.equal(small.items.length, translateContext.resolveBudget("minimal").maxItems);
  assert.ok(
    small.decisions.some((decision) => decision.reason === REFUSAL_REASON.itemBudgetExceeded),
    "what the smaller amount leaves out is refused with a reason",
  );
  assert.equal(
    translateContext.sanitizeContextItems(shipped(12), "wide").items.length,
    translateContext.resolveBudget("wide").maxItems,
    "a wider amount keeps the lines it was chosen to send",
  );
  assert.equal(
    translateContext.sanitizeContextItems(shipped(12)).items.length,
    CONTEXT_LIMITS.maxItems,
    "an unstated amount is the default boundary",
  );
  assert.equal(
    translateContext.sanitizeContextItems(shipped(3), "nonsense").items.length,
    3,
    "an amount LST does not know falls back to the default rather than refusing everything",
  );
}

// Layer 2 — the background validates context at its own boundary, so nothing
// reaches a provider unchecked.

const values = {};
const fetchRequests = [];
let backgroundHandler;

async function mockFetch(url, init = {}) {
  fetchRequests.push({ url, init });
  const body = JSON.parse(init.body || "{}");
  const prompt = JSON.parse(body.prompt || "{}");
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    async json() {
      return {
        response: JSON.stringify({
          translations: (prompt.subtitles || []).map((item) => ({
            id: item.id,
            text: `translated:${item.text}`,
          })),
        }),
        done_reason: "stop",
      };
    },
  };
}

const storage = {
  async get(query) {
    if (query == null) return { ...values };
    if (typeof query === "string") return { [query]: values[query] };
    if (Array.isArray(query)) {
      return Object.fromEntries(query.map((key) => [key, values[key]]));
    }
    return Object.fromEntries(
      Object.entries(query).map(([key, fallback]) => [key, values[key] ?? fallback]),
    );
  },
  async set(entries) {
    Object.assign(values, entries);
  },
  async remove(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
  },
};

async function loadBackground({ withContextModule = true } = {}) {
  backgroundHandler = null;
  const backgroundContext = vm.createContext({
    AbortController,
    console,
    Date,
    fetch: mockFetch,
    setTimeout,
    clearTimeout,
    TextDecoder,
    TextEncoder,
    URL,
    chrome: {
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: { addListener(registered) { backgroundHandler = registered; } },
        sendMessage: async () => {},
        openOptionsPage: async () => {}
      },
      storage: { local: storage }
    }
  });
  for (const file of [
    "settings-schema.js",
    "episode-identity.js",
    "translation-guard.js",
    "structured-response.js",
  ]) {
    vm.runInContext(await read(file), backgroundContext, { filename: file });
  }
  if (withContextModule) {
    vm.runInContext(await read("translation-context.js"), backgroundContext, {
      filename: "translation-context.js",
    });
  }
  vm.runInContext(await read("background.js"), backgroundContext, {
    filename: "background.js",
  });
  assert.ok(backgroundHandler, "background.js should register a message handler");
  return backgroundContext;
}

function send(message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out: ${message.type}`)), 2000);
    backgroundHandler(message, {}, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function lastPrompt() {
  const request = fetchRequests.at(-1);
  return JSON.parse(JSON.parse(request.init.body).prompt);
}

function translate(items, contextItems, contextLevel) {
  return send({
    type: "TRANSLATE_BATCH",
    model: "test-model",
    targetLanguage: "English",
    items,
    ...(contextItems === undefined ? {} : { contextItems }),
    ...(contextLevel === undefined ? {} : { contextLevel }),
  });
}

// Context that passes the boundary reaches the provider, and the response says
// how much of what was sent was used.
{
  await loadBackground();
  const response = await translate(
    [{ id: "target", text: "対象" }],
    [
      { position: "before", startMs: 1000, text: "前" },
      { position: "after", startMs: 3000, text: "後" },
    ],
  );
  assert.equal(response.summary.contextSentCues, 2);
  assert.equal(response.summary.contextCueCount, 2);
  assert.equal(response.summary.contextReason, CONTEXT_REASON.ok);
  assert.equal(response.summary.contextRefusedCues, 0);
  const prompt = lastPrompt();
  assert.equal(prompt.subtitles.length, 1);
  assert.equal(prompt.contextSubtitles.length, 2);
  assert.deepEqual(
    prompt.contextSubtitles.map((item) => item.position),
    ["before", "after"],
  );
}

// An item with no position, an unknown position, an empty line and an oversized
// list are refused with a reason; the invented "nearby" label is gone and the
// second silent cut is gone with it.
{
  await loadBackground();
  const response = await translate(
    [{ id: "target", text: "対象" }],
    [
      { position: "before", startMs: 1000, text: "kept" },
      { position: "nearby", startMs: 2000, text: "invented label" },
      { position: "after", startMs: 3000, text: "  " },
      { startMs: 4000, text: "no position" },
      ...Array.from({ length: 12 }, (_, index) => ({
        position: "after",
        startMs: 5000 + index,
        text: `extra ${index}`,
      })),
    ],
  );
  const prompt = lastPrompt();
  // Six of the sixteen survive: the usable one plus the first five extras. The
  // rest are refused with a reason instead of being cut without one.
  assert.equal(prompt.contextSubtitles.length, CONTEXT_LIMITS.maxItems);
  assert.deepEqual(
    prompt.contextSubtitles.map((item) => item.text),
    ["kept", "extra 0", "extra 1", "extra 2", "extra 3", "extra 4"],
  );
  assert.equal(response.summary.contextSentCues, 16);
  assert.equal(response.summary.contextCueCount, CONTEXT_LIMITS.maxItems);
  assert.ok(response.summary.contextRefusedCues >= 3);
  const reasons = response.summary.contextDecisions.map((decision) => decision.reason);
  assert.ok(reasons.includes(REFUSAL_REASON.positionUnknown));
  assert.ok(reasons.includes(REFUSAL_REASON.positionMissing));
  assert.ok(reasons.includes(REFUSAL_REASON.textEmpty));
  assert.ok(reasons.includes(REFUSAL_REASON.itemBudgetExceeded));
  assert.doesNotMatch(JSON.stringify(response.summary.contextDecisions), /nearby/);
}

// Context that is entirely unusable is not sent at all, and the prompt stops
// claiming to contain reference lines.
{
  await loadBackground();
  const response = await translate(
    [{ id: "target", text: "対象" }],
    [{ position: "sideways", startMs: 1000, text: "a" }],
  );
  assert.equal(response.summary.contextReason, CONTEXT_REASON.allRejected);
  assert.equal(response.summary.contextCueCount, 0);
  const request = fetchRequests.at(-1);
  const body = JSON.parse(request.init.body);
  assert.doesNotMatch(body.prompt, /contextSubtitles/);
  assert.doesNotMatch(body.system, /reference only/i);
}

// A long reference line is shortened at the boundary too, so a request cannot
// grow without bound however it was built.
{
  await loadBackground();
  await translate(
    [{ id: "target", text: "対象" }],
    [{ position: "before", startMs: 1000, text: "z".repeat(5000) }],
  );
  const prompt = lastPrompt();
  assert.equal(prompt.contextSubtitles.length, 1);
  assert.ok(prompt.contextSubtitles[0].text.length <= CONTEXT_LIMITS.maxTextChars);
}

// The boundary the background applies is the amount the viewer chose: the level
// the request names decides how much survives, and the level stored in settings
// is what a request that names none is checked against.
{
  await loadBackground();
  const items = Array.from({ length: 12 }, (_, index) => ({
    position: "after",
    startMs: index * 1000,
    text: `extra ${index}`,
  }));

  const minimal = await translate([{ id: "target", text: "対象" }], items, "minimal");
  assert.equal(
    minimal.summary.contextCueCount,
    translateContext.resolveBudget("minimal").maxItems,
    "a smaller amount keeps fewer reference lines",
  );
  assert.deepEqual(
    lastPrompt().contextSubtitles.map((item) => item.text),
    ["extra 0", "extra 1", "extra 2"],
  );

  const wide = await translate([{ id: "target", text: "対象" }], items, "wide");
  assert.equal(
    wide.summary.contextCueCount,
    translateContext.resolveBudget("wide").maxItems,
    "a wider amount keeps the lines it was chosen to send",
  );

  // A request that names no amount is checked against the stored one, so the two
  // sides cannot disagree about what the viewer chose.
  values.contextLevel = "minimal";
  const stored = await translate([{ id: "target", text: "対象" }], items);
  assert.equal(
    stored.summary.contextCueCount,
    translateContext.resolveBudget("minimal").maxItems,
  );
  values.contextLevel = "nonsense";
  const unknown = await translate([{ id: "target", text: "対象" }], items);
  assert.equal(
    unknown.summary.contextCueCount,
    CONTEXT_LIMITS.maxItems,
    "an amount no build knows falls back to the default",
  );
  delete values.contextLevel;
}

// A request without context is unchanged, and says so.
{
  await loadBackground();
  const response = await translate([{ id: "target", text: "対象" }]);
  assert.equal(response.summary.contextSentCues, 0);
  assert.equal(response.summary.contextCueCount, 0);
  assert.equal(response.summary.contextReason, CONTEXT_REASON.nothingSent);
  assert.doesNotMatch(JSON.parse(fetchRequests.at(-1).init.body).prompt, /contextSubtitles/);
}

// Without the module the boundary refuses everything and names the reason,
// rather than falling back to a rule of its own.
{
  await loadBackground({ withContextModule: false });
  const response = await translate(
    [{ id: "target", text: "対象" }],
    [{ position: "before", startMs: 1000, text: "前" }],
  );
  assert.equal(response.summary.contextCueCount, 0);
  // The background fallback repeats these two strings because a missing module
  // cannot be asked for them; the suite holds them to the module's vocabulary.
  assert.equal(response.summary.contextReason, CONTEXT_REASON.unavailable);
  assert.equal(CONTEXT_REASON.unavailable, "translation-context-unavailable");
  assert.equal(response.summary.contextSentCues, 1);
  assert.equal(response.summary.contextRefusedCues, 1);
  assert.equal(
    response.summary.contextDecisions[0].decision,
    translateContext.DECISION.unavailable,
  );
  assert.doesNotMatch(JSON.parse(fetchRequests.at(-1).init.body).prompt, /contextSubtitles/);
  // The translations themselves are unaffected: context is optional.
  assert.equal(response.translations.length, 1);
}

// Layer 3 — the page asks the module for its context, sends what it decided,
// and records the decision without recording a word of the subtitle.
//
// Precompute is the driver: it translates the cues that are not cached yet, so a
// track whose cache has a hole in it asks for exactly the cues this test wants
// to ask about without needing Netflix's rendered line to be observed.

const settingsSchemaSource = await read("settings-schema.js");
const contentSource = await read("content.js");
const subtitleParserSource = await read("subtitle-parser.js");
const sessionLifecycleSource = await read("session-lifecycle.js");
const capturedTrackLifecycleSource = await read("captured-track-lifecycle.js");
const syncSource = await read("subtitle-sync.js");
const identitySource = await read("episode-identity.js");
const playbackSiteSource = await read("playback-site.js");
const netflixSiteSource = await read("netflix.js");
const primeVideoSiteSource = await read("prime-video.js");
const coordinatorSource = await read("translation-coordinator.js");

// Three lines of one scene, a silence of almost three minutes, then the scene
// the viewer is watching. The requested cue is two *indexes* from the earlier
// scene, which is what the old window went by.
const SILENT_GAP_TRACK = [
  "WEBVTT",
  "",
  "00:00:10.000 --> 00:00:11.000",
  "I don't know.",
  "",
  "00:00:20.000 --> 00:00:21.000",
  "Let's go.",
  "",
  "00:00:30.000 --> 00:00:31.000",
  "Yeah!",
  "",
  "00:03:20.000 --> 00:03:21.000",
  "Is anyone there?",
  "",
  "00:03:21.000 --> 00:03:22.000",
  "Answer me.",
  "",
  "00:03:22.000 --> 00:03:23.000",
  "Please.",
  "",
  "00:03:23.000 --> 00:03:24.000",
  "Anything?",
  "",
].join("\n");

const EARLIER_SCENE_KEYS = [
  "10000:11000:I don't know.",
  "20000:21000:Let's go.",
  "30000:31000:Yeah!",
];
const LATER_SCENE_KEYS = {
  "202000:203000:Please.": "translated",
  "203000:204000:Anything?": "translated",
};
// The cache decides which cues a request is about.
const cached = (...keys) =>
  Object.fromEntries(keys.map((key) => [key, "translated"]));

function createElementStub(tagName = "div") {
  const node = {
    tagName: String(tagName).toUpperCase(),
    id: "",
    className: "",
    style: {
      setProperty() {},
      removeProperty() {},
      getPropertyValue() {
        return "";
      },
    },
    dataset: {},
    hidden: false,
    isConnected: true,
    nodeType: 1,
    childElementCount: 0,
    children: [],
    textContent: "",
    innerText: "",
    innerHTML: "",
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      },
    },
    appendChild(child) {
      node.children.push(child);
      node.childElementCount = node.children.length;
      return child;
    },
    insertBefore(child) {
      return node.appendChild(child);
    },
    append(...appended) {
      for (const child of appended) node.appendChild(child);
    },
    replaceChildren(...replaced) {
      node.children = replaced;
      node.childElementCount = replaced.length;
    },
    removeChild(child) {
      const index = node.children.indexOf(child);
      if (index >= 0) node.children.splice(index, 1);
      node.childElementCount = node.children.length;
      return child;
    },
    remove() {},
    setAttribute() {},
    removeAttribute() {},
    getAttribute() {
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    scrollIntoView() {},
    matches() {
      return false;
    },
    closest() {
      return null;
    },
    querySelector(selector) {
      if (!node.queryCache) node.queryCache = new Map();
      if (!node.queryCache.has(selector)) {
        node.queryCache.set(selector, createElementStub("div"));
      }
      return node.queryCache.get(selector);
    },
    querySelectorAll() {
      return [];
    },
    cloneNode() {
      return createElementStub(tagName);
    },
    getBoundingClientRect() {
      return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    },
  };
  return node;
}

function createContentHarness({
  useTranslationContext = true,
  contextLevel = "standard",
  withContextModule = true,
  contextReason = "ok",
  cachedEntries = {},
} = {}) {
  const netflix = { text: "" };
  const video = {
    currentTime: 0,
    paused: false,
    duration: 1200,
    readyState: 4,
    playbackRate: 1,
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null;
    },
  };
  const sentMessages = [];
  const intervals = [];
  const frames = [];
  const windowListeners = new Map();
  const messageHandlers = [];
  const document = {
    documentElement: createElementStub("html"),
    body: createElementStub("body"),
    head: createElementStub("head"),
    fullscreenElement: null,
    createElement: (tagName) => createElementStub(tagName),
    createDocumentFragment: () => createElementStub("#fragment"),
    addEventListener() {},
    removeEventListener() {},
    querySelector(selector) {
      if (selector === "video") return video;
      if (selector === ".player-timedtext") {
        return netflix.text ? { innerText: netflix.text, textContent: netflix.text } : null;
      }
      return null;
    },
    querySelectorAll(selector) {
      // The adapter selects the element the viewer is watching from this list.
      if (selector === "video") return [video];
      return [];
    },
  };
  class MutationObserverStub {
    observe() {}
    disconnect() {}
  }
  const consoleMessages = [];
  // Keep content.js console noise out of the suite output, but keep the message
  // of an error rather than its empty JSON form.
  const describe = (value) =>
    value && typeof value === "object" && typeof value.message === "string"
      ? value.message
      : value;
  const quietConsole = {
    log: (...args) => consoleMessages.push(args.map(describe)),
    info: (...args) => consoleMessages.push(args.map(describe)),
    warn: (...args) => consoleMessages.push(args.map(describe)),
    error: (...args) => consoleMessages.push(args.map(describe)),
  };
  const context = vm.createContext({
    document,
    location: {
      href: "https://www.netflix.com/watch/80100172",
      host: "www.netflix.com",
      pathname: "/watch/80100172",
      search: "",
    },
    performance,
    console: quietConsole,
    URL,
    setTimeout,
    clearTimeout,
    setInterval(callback, ms) {
      intervals.push({ callback, ms });
      return intervals.length;
    },
    clearInterval() {},
    requestAnimationFrame(callback) {
      frames.push(callback);
      return frames.length;
    },
    cancelAnimationFrame() {},
    MutationObserver: MutationObserverStub,
    fetch: async () => ({ ok: false, status: 404, async text() { return ""; } }),
    browser: {
      runtime: {
        onMessage: {
          addListener(handler) {
            messageHandlers.push(handler);
          },
        },
        getManifest() {
          return { version: "0.0.0-test" };
        },
        sendMessage(message) {
          sentMessages.push(message);
          if (message?.type === "GET_SETTINGS") {
            return Promise.resolve({
              ok: true,
              settings: {
                enabled: true,
                provider: "ollama",
                model: "test-model",
                targetLanguage: "English",
                showDebugPanel: false,
                useTranslationContext,
                contextLevel,
                autoTranslateAhead: false,
                cacheWhilePaused: false,
              },
            });
          }
          if (message?.type === "TRANSLATE_BATCH") {
            return Promise.resolve({
              ok: true,
              translations: (message.items || []).map((item) => ({
                id: item.id,
                text: `translated:${item.text}`,
              })),
              failures: [],
              diagnostics: [],
              summary: {
                requested: (message.items || []).length,
                translated: (message.items || []).length,
                failed: 0,
                elapsedMs: 1,
                model: "test-model",
                provider: "ollama",
                targetLanguage: "English",
                contextCueCount: (message.contextItems || []).length,
                contextSentCues: (message.contextItems || []).length,
                contextReason,
                contextRefusedCues: 0,
                contextDecisions: [],
              },
            });
          }
          if (message?.type === "CACHE_GET") {
            const requested = message.keys || [];
            return Promise.resolve({
              ok: true,
              entries: Object.fromEntries(
                requested
                  .filter((key) => Object.prototype.hasOwnProperty.call(cachedEntries, key))
                  .map((key) => [key, cachedEntries[key]]),
              ),
              cues: [],
            });
          }
          return Promise.resolve({ ok: true, entries: {}, cues: [] });
        },
      },
      storage: {
        local: {
          async get() {
            return {};
          },
          async set() {},
        },
      },
    },
  });
  context.addEventListener = (type, handler) => windowListeners.set(type, handler);
  const windowRef = vm.runInContext("globalThis.window = globalThis", context);

  vm.runInContext(settingsSchemaSource, context, { filename: "settings-schema.js" });
  vm.runInContext(playbackSiteSource, context, { filename: "playback-site.js" });
  vm.runInContext(netflixSiteSource, context, { filename: "netflix.js" });
  vm.runInContext(primeVideoSiteSource, context, { filename: "prime-video.js" });
  vm.runInContext(identitySource, context, { filename: "episode-identity.js" });
  vm.runInContext(syncSource, context, { filename: "subtitle-sync.js" });
  vm.runInContext(coordinatorSource, context, { filename: "translation-coordinator.js" });
  if (withContextModule) {
    vm.runInContext(contextSource, context, { filename: "translation-context.js" });
  }
  vm.runInContext(subtitleParserSource, context, { filename: "subtitle-parser.js" });
  vm.runInContext(sessionLifecycleSource, context, { filename: "session-lifecycle.js" });
  vm.runInContext(capturedTrackLifecycleSource, context, {
    filename: "captured-track-lifecycle.js",
  });
  vm.runInContext(contentSource, context, { filename: "content.js" });

  const debugEvents = () => {
    const events = [];
    for (const message of sentMessages) {
      if (message?.type === "APPEND_DEBUG_EVENTS") events.push(...message.events);
    }
    return events;
  };
  const settle = async (ms = 0) => {
    for (let index = 0; index < 16; index += 1) await Promise.resolve();
    if (ms) await sleep(ms);
    for (let index = 0; index < 16; index += 1) await Promise.resolve();
  };

  return {
    consoleMessages,
    debugEvents,
    eventsNamed: (name) => debugEvents().filter((event) => event.event === name),
    requests: () => sentMessages.filter((message) => message?.type === "TRANSLATE_BATCH"),
    contextRequests: () =>
      sentMessages
        .filter((message) => message?.type === "TRANSLATE_BATCH")
        .filter((message) => Array.isArray(message.contextItems) && message.contextItems.length),
    async start(vtt = SILENT_GAP_TRACK) {
      // content.js starts playback itself on a watch page, so give it a moment
      // to register its listeners and then hand it the captured track.
      await settle(20);
      const handler = windowListeners.get("message");
      assert.ok(handler, "content.js should listen for captured subtitles");
      handler({
        source: windowRef,
        data: {
          source: "lst-local-subtitle-translate",
          type: "SUBTITLE_DOCUMENT",
          payload: { url: "https://www.netflix.com/subtitle.vtt", text: vtt },
        },
      });
      await settle(20);
      assert.ok(messageHandlers.length, "content.js should answer page messages");
    },
    async precompute() {
      const response = await new Promise((resolve) => {
        messageHandlers[0]({ type: "START_PRECOMPUTE" }, {}, resolve);
      });
      assert.equal(response.ok, true, JSON.stringify(response));
      // Precompute runs detached from the popup that asked for it.
      await settle(40);
      // Diagnostics are buffered for half a second before they are flushed.
      await settle(600);
      return response;
    },
  };
}

{
  // Everything up to the silence is cached, so the request is for the two cues
  // of the scene being watched. The earlier scene is two indexes away and is not
  // context for them.
  const harness = createContentHarness({
    cachedEntries: { ...cached(...EARLIER_SCENE_KEYS), ...LATER_SCENE_KEYS },
  });
  await harness.start();
  await harness.precompute();

  const requests = harness.requests();
  assert.equal(requests.length, 1, `one batch should be requested: ${JSON.stringify(harness.consoleMessages)}`);
  const request = requests[0];
  assert.deepEqual(
    Array.from(request.items).map((item) => item.text),
    ["Is anyone there?", "Answer me."],
  );
  assert.deepEqual(
    Array.from(request.contextItems).map((item) => [item.position, item.text]),
    [
      ["after", "Please."],
      ["after", "Anything?"],
    ],
  );
  assert.ok(
    Array.from(request.contextItems).every((item) => item.startMs >= 200000),
    "nothing from the earlier scene is sent",
  );

  const selection = harness.eventsNamed("translation-context-selected");
  assert.equal(selection.length, 1, "the decision is recorded once per request");
  assert.equal(selection[0].category, "translation");
  assert.equal(selection[0].details.reason, CONTEXT_REASON.ok);
  assert.equal(selection[0].details.requestedCues, 2);
  assert.equal(selection[0].details.targetCues, 2);
  assert.equal(selection[0].details.contextCues, 2);
  assert.equal(selection[0].details.after, 2);
  assert.equal(selection[0].details.before, 0);
  assert.equal(selection[0].details.refused, 1, "the line across the silence is counted");
  assert.equal(selection[0].details.limits, translateContext.describeLimits());

  // The event log records the decision, not the page's words.
  const serialized = JSON.stringify(harness.debugEvents());
  for (const line of ["Is anyone there?", "Answer me.", "Please.", "Let's go.", "Yeah!"]) {
    assert.doesNotMatch(serialized, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
}

{
  // The same track with the whole earlier scene left uncached: the batch is
  // wider than the ceiling, and the requested lines nearest the silence still
  // get their reference lines before the far ones.
  const harness = createContentHarness({
    cachedEntries: { ...cached("30000:31000:Yeah!"), ...LATER_SCENE_KEYS },
  });
  await harness.start();
  await harness.precompute();

  const request = harness.requests()[0];
  assert.deepEqual(
    Array.from(request.items).map((item) => item.text),
    ["I don't know.", "Let's go.", "Is anyone there?", "Answer me."],
  );
  const items = Array.from(request.contextItems);
  assert.ok(items.length <= CONTEXT_LIMITS.maxItems);
  assert.ok(items.every((item) => item.startMs >= 10000));
  assert.ok(
    !items.some((item) => item.text === "Yeah!"),
    "the line across the silence is not context for either scene",
  );
  assert.ok(
    items.some((item) => item.text === "Please.") && items.some((item) => item.text === "Anything?"),
  );
  const selection = harness.eventsNamed("translation-context-selected");
  assert.equal(selection[0].details.reason, CONTEXT_REASON.ok);
  assert.ok(selection[0].details.refused >= 1);
}

{
  // With the setting off, nothing is sent and nothing is written: context is off
  // by default and must not fill the log with a decision per request.
  const harness = createContentHarness({
    useTranslationContext: false,
    cachedEntries: { ...cached("30000:31000:Yeah!"), ...LATER_SCENE_KEYS },
  });
  await harness.start();
  await harness.precompute();
  assert.ok(harness.requests().length >= 1);
  assert.equal(harness.contextRequests().length, 0);
  assert.equal(harness.eventsNamed("translation-context-selected").length, 0);
  assert.equal(harness.eventsNamed("translation-context-skipped").length, 0);
}

{
  // Without the module the request still goes out, without context, and the
  // reason is recorded instead of an index-distance window being invented.
  const harness = createContentHarness({
    withContextModule: false,
    cachedEntries: { ...cached("30000:31000:Yeah!"), ...LATER_SCENE_KEYS },
  });
  await harness.start();
  await harness.precompute();
  assert.ok(harness.requests().length >= 1);
  assert.equal(harness.contextRequests().length, 0);
  const skipped = harness.eventsNamed("translation-context-skipped");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].details.reason, "translation-context-unavailable");
  assert.equal(skipped[0].details.targetCues, 4);
  assert.ok(
    harness.consoleMessages.some((args) =>
      String(args[0] || "").includes("translation-context.js is missing"),
    ),
    "a missing module should say so once",
  );
}

{
  // The background is the last check before a provider; if it refuses or
  // shortens what was sent, the viewer can find out why.
  const harness = createContentHarness({
    contextReason: "context-items-rejected",
    cachedEntries: { ...cached("30000:31000:Yeah!"), ...LATER_SCENE_KEYS },
  });
  await harness.start();
  await harness.precompute();
  const rejected = harness.eventsNamed("translation-context-rejected");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].details.reason, "context-items-rejected");
  assert.ok(rejected[0].details.sentCues >= 1);
  assert.equal(rejected[0].details.queue, "precompute");
}

// How much context travels with a request is the viewer's choice, and the player
// reads that choice from the setting rather than applying a rule of its own: the
// same episode under the smallest amount does not carry the same lines as it
// does under the default.
{
  const harness = createContentHarness({
    contextLevel: "minimal",
    cachedEntries: { ...cached(...EARLIER_SCENE_KEYS), ...LATER_SCENE_KEYS },
  });
  await harness.start();
  await harness.precompute();

  const request = harness.requests()[0];
  assert.equal(
    request.contextLevel,
    "minimal",
    "the request says which amount it was built under, so the background checks the same one",
  );
  assert.deepEqual(
    Array.from(request.contextItems).map((item) => item.text),
    ["Please."],
    "the smallest amount keeps one line on a side, not the two the default would",
  );
  const selection = harness.eventsNamed("translation-context-selected");
  assert.equal(selection[0].details.limits, translateContext.describeLimits("minimal"));
  assert.equal(selection[0].details.after, 1);
  assert.equal(selection[0].details.before, 0);
}

{
  // An amount this build does not know — a value a later version wrote, or a
  // hand-edited one — still translates: it resolves to the default rather than
  // to no context at all, and the request says which amount it was built under.
  const harness = createContentHarness({
    contextLevel: "enormous",
    cachedEntries: { ...cached(...EARLIER_SCENE_KEYS), ...LATER_SCENE_KEYS },
  });
  await harness.start();
  await harness.precompute();

  const request = harness.requests()[0];
  assert.equal(request.contextLevel, "enormous");
  const selection = harness.eventsNamed("translation-context-selected");
  assert.equal(selection[0].details.limits, translateContext.describeLimits());
}

// Layer 4 — the interface and the packaging describe the same rule the module
// implements, and load it before the files that ask it questions.

{
  const optionsHtml = await read("options.html");
  const optionsJs = await read("options.js");
  const readme = await read("README.md");
  const manifest = JSON.parse(await read("manifest.json"));
  const background = await read("background.js");
  const content = await read("content.js");
  const prepare = await read("scripts/prepare-browser.mjs");
  const verify = await read("scripts/verify-package.mjs");
  const packageJson = JSON.parse(await read("package.json"));

  // The options page asks the module for the amounts it offers. The control is
  // empty in the markup and both it and the sentence under it are built from
  // contextLevelOptions(), so the page cannot state a limit of its own — and a
  // test fails rather than letting one be typed in.
  assert.match(
    optionsHtml,
    /<select id="contextLevel"><\/select>/,
    "the amounts must be offered by the module, not typed into the page",
  );
  assert.match(optionsHtml, /id="contextLevelSummary"/);
  assert.match(optionsHtml, /<script src="\.\.\/\.\.\/shared\/translation-context\.js"><\/script>/);
  assert.ok(
    optionsHtml.indexOf('src="../../shared/translation-context.js"') < optionsHtml.indexOf('src="options.js"'),
    "the options page loads the module before the script that asks it",
  );
  assert.match(optionsJs, /contextLevelOptions\(\)/);
  assert.match(optionsJs, /describeLevelSummary\(/);
  assert.match(optionsJs, /resolveBudget\(/);
  assert.doesNotMatch(
    optionsJs,
    /\d+ lines per request/,
    "an amount must not be typed into the options script either",
  );
  assert.doesNotMatch(
    optionsHtml,
    /nearby source lines before and after/,
    "the page must not repeat an amount the setting can change",
  );

  // The README states the amounts the module implements, for every level, and
  // names the setting the viewer changes.
  assert.match(readme, /Context amount/);
  for (const level of CONTEXT_LEVELS) {
    assert.match(
      readme,
      new RegExp(`\\*${level.label}\\*`),
      `the README must name the ${level.label} amount`,
    );
    assert.match(readme, new RegExp(`${level.beforeCues} lines? each side`));
    assert.match(readme, new RegExp(`at most ${level.maxItems} lines per request`));
  }
  const cutoffs = CONTEXT_LEVELS.map((level) => level.maxGapSeconds);
  assert.match(
    readme,
    new RegExp(`${cutoffs.slice(0, -1).join(", ")}, or ${cutoffs.at(-1)} seconds`),
    "the README states the cutoffs the levels declare",
  );
  assert.match(readme, /translation-context\.js/);

  // Firefox loads it in the background, before background.js.
  const backgroundScripts = manifest.background.scripts;
  assert.ok(backgroundScripts.includes("shared/translation-context.js"));
  assert.ok(
    backgroundScripts.indexOf("shared/translation-context.js") < backgroundScripts.indexOf("background/index.js"),
  );

  // The content script list loads it before content.js.
  const isolated = manifest.content_scripts.find((entry) => entry.js.includes("content/index.js"));
  assert.ok(isolated.js.includes("shared/translation-context.js"));
  assert.ok(isolated.js.indexOf("shared/translation-context.js") < isolated.js.indexOf("content/index.js"));

  // Chromium's single service worker imports it by name.
  assert.match(background, /importScripts\([\s\S]*"\.\.\/shared\/translation-context\.js"/);

  // The page describes the rule by asking for it, so the HUD cannot drift, and
  // the amount it asks about is the viewer's own choice.
  assert.match(content, /translationContextApi\(\)\?\.describeLimits\(settings\.contextLevel\)/);
  assert.match(content, /level: settings\.contextLevel/);
  assert.match(content, /contextLevel: settings\.contextLevel/);
  assert.doesNotMatch(content, /2 cues before\/after/);

  // The background is the last check before a provider, and it checks against
  // the amount the request names rather than a fixed one of its own.
  assert.match(
    background,
    /sanitizeContextItems\(\s*message\.contextItems,\s*message\.contextLevel \?\? settings\.contextLevel,?\s*\)/,
  );

  // Both packages ship the module, and the test suite runs it.
  assert.match(prepare, /readdir\("src"\)/);
  assert.match(verify, /"shared\/translation-context\.js"/);
  assert.equal(packageJson.scripts["test:translation-context"], "node tests/test-translation-context.mjs");
  assert.match(packageJson.scripts.check, /test:translation-context/);
  assert.equal(packageJson.scripts["check:syntax"], "node scripts/check-syntax.mjs");
}

console.log("Translation context checks passed.");
