import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

// Layer 1 — the matching module on its own.

const syncContext = vm.createContext({});
const syncSource = await fs.readFile(
  new URL("../subtitle-sync.js", import.meta.url),
  "utf8",
);
const episodeIdentitySource = await fs.readFile(
  new URL("../episode-identity.js", import.meta.url),
  "utf8",
);
const playbackSiteSource = await fs.readFile(
  new URL("../playback-site.js", import.meta.url),
  "utf8",
);
const subtitleImportSource = await fs.readFile(
  new URL("../subtitle-import.js", import.meta.url),
  "utf8",
);
const coordinatorSource = await fs.readFile(
  new URL("../translation-coordinator.js", import.meta.url),
  "utf8",
);
const translationContextSource = await fs.readFile(
  new URL("../translation-context.js", import.meta.url),
  "utf8",
);
vm.runInContext(syncSource, syncContext, { filename: "subtitle-sync.js" });
const sync = syncContext.LSTSubtitleSync;

assert.equal(sync.MATCH_TIER.folded, 2);
assert.equal(sync.MATCH_TIER.loose, 1);
assert.equal(sync.MATCH_TIER.none, 0);

// Folding keeps identity while dropping encoding and layout noise.
const foldedEquivalent = [
  ["Don't go.", "Don\u2019t go."],
  ["Don't go.", "Don`t go."],
  ['He said "go".', "He said \u201cgo\u201d."],
  ["Wait\u2026", "Wait..."],
  ["Wait\u2026", "Wait\u2026"],
  ["a \u2013 b", "a - b"],
  ["a \u2014 b", "a - b"],
  ["\u3053\u3093\u306b\u3061\u306f", "\u3053\u3093\u306b\u3061\u306f"],
  ["Hello", "Hello\u200b"],
  ["Hello", "\u00a0Hello "],
  ["Hello world", "Hello\nworld"],
  ["Hello world", "Hello\tworld"],
  ["\uff21\uff22\uff23", "ABC"],
  ["\uff0f", "\uff0f"],
];
for (const [left, right] of foldedEquivalent) {
  assert.equal(
    sync.matchTier(left, right),
    sync.MATCH_TIER.folded,
    `${JSON.stringify(left)} should fold-match ${JSON.stringify(right)}`,
  );
}

// Full-width punctuation and case are the loose tier, not the folded one.
assert.equal(
  sync.matchTier("WHAT ARE YOU DOING\uff1f", "What are you doing?"),
  sync.MATCH_TIER.loose,
);
assert.equal(
  sync.simplifySubtitleText("WHAT ARE YOU DOING\uff1f"),
  sync.simplifySubtitleText("What are you doing?"),
);
assert.equal(sync.matchTier("Yeah!", "No!"), sync.MATCH_TIER.none);
assert.equal(sync.matchTier("", "Yeah!"), sync.MATCH_TIER.none);
assert.equal(sync.matchTier("?", "!"), sync.MATCH_TIER.none);
assert.equal(sync.foldSubtitleText(undefined), "");
assert.equal(sync.foldSubtitleText("  spaced  "), "spaced");

const englishCues = [
  { start: 922.004, end: 923.672, text: "\u672c\u5f53\u3060\u3002" },
  { start: 924.465, end: 926.759, text: "\u6b21\u306e\u5b57\u5e55\u3067\u3059" },
  { start: 930.262, end: 933.932, text: "What are you doing?" },
];

// A single folded match resolves without needing the clock at all.
const foldedOnly = sync.resolveCue(
  englishCues,
  "WHAT ARE YOU DOING\uff1f",
  924.5,
);
assert.equal(foldedOnly.index, 2);
assert.equal(foldedOnly.reason, "loose");
assert.equal(foldedOnly.resolvedBy, "unique");
assert.equal(foldedOnly.ambiguous, false);
assert.equal(foldedOnly.timeTrusted, true);

const typographic = sync.resolveCue(englishCues, "\u6b21\u306e\u5b57\u5e55\u3067\u3059", 0);
assert.equal(typographic.index, 1);
assert.equal(typographic.reason, "folded");
assert.equal(typographic.resolvedBy, "unique");
assert.equal(typographic.tier, sync.MATCH_TIER.folded);

assert.equal(sync.resolveCue(englishCues, "Nothing like this", 924.5), null);
assert.equal(sync.resolveCue(englishCues, "", 924.5), null);
assert.equal(sync.resolveCue(englishCues, "?", 924.5), null);
assert.equal(sync.resolveCue([], "Yes.", 1), null);
assert.equal(sync.resolveCue(null, "Yes.", 1), null);
assert.equal(
  sync.resolveCue([null, { start: 1, end: 2, text: "Yes." }], "Yes.", 1.5).index,
  1,
  "entries without a cue object are skipped, not fatal",
);

// Repeated lines only resolve when the track timeline is already trusted.
const repeated = [
  { start: 10, end: 11, text: "Yeah!" },
  { start: 20, end: 21, text: "Let's go." },
  { start: 30, end: 31, text: "Yeah!" },
];

const untrustedRepeat = sync.resolveCue(repeated, "YEAH!", 30.5, {
  trustTime: false,
});
assert.equal(untrustedRepeat.cue, null, "an offset timeline must not pick a duplicate");
assert.equal(untrustedRepeat.ambiguous, true);
assert.equal(untrustedRepeat.reason, "ambiguous");
assert.equal(untrustedRepeat.resolvedBy, "none");
assert.equal(untrustedRepeat.candidateCount, 2);
assert.equal(untrustedRepeat.timeTrusted, false);

const untrustedNoTime = sync.resolveCue(repeated, "YEAH!");
assert.equal(untrustedNoTime.cue, null);
assert.equal(untrustedNoTime.ambiguous, true);

const trustedNearest = sync.resolveCue(repeated, "YEAH!", 30.5, {
  trustTime: true,
});
assert.equal(trustedNearest.index, 2);
assert.equal(trustedNearest.resolvedBy, "nearest");
assert.equal(trustedNearest.ambiguous, false);
assert.equal(trustedNearest.timeTrusted, true);

assert.equal(
  sync.resolveCue(repeated, "YEAH!", 10.2, { trustTime: true }).index,
  0,
  "the same line resolves to whichever duplicate playback is actually on",
);

// Two identical lines the same distance away are still a coin flip.
assert.equal(
  sync.resolveCue(repeated, "YEAH!", 20.5, { trustTime: true }).cue,
  null,
  "an equal-distance tie must stay unresolved even with a trusted timeline",
);
assert.equal(
  sync.resolveCue(repeated, "YEAH!", 20.5, { trustTime: true }).ambiguous,
  true,
);

const overlapping = [
  { start: 5, end: 8, text: "Wait." },
  { start: 6, end: 7, text: "Wait." },
];
const overlappingResolution = sync.resolveCue(overlapping, "Wait.", 6.5, {
  trustTime: true,
});
assert.equal(overlappingResolution.cue, null);
assert.equal(overlappingResolution.ambiguous, true);

// Two adjacent cues rendered as one block.
const joinedCues = [
  { start: 10, end: 11, text: "I don't know." },
  { start: 11, end: 12, text: "Maybe later." },
  { start: 40, end: 41, text: "I don't know." },
  { start: 41, end: 42, text: "Maybe later." },
];
const joined = sync.resolveCue(joinedCues, "I don't know. Maybe later.", 10.4, {
  trustTime: true,
});
assert.equal(joined.index, 0);
assert.equal(joined.reason, "joined");
assert.equal(joined.secondIndex, 1);
assert.equal(joined.ambiguous, false);
assert.equal(
  sync.resolveCue(joinedCues, "I don't know. Maybe later.", 40.4, {
    trustTime: true,
  }).index,
  2,
  "the joined pair nearest playback wins",
);
assert.equal(
  sync.resolveCue(joinedCues, "I don't know. Maybe later.").cue,
  null,
  "joined pairs still need a trusted timeline to choose between repeats",
);

// A join is only a fallback: a real single-cue match always wins.
const joinVsSingle = [
  { start: 1, end: 2, text: "Yes." },
  { start: 2, end: 3, text: "No." },
];
assert.equal(
  sync.resolveCue(joinVsSingle, "Yes. No.", 1.5, { trustTime: true }).reason,
  "joined",
);
assert.equal(
  sync.resolveCue(
    [...joinVsSingle, { start: 9, end: 10, text: "Yes. No." }],
    "Yes. No.",
    9.5,
    { trustTime: true },
  ).reason,
  "folded",
);

// Tier two is preferred over tier one even when tier one sits closer in time.
const tiered = [
  { start: 100, end: 101, text: "Really?" },
  { start: 1, end: 2, text: "REALLY!" },
];
const tierWins = sync.resolveCue(tiered, "Really?", 1.5, { trustTime: true });
assert.equal(tierWins.index, 0);
assert.equal(tierWins.tier, sync.MATCH_TIER.folded);

// Whatever is returned as a cue must actually be a text match.
for (const query of ["Yeah!", "YEAH!", "yeah", "Let's go.", "Let\u2019s\u00a0GO!"]) {
  for (const trustTime of [true, false]) {
    const resolution = sync.resolveCue(repeated, query, 30.5, { trustTime });
    if (!resolution?.cue) continue;
    assert.notEqual(
      sync.matchTier(resolution.cue.text, query),
      sync.MATCH_TIER.none,
      `${query} resolved to an unrelated cue`,
    );
    assert.equal(resolution.ambiguous, false);
  }
}

const previousCue = { cue: englishCues[0], index: 0 };
assert.equal(
  sync.isInterCueGapMatch(englishCues, previousCue, 923.676, null),
  true,
  "Netflix retaining the previous cue during the gap is expected",
);
assert.equal(sync.isInterCueGapMatch(englishCues, previousCue, 924.465, null), false);
assert.equal(
  sync.isInterCueGapMatch(englishCues, previousCue, 923.676, {
    cue: englishCues[1],
    index: 1,
  }),
  false,
);

// Captured documents: which one is the track LST should keep using.
const trackA = [
  { start: 10, end: 11, text: "I don't know." },
  { start: 20, end: 21, text: "Let's go." },
  { start: 30, end: 31, text: "Yeah!" },
];
const cloneTrack = (cues) => cues.map((cue) => ({ ...cue }));
const decisions = [];
const decide = (...args) => {
  const decision = sync.resolveTrackDocument(...args);
  decisions.push(decision);
  return decision;
};

const firstDocument = decide([], cloneTrack(trackA), {});
assert.equal(firstDocument.relationship, "none");
assert.equal(firstDocument.reason, "no-existing-track");
assert.equal(firstDocument.accept, true);
assert.equal(firstDocument.existingCueCount, 0);
assert.equal(firstDocument.incomingCueCount, 3);
assert.equal(decide(null, cloneTrack(trackA), {}).accept, true);

const duplicate = decide(trackA, cloneTrack(trackA), {});
assert.equal(duplicate.relationship, "equivalent");
assert.equal(duplicate.reason, "equivalent-track");
assert.equal(duplicate.accept, false);
assert.equal(duplicate.sharedCueCount, 3);
assert.equal(duplicate.incomingOnlyCueCount, 0);
assert.equal(duplicate.existingOnlyCueCount, 0);

// Re-encoding the same cues is the same track, not a new one. A signature over
// raw cue text called this a different track.
const reformatted = decide(
  trackA,
  [
    { start: 10, end: 11, text: "I don\u2019t know." },
    { start: 20, end: 21, text: "Let\u2019s\u00a0go." },
    { start: 30, end: 31, text: "Yeah!\u200b" },
  ],
  { renderedText: "Yeah!" },
);
assert.equal(reformatted.relationship, "equivalent");
assert.equal(reformatted.reason, "equivalent-track");
assert.equal(reformatted.accept, false);

// A short fragment is decided by membership, not by cue count or duration.
const fragment = decide(trackA, cloneTrack(trackA.slice(0, 2)), {
  trustExisting: true,
  renderedText: "Let's go.",
});
assert.equal(fragment.relationship, "subset");
assert.equal(fragment.reason, "already-covered");
assert.equal(fragment.accept, false);
assert.equal(fragment.incomingOnlyCueCount, 0);
assert.equal(fragment.existingOnlyCueCount, 1);
assert.equal(fragment.incomingSpanSeconds, 11);

// A document that contains the whole current track can only add cues.
const fuller = decide(
  trackA,
  [...cloneTrack(trackA), { start: 40, end: 41, text: "Brand new." }],
  { trustExisting: true, renderedText: "Let's go." },
);
assert.equal(fuller.relationship, "superset");
assert.equal(fuller.reason, "fuller-track");
assert.equal(fuller.accept, true);
assert.equal(fuller.union, true);
assert.equal(fuller.existingOnlyCueCount, 0);
assert.equal(fuller.incomingOnlyCueCount, 1);
assert.equal(fuller.incomingSpanSeconds, 31);

// A later part of the episode shares no cue and no time with the current track,
// so it cannot contradict it and is added to it.
const laterPart = decide(
  trackA,
  [{ start: 600, end: 601, text: "Later line." }],
  { trustExisting: true, renderedText: "Let's go." },
);
assert.equal(laterPart.relationship, "extension");
assert.equal(laterPart.reason, "track-extension");
assert.equal(laterPart.accept, true);
assert.equal(laterPart.union, true);
assert.equal(laterPart.sharedCueCount, 0);
assert.equal(laterPart.timeRangesOverlap, false);

// A different document covering the same time is never a candidate while the
// rendered line still belongs to the current track.
const otherTrack = [
  { start: 10, end: 11, text: "Something else." },
  { start: 20, end: 21, text: "Another line." },
];
const lineBelongsToCurrent = decide(trackA, otherTrack, {
  trustExisting: true,
  renderedText: "Let's go.",
});
assert.equal(lineBelongsToCurrent.relationship, "disjoint");
assert.equal(lineBelongsToCurrent.reason, "matches-current-track");
assert.equal(lineBelongsToCurrent.accept, false);
assert.equal(lineBelongsToCurrent.renderedMatchesExisting, true);
assert.equal(lineBelongsToCurrent.renderedMatchesIncoming, false);

const lineBelongsToIncoming = decide(trackA, otherTrack, {
  trustExisting: true,
  renderedText: "Something else.",
});
assert.equal(lineBelongsToIncoming.reason, "matches-rendered-line");
assert.equal(lineBelongsToIncoming.accept, true);
assert.equal(lineBelongsToIncoming.timeRangesOverlap, true);

const noEvidence = decide(trackA, otherTrack, { trustExisting: true });
assert.equal(noEvidence.relationship, "disjoint");
assert.equal(noEvidence.reason, "unrelated-track");
assert.equal(noEvidence.accept, false);
assert.equal(noEvidence.timeRangesOverlap, true);

const unconfirmed = decide(trackA, otherTrack, { trustExisting: false });
assert.equal(unconfirmed.reason, "unrelated-track");
assert.equal(unconfirmed.accept, true, "a track Netflix never confirmed is not protected");
assert.equal(unconfirmed.trustExisting, false);

// Same cue timing with different text is another representation of the
// timeline, not a replacement for it.
const sameTimings = decide(
  trackA,
  [
    { start: 10, end: 11, text: "I am not sure." },
    { start: 20, end: 21, text: "We should go." },
    { start: 30, end: 31, text: "Yes!" },
  ],
  { trustExisting: true },
);
assert.equal(sameTimings.relationship, "same-timeline");
assert.equal(sameTimings.reason, "same-timeline-different-text");
assert.equal(sameTimings.accept, false);
assert.equal(sameTimings.timingMatchCount, 3);

const sameTimingsUnconfirmed = decide(
  trackA,
  [
    { start: 10, end: 11, text: "I am not sure." },
    { start: 20, end: 21, text: "We should go." },
    { start: 30, end: 31, text: "Yes!" },
  ],
  { trustExisting: false },
);
assert.equal(sameTimingsUnconfirmed.accept, true);
assert.equal(sameTimingsUnconfirmed.reason, "same-timeline-different-text");
assert.equal(
  decide(
    trackA,
    [
      { start: 10, end: 11, text: "I am not sure." },
      { start: 20, end: 21, text: "We should go." },
      { start: 30, end: 31, text: "Yes!" },
    ],
    { trustExisting: true, renderedText: "I am not sure." },
  ).reason,
  "matches-rendered-line",
  "the track Netflix is rendering wins even on the same timeline",
);

// Sharing part of the track is not enough to replace the rest of it.
const partial = decide(
  trackA,
  [...cloneTrack(trackA.slice(1)), { start: 40, end: 41, text: "Extra." }],
  { trustExisting: true },
);
assert.equal(partial.relationship, "overlap");
assert.equal(partial.reason, "partial-overlap");
assert.equal(partial.accept, false);
assert.equal(partial.sharedCueCount, 2);
assert.equal(partial.incomingOnlyCueCount, 1);
assert.equal(partial.existingOnlyCueCount, 1);

const emptyDocument = decide(trackA, [], { trustExisting: true });
assert.equal(emptyDocument.relationship, "subset");
assert.equal(emptyDocument.accept, false);

const noisy = decide([null, ...trackA], [undefined, ...cloneTrack(trackA)], {});
assert.equal(noisy.relationship, "equivalent", "entries without a cue are ignored");

// Whatever is accepted, a confirmed track's cues are only dropped when the
// document holds the line Netflix is rendering: a document is never adopted by
// quietly losing cues, and an undecided document keeps the track.
for (const decision of decisions) {
  if (decision.accept && decision.union) continue;
  if (!decision.accept || !decision.existingOnlyCueCount) continue;
  assert.ok(
    decision.reason === "matches-rendered-line" ||
      decision.trustExisting === false,
    `${decision.reason} accepted lost cues from a confirmed track`,
  );
}
for (const decision of decisions) {
  if (!decision.accept) continue;
  assert.notEqual(decision.relationship, "unknown");
  assert.equal(Boolean(decision.reason), true);
}

// Adoption keeps the current track's own cue objects for lines both documents
// already agree on, so cache keys and stored translations stay valid.
const adopted = sync.adoptTrackDocument(trackA, [
  { start: 10, end: 11, text: "I don\u2019t know." },
  { start: 20, end: 21, text: "Let\u2019s\u00a0go." },
  { start: 30, end: 31, text: "Yeah!\u200b" },
  { start: 40, end: 41, text: "Brand new." },
]);
assert.equal(adopted.length, 4);
assert.equal(adopted[0], trackA[0]);
assert.equal(adopted[1], trackA[1]);
assert.equal(adopted[2], trackA[2]);
assert.equal(adopted[3].text, "Brand new.");

const unionLater = sync.adoptTrackDocument(
  trackA,
  [{ start: 600, end: 601, text: "Later line." }],
  { union: true },
);
assert.equal(unionLater.length, 4);
assert.equal(unionLater[0], trackA[0]);
assert.equal(unionLater[3].text, "Later line.");
assert.deepEqual(
  Array.from(unionLater, (cue) => cue.start),
  [10, 20, 30, 600],
);

const unionEarlier = sync.adoptTrackDocument(
  trackA,
  [{ start: 1, end: 2, text: "Earlier line." }],
  { union: true },
);
assert.deepEqual(
  Array.from(unionEarlier, (cue) => cue.start),
  [1, 10, 20, 30],
);

const replaced = sync.adoptTrackDocument(trackA, otherTrack);
assert.equal(replaced.length, 2, "without a union the incoming document stands alone");
assert.equal(replaced[0].text, "Something else.");

// content.js must route its Netflix-line identity through that helper.
const contentSource = await fs.readFile(
  new URL("../content.js", import.meta.url),
  "utf8",
);
assert.match(contentSource, /LSTSubtitleSync/);
assert.match(contentSource, /api\.resolveCue\(cues, text, expectedTime, \{/);
assert.match(contentSource, /trustTime: timedTrackSyncState === "verified"/);
assert.doesNotMatch(
  contentSource,
  /findUniqueCueMatchingSimplifiedText|findUniqueSimplifiedCue/,
  "the global-uniqueness match must be gone",
);
assert.match(
  contentSource,
  /api\.resolveTrackDocument\(existingCues, incomingCues, \{/,
  "captured documents must be classified by the matching module",
);
assert.match(contentSource, /trustExisting: timedTrackSyncState === "verified"/);
assert.match(contentSource, /"subtitle-track-kept"/);
assert.doesNotMatch(
  contentSource,
  /cueTrackSignature|cueListSpan|cueListContainsText|looksLikeFragment/,
  "the cue-count and duration ratios must be gone",
);
assert.doesNotMatch(contentSource, /equivalent-subtitle-track-ignored/);
assert.match(
  contentSource,
  /bindQuickPills[\s\S]*scheduleQuickPillsMinimize\(\);[\s\S]*function setQuickPillsCompact/,
  "the control pill must arm its idle timer before the first pointer interaction",
);
assert.match(
  contentSource,
  /!compact \|\| important/,
  "compact controls must keep only warning and error status messages visible",
);
assert.match(
  contentSource,
  /described\.tone !== "warn"/,
  "compact controls must hide non-warning show notices",
);

// Layer 2 — the same decisions driven through the real content script.

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
    append(...children) {
      for (const child of children) node.appendChild(child);
    },
    replaceChildren(...children) {
      node.children = children;
      node.childElementCount = children.length;
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CUE_TRACK = [
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
].join("\n");

// One harness, two services. `site` decides which page the harness stands on,
// which changes how the caption DOM is shaped and which adapter answers.
const HARNESS_SITES = {
  netflix: {
    href: "https://www.netflix.com/watch/80100172",
    host: "www.netflix.com",
    pathname: "/watch/80100172",
    origin: "https://www.netflix.com",
    captionUrl: "https://www.netflix.com/subtitle.vtt",
  },
  primevideo: {
    href: "https://www.amazon.co.jp/-/en/gp/video/detail/B0B6GZ954Y",
    host: "www.amazon.co.jp",
    pathname: "/-/en/gp/video/detail/B0B6GZ954Y",
    origin: "https://www.amazon.co.jp",
    captionUrl: "https://aiv-cdn.net/ttml/B0B6GZ954Y.ttml",
  },
};

function createHarness(vtt = CUE_TRACK, { site = "netflix", settings = {} } = {}) {
  const harnessSite = HARNESS_SITES[site];
  const netflix = { text: "" };
  // Prime Video reuses a single caption span and rewrites its text in place, so
  // the harness holds exactly one element and never replaces it.
  const primeSpan = { innerText: "", textContent: "" };
  const primeSpans = site === "primevideo" ? [primeSpan] : [];
  const primePlayer = { innerText: "", textContent: "" };
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
  const animationFrames = [];
  const windowListeners = new Map();
  let importedTrack = null;
  let jimakuFinding = null;
  let cachedCueIndexes = [];
  const jimakuAskedShowKeys = [];
  let pageMessageHandler = null;
  const documentElement = createElementStub("html");
  const document = {
    documentElement,
    // A page's own title is how the show is named when no title element is on
    // screen, so a test that cares about the show sets one.
    title: "",
    body: createElementStub("body"),
    head: createElementStub("head"),
    fullscreenElement: null,
    createElement: (tagName) => createElementStub(tagName),
    createDocumentFragment: () => createElementStub("#fragment"),
    addEventListener() {},
    removeEventListener() {},
    querySelector(selector) {
      if (selector === "video") return video;
      // Prime Video's player container is what marks the player as mounted.
      if (selector === ".atvwebplayersdk-player-container") {
        return site === "primevideo" ? primePlayer : null;
      }
      if (selector === ".player-timedtext") {
        return netflix.text
          ? {
              innerText: netflix.text,
              textContent: netflix.text,
            }
          : null;
      }
      return null;
    },
    querySelectorAll(selector) {
      // The adapter selects the element the viewer is watching from this list,
      // and reads Prime Video's captions one span at a time.
      if (selector === "video") return [video];
      if (selector === ".atvwebplayersdk-captions-text") return primeSpans;
      return [];
    },
  };
  class MutationObserverStub {
    observe() {}
    disconnect() {}
  }
  // Keep content.js console noise out of the suite output, but surface it on demand.
  const consoleMessages = [];
  const quietConsole = {
    log: (...args) => consoleMessages.push(args),
    info: (...args) => consoleMessages.push(args),
    warn: (...args) => consoleMessages.push(args),
    error: (...args) => consoleMessages.push(args),
  };
  const context = vm.createContext({
    document,
    location: {
      href: harnessSite.href,
      host: harnessSite.host,
      pathname: harnessSite.pathname,
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
      // Frames are queued rather than dropped so a test can step the playback
      // loop; nothing runs until a test asks for a frame.
      animationFrames.push(callback);
      return animationFrames.length;
    },
    cancelAnimationFrame() {},
    MutationObserver: MutationObserverStub,
    fetch: async () => ({
      ok: false,
      status: 404,
      async text() {
        return "";
      },
    }),
    browser: {
      runtime: {
        onMessage: {
          addListener(handler) {
            pageMessageHandler = handler;
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
                // Synchronization cases exercise the translation path without
                // making a claim about the fixture's language. Cases about
                // same-language suppression choose a known target explicitly.
                targetLanguage: "Test Language",
                showDebugPanel: false,
                ...settings,
              },
            });
          }
          if (message?.type === "GET_IMPORTED_TRACK") {
            // Only the episode the test imported for has a track.
            const track =
              importedTrack && importedTrack.episodeKey === message.episodeKey
                ? importedTrack
                : null;
            return Promise.resolve({
              ok: true,
              track,
              reason: track ? "ok" : "not-imported",
            });
          }
          if (message?.type === "GET_JIMAKU_FINDING") {
            // What the background would answer: the note for the show that was
            // asked about, and nothing for a show nobody asked about. The key is
            // recorded so a test can see which show was asked about, and that the
            // player asked about it at all.
            jimakuAskedShowKeys.push(message.showKey);
            const note =
              jimakuFinding && message.showKey
                ? { ...jimakuFinding, showKey: message.showKey }
                : null;
            return Promise.resolve({
              ok: true,
              finding: note,
              reason: note ? "ok" : "no-finding-yet",
            });
          }
          if (message?.type === "CACHE_GET") {
            // What the background would answer about this episode's cache. A
            // test names the cues by their position in the track rather than by
            // key, so it can say which part of an episode is cached without
            // knowing how cue identity is spelled.
            const keys = message.keys || [];
            const entries = {};
            for (const index of cachedCueIndexes) {
              if (keys[index]) entries[keys[index]] = `translated ${index + 1}`;
            }
            return Promise.resolve({ ok: true, entries, cues: [] });
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
  // content.js compares event.source against the page window, so expose the vm's
  // own global object as `window` and dispatch with that exact reference.
  const windowRef = vm.runInContext(
    "globalThis.window = globalThis",
    context,
  );

  vm.runInContext(playbackSiteSource, context, {
    filename: "playback-site.js",
  });
  vm.runInContext(episodeIdentitySource, context, {
    filename: "episode-identity.js",
  });
  vm.runInContext(subtitleImportSource, context, {
    filename: "subtitle-import.js",
  });
  vm.runInContext(syncSource, context, { filename: "subtitle-sync.js" });
  vm.runInContext(translationContextSource, context, {
    filename: "translation-context.js",
  });
  vm.runInContext(coordinatorSource, context, {
    filename: "translation-coordinator.js",
  });
  vm.runInContext(contentSource, context, { filename: "content.js" });

  const debugEvents = () => {
    const events = [];
    for (const message of sentMessages) {
      if (message?.type === "APPEND_DEBUG_EVENTS") events.push(...message.events);
    }
    return events;
  };
  const eventsNamed = (name) => debugEvents().filter((event) => event.event === name);
  const fallbackTicker = () => intervals.find((entry) => entry.ms === 350)?.callback;

  const elementById = (id) => {
    const stack = [documentElement];
    while (stack.length) {
      const node = stack.pop();
      if (node.id === id) return node;
      stack.push(...(node.children || []));
    }
    return null;
  };
  // The pill is built by one `innerHTML` assignment, and the element stub answers
  // a selector lookup with a stub of its own rather than by parsing that markup,
  // so a part of the pill is reached the way content.js reaches it. Reading only
  // the cache means an assertion that the part exists also asserts that
  // content.js asked for it.
  const pillPart = (selector) =>
    elementById("lst-quick-pills")?.queryCache?.get(selector) || null;

  return {
    site,
    document,
    video,
    sentMessages,
    consoleMessages,
    elementById,
    pillPart,
    eventsNamed,
    debugEvents,
    translationRequests() {
      return sentMessages
        .filter((message) => message?.type === "TRANSLATE_BATCH")
        .flatMap((message) => (message.items || []).map((item) => item.text));
    },
    dispatchDocument(payload) {
      const documentMessage = windowListeners.get("message");
      assert.ok(documentMessage, "content.js should listen for captured subtitles");
      documentMessage({
        source: windowRef,
        data: {
          source: "lst-local-subtitle-translate",
          type: "SUBTITLE_DOCUMENT",
          payload,
        },
      });
    },
    setRenderedText(text) {
      netflix.text = text;
    },
    // The overlay as the viewer sees it, with the two layers kept apart. The
    // element stub answers a selector lookup with an element it keeps in its own
    // cache rather than in `children`, and the overlay's subtitle stack is
    // reached exactly that way, so both are walked.
    overlayTexts() {
      const found = { original: [], translated: [] };
      const seen = new Set();
      const stack = [documentElement];
      while (stack.length) {
        const node = stack.pop();
        if (!node || seen.has(node)) continue;
        seen.add(node);
        if (node.className === "lst-subtitle-original") {
          found.original.push(node.textContent);
        }
        if (node.className === "lst-subtitle-translated") {
          found.translated.push(node.textContent);
        }
        stack.push(...(node.children || []));
        if (node.queryCache) stack.push(...node.queryCache.values());
      }
      return found;
    },
    // Step the playback loop once at a playback time. The loop re-queues itself,
    // so each call is exactly one iteration and the test stays deterministic.
    async frame(videoTime) {
      if (videoTime !== undefined) video.currentTime = videoTime;
      const pending = animationFrames.splice(0, animationFrames.length);
      for (const callback of pending) callback();
      for (let i = 0; i < 16; i++) await Promise.resolve();
      await sleep(20);
      for (let i = 0; i < 16; i++) await Promise.resolve();
    },
    // content.js buffers diagnostics for half a second before flushing them.
    async flushDiagnostics() {
      await sleep(600);
      for (let i = 0; i < 16; i++) await Promise.resolve();
    },
    // What the background would answer for this episode's import.
    setImportedTrack(track) {
      importedTrack = track;
    },
    // Which cues of the episode are already translated and cached, by their
    // position in the track.
    setCachedCueIndexes(indexes) {
      cachedCueIndexes = [...indexes];
    },
    // The show this page is about, as its own document title words it.
    setTitle(text) {
      document.title = text;
    },
    // What Jimaku held for the show, as the background remembers it.
    setJimakuFinding(finding) {
      jimakuFinding = finding;
    },
    jimakuAskedShowKeys() {
      return [...jimakuAskedShowKeys];
    },
    // Every message the player sent the background, so a test can say what
    // arriving at an episode did and did not ask for.
    sentMessageTypes() {
      return sentMessages.map((message) => message?.type).filter(Boolean);
    },
    // Which cache the player is reading and writing translations under. Two
    // episodes of one series must be two of these, however the service spells
    // its URLs.
    cacheIds() {
      return [
        ...new Set(
          sentMessages
            .filter(
              (message) =>
                message?.type === "CACHE_GET" || message?.type === "CACHE_SET",
            )
            .map((message) => message.cacheId)
            .filter(Boolean),
        ),
      ];
    },
    // The listing the page world read for the episode being played. It is what
    // names the episode on a page whose URL does not move, and it arrives before
    // the episode plays.
    async identity(payload) {
      const handler = windowListeners.get("message");
      assert.ok(handler, "content.js should listen for captured subtitles");
      handler({
        source: windowRef,
        data: {
          source: "lst-local-subtitle-translate",
          type: "EPISODE_IDENTITY",
          payload: { site, ...payload },
        },
      });
      for (let i = 0; i < 12; i++) await Promise.resolve();
      await sleep(20);
      for (let i = 0; i < 12; i++) await Promise.resolve();
    },
    // A message from the extension's own pages, answered by content.js.
    async pageMessage(message) {
      let response;
      pageMessageHandler(message, {}, (value) => {
        response = value;
      });
      for (let i = 0; i < 16; i++) await Promise.resolve();
      await sleep(20);
      for (let i = 0; i < 16; i++) await Promise.resolve();
      return response;
    },
    // A second captured document for the same playback session.
    async capture(vtt, options = {}) {
      if (options.renderedText !== undefined) netflix.text = options.renderedText;
      if (options.pathname) {
        // Site detection is keyed on the URL, so a route change has to move the
        // whole URL, exactly as the browser does.
        context.location.pathname = options.pathname;
        context.location.href = `${harnessSite.origin}${options.pathname}`;
      }
      const handler = windowListeners.get("message");
      assert.ok(handler, "content.js should listen for captured subtitles");
      handler({
        source: windowRef,
        data: {
          source: "lst-local-subtitle-translate",
          type: "SUBTITLE_DOCUMENT",
          payload: {
            url: options.url || "https://www.netflix.com/subtitle.vtt",
            text: vtt,
          },
        },
      });
      // The route can also change a moment *after* the document is handed over,
      // which is what a service does when it asks for the next episode's assets
      // before it moves the URL.
      if (options.pathnameAfter) {
        context.location.pathname = options.pathnameAfter;
        context.location.href = `${harnessSite.origin}${options.pathnameAfter}`;
      }
      for (let i = 0; i < 12; i++) await Promise.resolve();
      // content.js buffers diagnostics for half a second before flushing them.
      await sleep(560);
      for (let i = 0; i < 12; i++) await Promise.resolve();
    },
    async start({ captureTrack = true } = {}) {
      // content.js starts playback itself on a watch page, and starting playback
      // includes asking the background whether this episode has an imported
      // track. Both settle here, before the first frame a test asks for.
      for (let i = 0; i < 32; i++) await Promise.resolve();
      const documentMessage = windowListeners.get("message");
      assert.ok(documentMessage, "content.js should listen for captured subtitles");
      if (!captureTrack) {
        // Prime Video ships realtime-only until its timed text is proven
        // capturable, so its harness starts with no captured track.
        return;
      }
      documentMessage({
        source: windowRef,
        data: {
          source: "lst-local-subtitle-translate",
          type: "SUBTITLE_DOCUMENT",
          payload: {
            url: harnessSite.captionUrl,
            text: vtt,
            site,
          },
        },
      });
      for (let i = 0; i < 8; i++) await Promise.resolve();
      if (process.env.LST_TEST_DEBUG) {
        console.error(
          "messages after dispatch:",
          JSON.stringify(sentMessages.map((message) => message?.type)),
        );
      }
    },
    async show(text, videoTime) {
      if (primeSpans.length) {
        // One element, rewritten in place: no new node marks the new cue.
        primeSpan.innerText = text;
        primeSpan.textContent = text;
      } else {
        netflix.text = text;
      }
      video.currentTime = videoTime;
      const tick = fallbackTicker();
      assert.ok(tick, "the fallback subtitle poll should be running");
      tick();
      await sleep(120);
      tick();
      await sleep(700);
      if (process.env.LST_TEST_DEBUG) {
        console.error(
          JSON.stringify(
            debugEvents().map((event) => ({
              event: event.event,
              cue: event.cue,
              details: event.details,
            })),
            null,
            2,
          ),
        );
      }
    },
  };
}

// The captured track keeps working when Netflix renders the same line with
// different typography instead of byte-identical text.
{
  const harness = createHarness();
  await harness.start();
  await harness.show("I don\u2019t know.", 10.4);
  assert.equal(
    harness.eventsNamed("timed-track-mismatch-started").length,
    0,
    "a typographic-only difference must not be a mismatch",
  );
  assert.equal(harness.eventsNamed("timed-track-mismatch-confirmed").length, 0);
  assert.equal(
    harness.eventsNamed("formatting-match-accepted").length,
    0,
    "a folded match is not a formatting fallback",
  );
}

const REPEATED_LINE_TRACK = [
  "WEBVTT",
  "",
  "00:00:10.000 --> 00:00:11.000",
  "Yeah!",
  "",
  "00:00:20.000 --> 00:00:21.000",
  "Let's go.",
  "",
  "00:00:30.000 --> 00:00:31.000",
  "Yeah!",
  "",
].join("\n");

// A repeated line on a verified track resolves by time instead of being dropped
// to the DOM fallback, and says how it decided.
{
  const harness = createHarness(REPEATED_LINE_TRACK);
  await harness.start();
  await harness.show("Yeah!", 30.4);
  assert.equal(harness.eventsNamed("timed-track-mismatch-started").length, 0);

  await harness.show("YEAH\u2026", 30.4);
  const accepted = harness.eventsNamed("formatting-match-accepted");
  assert.equal(accepted.length, 1, "the formatting match should be reported once");
  const [acceptedEvent] = accepted;
  assert.equal(acceptedEvent.details.matchQuality, "loose");
  assert.equal(acceptedEvent.details.matchReason, "loose");
  assert.equal(acceptedEvent.details.matchResolvedBy, "nearest");
  assert.equal(acceptedEvent.details.matchAmbiguous, false);
  assert.equal(acceptedEvent.details.matchTimeTrusted, true);
  assert.equal(acceptedEvent.details.matchCandidateCount, 2);
  assert.equal(harness.eventsNamed("timed-track-mismatch-confirmed").length, 0);
}

const ADJACENT_TRACK = [
  "WEBVTT",
  "",
  "00:00:10.000 --> 00:00:11.000",
  "I don't know.",
  "",
  "00:00:11.000 --> 00:00:12.000",
  "Maybe later.",
  "",
  "00:00:30.000 --> 00:00:31.000",
  "Let's go.",
  "",
].join("\n");

// Two adjacent cues rendered as a single Netflix block are still the timed track.
{
  const harness = createHarness(ADJACENT_TRACK);
  await harness.start();
  await harness.show("I don't know. Maybe later.", 10.2);
  const accepted = harness.eventsNamed("formatting-match-accepted");
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].details.matchReason, "joined");
  assert.equal(accepted[0].details.matchQuality, "joined");
  assert.equal(accepted[0].details.matchJoinedWith, 1);
  assert.equal(harness.eventsNamed("timed-track-mismatch-confirmed").length, 0);
}

// An unverified timeline with a repeated line must not be anchored by a guess.
{
  const harness = createHarness(REPEATED_LINE_TRACK);
  await harness.start();
  await harness.show("YEAH\u2026", 30.4);
  assert.equal(
    harness.eventsNamed("timed-track-anchored").length,
    0,
    "a duplicated line must not set the automatic timing offset",
  );
  const confirmed = harness.eventsNamed("timed-track-mismatch-confirmed");
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].details.matchAmbiguous, true);
  assert.equal(confirmed[0].details.matchCandidateCount, 2);
  assert.equal(confirmed[0].details.matchTimeTrusted, false);
  assert.equal(confirmed[0].details.matchQuality, "none");
}

// The unique-line anchor path still works exactly as before.
{
  const harness = createHarness();
  await harness.start();
  await harness.show("Let's go.", 300.4);
  const anchored = harness.eventsNamed("timed-track-anchored");
  assert.equal(anchored.length, 1);
  assert.equal(anchored[0].details.matchQuality, "exact");
  assert.equal(anchored[0].details.matchReason, "folded");
  assert.equal(anchored[0].details.matchResolvedBy, "unique");
  assert.equal(anchored[0].details.matchCandidateCount, 1);
}

// A track document that only differs in how the same lines were encoded.
const REFORMATTED_TRACK = [
  "WEBVTT",
  "",
  "00:00:10.000 --> 00:00:11.000",
  "I don\u2019t know.",
  "",
  "00:00:20.000 --> 00:00:21.000",
  "Let\u2019s go.",
  "",
  "00:00:30.000 --> 00:00:31.000",
  "Yeah!\u200b",
  "",
].join("\n");

const FRAGMENT_TRACK = [
  "WEBVTT",
  "",
  "00:00:10.000 --> 00:00:11.000",
  "I don't know.",
  "",
  "00:00:20.000 --> 00:00:21.000",
  "Let's go.",
  "",
].join("\n");

const FULLER_REFORMATTED_TRACK = [
  "WEBVTT",
  "",
  "00:00:10.000 --> 00:00:11.000",
  "I don\u2019t know.",
  "",
  "00:00:20.000 --> 00:00:21.000",
  "Let\u2019s go.",
  "",
  "00:00:30.000 --> 00:00:31.000",
  "Yeah!\u200b",
  "",
  "00:00:40.000 --> 00:00:41.000",
  "Brand new.",
  "",
].join("\n");

const LATER_TRACK = [
  "WEBVTT",
  "",
  "00:10:00.000 --> 00:10:01.000",
  "Later line.",
  "",
].join("\n");

const UNRELATED_TRACK = [
  "WEBVTT",
  "",
  "00:00:10.000 --> 00:00:11.000",
  "Something else.",
  "",
  "00:00:20.000 --> 00:00:21.000",
  "Another line.",
  "",
].join("\n");

// The episode the service moves to next: its own lines on its own timeline, which
// is what a document for the episode being switched to looks like.
const NEXT_EPISODE_TRACK = [
  "WEBVTT",
  "",
  "00:00:05.000 --> 00:00:06.000",
  "Next episode line.",
  "",
  "00:00:15.000 --> 00:00:16.000",
  "Another next line.",
  "",
].join("\n");

// Re-encoding the same lines must not be treated as a new track: the captured
// track, its synchronization state, and its cache keys all stay in place.
{
  const harness = createHarness();
  await harness.start();

  await harness.capture(REFORMATTED_TRACK);

  const kept = harness.eventsNamed("subtitle-track-kept");
  assert.equal(kept.length, 1, "the re-encoded document should be reported once");
  assert.equal(kept[0].details.trackDecision, "keep");
  assert.equal(kept[0].details.trackRelationship, "equivalent");
  assert.equal(kept[0].details.trackReason, "equivalent-track");
  assert.equal(kept[0].details.trackSharedCueCount, 3);
  assert.equal(
    harness.eventsNamed("subtitle-track-accepted").length,
    1,
    "a re-encoded re-fetch must not re-adopt the track",
  );
}

// A fragment of the current track cannot displace a track Netflix has already
// confirmed, whatever its cue count.
{
  const harness = createHarness();
  await harness.start();
  await harness.show("Let's go.", 300.4);
  assert.equal(harness.eventsNamed("timed-track-anchored").length, 1);

  await harness.capture(FRAGMENT_TRACK, {
    renderedText: "Let's go.",
    url: "https://www.netflix.com/timedtext?o=2",
  });

  const kept = harness.eventsNamed("subtitle-track-kept");
  assert.equal(kept.length, 1);
  assert.equal(kept[0].details.trackDecision, "keep");
  assert.equal(kept[0].details.trackRelationship, "subset");
  assert.equal(kept[0].details.trackReason, "already-covered");
  assert.equal(kept[0].details.trackCurrentTrusted, true);
  assert.equal(kept[0].details.trackCurrentCueCount, 3);
  assert.equal(kept[0].details.trackIncomingCueCount, 2);
  assert.equal(kept[0].details.trackIncomingOnlyCueCount, 0);
  assert.equal(
    harness.eventsNamed("subtitle-track-accepted").length,
    1,
    "a fragment must not become the track",
  );
}

// A part of the episode the current track does not cover is added to it rather
// than replacing it.
{
  const harness = createHarness();
  await harness.start();
  await harness.show("Let's go.", 300.4);

  await harness.capture(LATER_TRACK, { renderedText: "Let's go." });

  const accepted = harness.eventsNamed("subtitle-track-accepted");
  assert.equal(accepted.length, 2);
  assert.equal(accepted[1].details.trackRelationship, "extension");
  assert.equal(accepted[1].details.trackReason, "track-extension");
  assert.equal(accepted[1].details.cueCount, 4);
  assert.equal(accepted[1].details.firstCueStartMs, 10000);
  assert.equal(accepted[1].details.lastCueEndMs, 601000);
  assert.equal(accepted[1].details.trackUnion, true);
  assert.equal(
    accepted[1].details.trackCurrentOnlyCueCount,
    3,
    "the current track's cues are all kept by the union",
  );

  // The synchronization the current track already established still holds, so
  // playback does not have to anchor the episode a second time.
  await harness.show("Let's go.", 300.4);
  assert.equal(
    harness.eventsNamed("timed-track-anchored").length,
    1,
    "a document that keeps every current cue must not unresolve the timeline",
  );
}

// A fuller capture is adopted, and the lines it already knew keep the cue
// objects the cache keys were built from.
{
  const harness = createHarness();
  await harness.start();

  await harness.capture(FULLER_REFORMATTED_TRACK);

  const accepted = harness.eventsNamed("subtitle-track-accepted");
  assert.equal(accepted.length, 2);
  const [upgrade] = accepted.slice(1);
  assert.equal(upgrade.details.trackRelationship, "superset");
  assert.equal(upgrade.details.trackReason, "fuller-track");
  assert.equal(upgrade.details.cueCount, 4);
  assert.equal(upgrade.details.trackIncomingOnlyCueCount, 1);
  assert.equal(upgrade.details.trackCurrentOnlyCueCount, 0);

  const reconcile = harness.sentMessages
    .filter((message) => message?.type === "CACHE_RECONCILE_FALLBACK")
    .at(-1);
  assert.equal(reconcile.timedCues.length, 4);
  assert.match(
    reconcile.timedCues[0].key,
    /I don't know\.$/,
    "the known cue object should be reused so its cache key stays valid",
  );
  assert.equal(reconcile.timedCues[1].sourceText, "Let's go.");
  assert.equal(reconcile.timedCues[3].sourceText, "Brand new.");
}

// A different document for the same time range is kept out while Netflix is
// rendering a line the current track knows.
{
  const harness = createHarness();
  await harness.start();
  await harness.show("Let's go.", 300.4);

  await harness.capture(UNRELATED_TRACK, { renderedText: "Let's go." });

  const kept = harness.eventsNamed("subtitle-track-kept");
  assert.equal(kept.length, 1);
  assert.equal(kept[0].details.trackRelationship, "disjoint");
  assert.equal(kept[0].details.trackReason, "matches-current-track");
  assert.equal(kept[0].details.renderedLineInCurrent, true);
  assert.equal(kept[0].details.trackTimeRangesOverlap, true);
  assert.equal(harness.eventsNamed("subtitle-track-accepted").length, 1);
}

// The same document is adopted when the line Netflix renders belongs to it, and
// when the current track has never been confirmed at all.
{
  const byRenderedLine = createHarness();
  await byRenderedLine.start();
  await byRenderedLine.show("Let's go.", 300.4);
  await byRenderedLine.capture(UNRELATED_TRACK, {
    renderedText: "Something else.",
  });
  const accepted = byRenderedLine.eventsNamed("subtitle-track-accepted");
  assert.equal(accepted.length, 2);
  assert.equal(accepted[1].details.trackReason, "matches-rendered-line");

  const unconfirmed = createHarness();
  await unconfirmed.start();
  await unconfirmed.capture(UNRELATED_TRACK, { renderedText: "" });
  const replaced = unconfirmed.eventsNamed("subtitle-track-accepted");
  assert.equal(replaced.length, 2);
  assert.equal(replaced[1].details.trackDecision, "accept");
  assert.equal(replaced[1].details.trackReason, "unrelated-track");
  assert.equal(replaced[1].details.trackCurrentTrusted, false);
}

// Changing episode still adopts the new track without any of the old one.
{
  const harness = createHarness();
  await harness.start();
  await harness.show("Let's go.", 300.4);

  await harness.capture(UNRELATED_TRACK, {
    pathname: "/watch/80100173",
    renderedText: "Let's go.",
  });

  const accepted = harness.eventsNamed("subtitle-track-accepted");
  assert.equal(accepted.length, 2);
  assert.equal(accepted[1].details.trackRelationship, "none");
  assert.equal(accepted[1].details.trackReason, "no-existing-track");
}

// Two episodes of one series watched through one URL are two episodes of the
// show: two names and two caches. A Prime Video detail page can keep the series
// in its path while the player advances to the next episode inside it, so the URL
// names the series on every episode and the listing is the only thing that names
// the episode. This is the report the case exists for — a cache list that showed
// one episode of a show the viewer had watched several of, named after the page's
// own title with the season glued on and the video id standing in for the
// episode's name — and it is also what makes `episode-changed` fire on a URL that
// never moves.
const PRIME_EP1 = "amzn1.dv.gti.e4b2f72f-8a6e-405e-44fe-bedba416d622";
const PRIME_EP2 = "amzn1.dv.gti.7c1a44de-2b9f-4c22-8a11-6f0d5b2c9e77";
{
  const harness = createHarness(CUE_TRACK, { site: "primevideo" });
  // The listing is asked for before the episode plays, so it answers first.
  await harness.identity({
    reason: "catalog-metadata",
    videoId: PRIME_EP1,
    videoIdSource: "catalog-id",
    showName: "機動戦士ガンダム 水星の魔女 シーズン1",
    episodeNumber: 1,
    seasonNumber: 1,
    title: "第1話",
    episodic: true,
  });
  await harness.start();
  await harness.show("Let's go.", 20.4);
  // The captured track is what translates the line when it is confirmed, so the
  // playback loop is what a test steps to see a translation.
  await harness.frame(20.4);

  let status = (await harness.pageMessage({ type: "GET_PAGE_STATUS" })).status;
  assert.equal(
    status.showName,
    "機動戦士ガンダム 水星の魔女",
    "the season is what a later page calls the show, not part of its name",
  );
  assert.equal(status.episodeName, "Episode 1 · 第1話", "the episode has a name of its own");
  assert.equal(status.episodeNumber, 1);
  assert.equal(status.videoId, PRIME_EP1, "the episode is identified by the listing");

  assert.ok(
    harness.translationRequests().includes("Let's go."),
    "the line the player drew is translated",
  );
  const firstEpisodeCaches = harness.cacheIds();
  assert.equal(firstEpisodeCaches.length, 1);
  assert.ok(
    firstEpisodeCaches[0].includes(PRIME_EP1),
    `expected the episode's own id, got ${firstEpisodeCaches[0]}`,
  );
  assert.ok(
    !firstEpisodeCaches[0].includes("B0B6GZ954Y"),
    "the series the URL names is not the episode",
  );
  // Only kinds and reasons reach the event log, never the names a service gave.
  const listed = harness.eventsNamed("episode-identity-from-listing");
  assert.equal(listed.length, 1, "the listing's answer is recorded once");
  assert.equal(listed[0].details.reason, "catalog-metadata");
  assert.equal(listed[0].details.episodeNumber, 1);
  assert.equal(listed[0].details.namesPage, false, "the listing's id is not the URL's id");
  assert.ok(!JSON.stringify(listed).includes("水星"), "the log carries no names");

  // The next episode: the URL still names the series, and the listing is what
  // says this is a different episode.
  harness.setTitle("Amazon.co.jp: 機動戦士ガンダム 水星の魔女 シーズン2 : Prime Video");
  await harness.identity({
    reason: "catalog-metadata",
    videoId: PRIME_EP2,
    videoIdSource: "catalog-id",
    showName: "機動戦士ガンダム 水星の魔女 シーズン2",
    episodeNumber: 1,
    seasonNumber: 2,
    title: "第1話",
    episodic: true,
  });
  assert.equal(harness.eventsNamed("episode-changed").length, 0, "not until a frame runs");

  await harness.frame(1);
  await harness.flushDiagnostics();
  assert.equal(
    harness.eventsNamed("episode-changed").length,
    1,
    "the next episode is noticed although the URL never moved",
  );

  await harness.capture(NEXT_EPISODE_TRACK, {
    url: "https://aiv-cdn.net/ttml/B0B6GZ954Y.s2.ja.ttml",
  });
  const accepted = harness.eventsNamed("subtitle-track-accepted").at(-1);
  assert.equal(accepted.details.trackReason, "no-existing-track");

  await harness.show("Next episode line.", 5.4);
  await harness.frame(5.4);
  assert.ok(harness.translationRequests().includes("Next episode line."));

  const caches = harness.cacheIds();
  assert.equal(caches.length, 2, "two episodes of one series are two caches");
  assert.ok(
    caches.some((cacheId) => cacheId.includes(PRIME_EP1)),
    `expected a cache for the first episode, got ${caches.join(", ")}`,
  );
  assert.ok(caches.some((cacheId) => cacheId.includes(PRIME_EP2)));

  status = (await harness.pageMessage({ type: "GET_PAGE_STATUS" })).status;
  assert.equal(status.showName, "機動戦士ガンダム 水星の魔女", "one show, however many seasons");
  assert.equal(status.episodeName, "Episode 1 · 第1話");
  assert.equal(status.videoId, PRIME_EP2);
}

// A page that states no episode but glues the season onto the show's own name is
// named by the show alone, and a name the listing stated outranks the page title
// the viewer happens to be looking at.
{
  const harness = createHarness(CUE_TRACK, { site: "primevideo" });
  harness.setTitle("Amazon.co.jp: 機動戦士ガンダム 水星の魔女 シーズン1 : Prime Video");
  await harness.start();
  await harness.show("Let's go.", 20.4);
  await harness.frame(20.4);

  let status = (await harness.pageMessage({ type: "GET_PAGE_STATUS" })).status;
  assert.equal(status.showName, "機動戦士ガンダム 水星の魔女");
  assert.equal(
    status.videoId,
    "B0B6GZ954Y",
    "with no listing there is nothing better than the URL",
  );

  await harness.identity({
    reason: "catalog-metadata",
    videoId: PRIME_EP1,
    videoIdSource: "catalog-id",
    showName: "Homeland",
    episodeNumber: 1,
    title: "The Smile",
    episodic: true,
  });
  await harness.frame(1);
  await harness.flushDiagnostics();
  status = (await harness.pageMessage({ type: "GET_PAGE_STATUS" })).status;
  assert.equal(
    status.showName,
    "Homeland",
    "the service's own catalog is not overruled by the document title",
  );
  assert.equal(status.episodeName, "Episode 1 · The Smile");
}

// A service can ask for the next episode's assets while the viewer is still on
// the previous episode's URL, so the document arrives before LST can see the
// route change and is judged against the track that is still loaded. The request
// is made once and never repeated, so that document is the only copy LST will
// get: it is held rather than dropped, and the episode change adopts it.
{
  const harness = createHarness(CUE_TRACK, { site: "primevideo" });
  await harness.start();
  await harness.show("Let's go.", 20.4);

  await harness.capture(NEXT_EPISODE_TRACK, {
    url: "https://aiv-cdn.net/ttml/B0B6GZ954Z.ttml",
    pathnameAfter: "/-/en/gp/video/detail/B0B6GZ954Z",
  });

  const kept = harness.eventsNamed("subtitle-track-kept");
  assert.equal(
    kept.length,
    1,
    "the next episode's document arrives while the old track is still loaded",
  );
  assert.equal(kept[0].details.trackReason, "matches-current-track");

  // Only now does the route catch up, which is the moment LST used to have
  // nothing left to adopt.
  await harness.frame(1);
  await harness.flushDiagnostics();

  const order = harness.debugEvents().map((event) => event.event);
  assert.ok(order.includes("episode-changed"), "the episode change is noticed");
  assert.ok(
    order.lastIndexOf("subtitle-track-accepted") > order.indexOf("episode-changed"),
    "the next episode's track is adopted after the change, without a reload",
  );
  const adopted = harness.eventsNamed("held-document-adopted");
  assert.equal(adopted.length, 1, "the held document is the one adopted");
  assert.equal(adopted[0].details.reason, "episode-changed");

  const accepted = harness.eventsNamed("subtitle-track-accepted").at(-1);
  assert.equal(accepted.details.trackReason, "no-existing-track");
  assert.equal(accepted.details.cueCount, 2);

  // And the episode translates again, which is what a viewer notices.
  await harness.show("Next episode line.", 5.4);
  assert.equal(harness.translationRequests().at(-1), "Next episode line.");
}

// A player that swaps its episode without moving the URL never fires a route
// change at all. The line the player draws is then the only evidence: it is a
// line the held document has and the current track does not, which is the
// module's own reason to adopt it.
{
  const harness = createHarness(CUE_TRACK, { site: "primevideo" });
  await harness.start();
  await harness.show("Let's go.", 20.4);
  await harness.frame(20.4);

  await harness.capture(NEXT_EPISODE_TRACK, {
    url: "https://aiv-cdn.net/ttml/B0B6GZ954Z.ttml",
  });
  assert.equal(
    harness.eventsNamed("subtitle-track-kept").length,
    1,
    "the next episode's document is refused while the old track is loaded",
  );

  await harness.show("Next episode line.", 5.4);
  await harness.frame(5.4);
  await sleep(400);
  await harness.frame(5.5);
  await harness.flushDiagnostics();

  const adopted = harness.eventsNamed("held-document-adopted");
  assert.equal(adopted.length, 1, "the held document is the one adopted");
  assert.equal(adopted[0].details.reason, "rendered-line-in-held-document");
  // The current track is still loaded here, so the module decides it the way it
  // decides an arriving document: the line the player draws belongs to the
  // incoming one and not to the track on screen.
  const accepted = harness.eventsNamed("subtitle-track-accepted").at(-1);
  assert.equal(accepted.details.trackReason, "matches-rendered-line");
  assert.equal(accepted.details.trackRelationship, "disjoint");
  assert.equal(accepted.details.renderedLineInIncoming, true);
  assert.equal(accepted.details.cueCount, 2);
  assert.equal(
    harness.eventsNamed("episode-changed").length,
    0,
    "the route never moved, so the change is only visible in what is drawn",
  );
}


// --- Prime Video: realtime captions, one element rewritten in place ----------

// Prime Video reuses one caption span and rewrites its text, so a cue boundary
// is a text change and not a new element. Until a Prime timed-text document is
// proven capturable, the rendered line is the whole source, and the existing
// stable-text window is what turns each rewrite into exactly one translation.
{
  const harness = createHarness(CUE_TRACK, { site: "primevideo" });
  await harness.start({ captureTrack: false });
  assert.equal(harness.elementById("lst-hud")?.dataset.position, "top-right");
  assert.equal(
    harness.eventsNamed("subtitle-track-accepted").length,
    0,
    "Prime Video starts with no captured track",
  );
  assert.deepEqual(harness.translationRequests(), []);

  await harness.show("\u3072\u3068\u3064\u76ee\u306e\u884c", 5);
  assert.deepEqual(
    harness.translationRequests(),
    ["\u3072\u3068\u3064\u76ee\u306e\u884c"],
    "the rendered line is translated once",
  );

  // The same text rewritten is not a new cue.
  await harness.show("\u3072\u3068\u3064\u76ee\u306e\u884c", 5.6);
  assert.deepEqual(
    harness.translationRequests(),
    ["\u3072\u3068\u3064\u76ee\u306e\u884c"],
    "an unchanged line must not be translated again",
  );

  // A rewritten element is a new cue.
  await harness.show("\u3075\u305f\u3064\u76ee\u306e\u884c", 9);
  assert.deepEqual(harness.translationRequests(), [
    "\u3072\u3068\u3064\u76ee\u306e\u884c",
    "\u3075\u305f\u3064\u76ee\u306e\u884c",
  ]);

  // A two-row cue arrives as one element whose text holds both rows.
  await harness.show("\u4e00\u884c\u76ee\n\u4e8c\u884c\u76ee", 12);
  assert.deepEqual(harness.translationRequests().at(-1), "\u4e00\u884c\u76ee\n\u4e8c\u884c\u76ee");

  // Between cues the span is empty, which is the same "no line" state Netflix
  // reports, and it must not become a request of its own.
  const beforeGap = harness.translationRequests().length;
  await harness.show("", 15);
  assert.equal(harness.translationRequests().length, beforeGap);
}

// --- A captured document from another service is refused --------------------

// The page hook tags every captured document with the page it came from, and
// content.js refuses a mismatch rather than filing one service's track under
// the other's cache id.
{
  const prime = createHarness(CUE_TRACK, { site: "primevideo" });
  await prime.start({ captureTrack: false });
  prime.dispatchDocument({
    url: "https://www.netflix.com/subtitle.vtt",
    text: CUE_TRACK,
    site: "netflix",
  });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  // Diagnostics are batched before they are flushed to the background.
  await sleep(600);
  assert.equal(prime.eventsNamed("subtitle-document-other-site").length, 1);
  assert.equal(prime.eventsNamed("subtitle-track-accepted").length, 0);
}
{
  const netflix = createHarness(CUE_TRACK, { site: "netflix" });
  await netflix.start({ captureTrack: false });
  netflix.dispatchDocument({
    url: "https://aiv-cdn.net/ttml/B0B6GZ954Y.ttml",
    text: CUE_TRACK,
    site: "primevideo",
  });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await sleep(600);
  assert.equal(netflix.eventsNamed("subtitle-document-other-site").length, 1);
  assert.equal(netflix.eventsNamed("subtitle-track-accepted").length, 0);

  // A document that carries no site tag comes from a hook that predates the tag
  // and is still adopted, so the two halves can be upgraded independently.
  netflix.dispatchDocument({ url: "https://www.netflix.com/subtitle.vtt", text: CUE_TRACK });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await sleep(600);
  assert.equal(netflix.eventsNamed("subtitle-track-accepted").length, 1);
}

// --- The per-service switch -------------------------------------------------

// A service the viewer switched off tears down like the global switch: nothing
// is drawn, nothing is translated, and the other service is untouched.
{
  const off = createHarness(CUE_TRACK, {
    site: "primevideo",
    settings: { enabledSites: { primevideo: false } },
  });
  await off.start({ captureTrack: false });
  await sleep(600);
  assert.equal(off.elementById("lst-hud"), null, "a switched-off service draws nothing");
  assert.equal(off.eventsNamed("site-disabled").length, 1, "the reason is reported once");
  assert.deepEqual(off.translationRequests(), []);
}
{
  const unaffected = createHarness(CUE_TRACK, {
    site: "netflix",
    settings: { enabledSites: { primevideo: false } },
  });
  await unaffected.start();
  await sleep(600);
  assert.ok(unaffected.elementById("lst-hud"), "Netflix is unaffected by the Prime switch");
  assert.equal(unaffected.eventsNamed("subtitle-track-accepted").length, 1);
}
{
  // A map that never mentioned a service leaves it enabled: an unknown key is
  // not a reason to disable something the viewer never touched.
  const absent = createHarness(CUE_TRACK, {
    site: "primevideo",
    settings: { enabledSites: { netflix: false } },
  });
  await absent.start({ captureTrack: false });
  assert.ok(absent.elementById("lst-hud"), "a service absent from the map stays on");
}

// --- Where the LST controls sit ---------------------------------------------

// The corner is the viewer's choice; a service only supplies a starting corner
// for a viewer who has never moved it. An unusable stored value falls back to
// that same default rather than to nothing.
{
  const netflix = createHarness(CUE_TRACK, { site: "netflix" });
  await netflix.start();
  assert.equal(netflix.elementById("lst-hud").dataset.position, "top-right");
  assert.equal(netflix.elementById("lst-hud").id, "lst-hud");
}
{
  const chosen = createHarness(CUE_TRACK, {
    site: "primevideo",
    settings: { hudPosition: "bottom-left" },
  });
  await chosen.start({ captureTrack: false });
  assert.equal(
    chosen.elementById("lst-hud").dataset.position,
    "bottom-left",
    "an explicit choice beats the service default",
  );
}
{
  const unusable = createHarness(CUE_TRACK, {
    site: "netflix",
    settings: { hudPosition: "middle" },
  });
  await unusable.start();
  assert.equal(unusable.elementById("lst-hud").dataset.position, "top-right");
}

// Imported subtitles ----------------------------------------------------------
//
// A viewer attaches a subtitle file for the episode they are watching. The file
// becomes the track, and a file already written in the language they asked for
// is displayed without any translation provider being asked for anything — which
// is the case that matters when the service has no subtitles of its own.

const IMPORTED_SRT = [
  "1",
  "00:00:09,000 --> 00:00:11,000",
  "Line one",
  "",
  "2",
  "00:00:11,500 --> 00:00:13,000",
  "Line two",
  "",
].join("\n");

const IMPORTED_JAPANESE_SRT = [
  "1",
  "00:00:09,000 --> 00:00:11,000",
  "雨が降っても",
  "",
].join("\n");

function importedTrackFor(track) {
  return {
    episodeKey: track.episodeKey || "primevideo~B0B6GZ954Y",
    entryId: 1811,
    entryName: "Mobile Suit Gundam: The Witch from Mercury",
    entryUrl: "https://jimaku.cc/entry/1811",
    fileName: track.fileName || "[Judas] Show - S01E01.ja.srt",
    fileUrl: "https://jimaku.cc/entry/1811/download/x.srt",
    size: 30000,
    format: "srt",
    language: track.language || "Japanese",
    languageCode: "ja",
    translate: track.translate === undefined ? false : track.translate,
    translateReason:
      track.translateReason ||
      (track.translate === true
        ? "track-language-differs"
        : "track-already-in-target-language"),
    cueCount: 2,
    importedAt: "2026-09-18T07:00:00.000Z",
    text: track.text,
  };
}

// Prime Video with a mounted, started player and no caption of its own: nothing
// the service draws is involved, so the file's own timeline has to be enough.
{
  const harness = createHarness(IMPORTED_SRT, {
    site: "primevideo",
    settings: { targetLanguage: "English" },
  });
  harness.setImportedTrack(
    importedTrackFor({
      text: IMPORTED_SRT,
      language: "English",
      fileName: "[Judas] Show - S01E01.en.srt",
    }),
  );
  await harness.start({ captureTrack: false });
  assert.equal(
    harness.translationRequests().length,
    0,
    "starting with an import must not ask a provider for anything",
  );

  // Before the file's first cue there is nothing to show, because the file says
  // nothing is being said.
  await harness.frame(5);
  assert.deepEqual([...harness.overlayTexts().translated], []);

  await harness.frame(10);
  assert.deepEqual(
    [...harness.overlayTexts().translated],
    ["Line one"],
    "the imported cue is rendered from the file's own timeline",
  );
  await harness.flushDiagnostics();
  assert.equal(
    harness.eventsNamed("imported-track-adopted").length,
    1,
    "the import is reported once",
  );
  const adopted = harness.eventsNamed("imported-track-adopted")[0];
  assert.equal(adopted.details.translate, false);
  assert.equal(adopted.details.translateReason, "track-already-in-target-language");
  assert.equal(adopted.details.cueCount, 2);

  // The next cue replaces the first, still without any provider call.
  await harness.frame(12);
  assert.deepEqual([...harness.overlayTexts().translated], ["Line two"]);
  assert.equal(
    harness.translationRequests().length,
    0,
    "a track already in the target language never reaches a provider",
  );

  // The service never rendered a line for either cue: the whole track came from
  // the file the viewer imported and the clock alone.
  assert.equal(
    harness.eventsNamed("subtitle-track-accepted").length,
    0,
    "no captured track is involved in an imported one",
  );
}

// A Japanese file for a viewer reading English is translated, and only then.
{
  const harness = createHarness(IMPORTED_JAPANESE_SRT, {
    site: "primevideo",
    settings: { targetLanguage: "English", autoTranslateAhead: false },
  });
  harness.setImportedTrack(
    importedTrackFor({
      text: IMPORTED_JAPANESE_SRT,
      language: "Japanese",
      fileName: "[Judas] Show - S01E01.ja.srt",
      translate: true,
    }),
  );
  await harness.start({ captureTrack: false });
  await harness.frame(10);
  const requests = harness.translationRequests();
  assert.deepEqual([...requests], ["雨が降っても"], "the cue is translated once");
  await harness.flushDiagnostics();
  const adopted = harness.eventsNamed("imported-track-adopted")[0];
  assert.equal(adopted.details.translate, true);
}

// Changing the target language changes whether an imported file still needs
// translating. A decision LST made is made again; one the viewer made stands.
{
  const harness = createHarness(IMPORTED_JAPANESE_SRT, {
    site: "primevideo",
    settings: { targetLanguage: "English", autoTranslateAhead: false },
  });
  harness.setImportedTrack(
    importedTrackFor({
      text: IMPORTED_JAPANESE_SRT,
      language: "English",
      fileName: "[Judas] Show - S01E01.en.srt",
      translate: true,
      translateReason: "track-language-differs",
    }),
  );
  await harness.start({ captureTrack: false });
  await harness.frame(10);
  assert.deepEqual(
    harness.translationRequests(),
    [],
    "a file the target language already covers is not translated",
  );
  await harness.flushDiagnostics();
  const adopted = harness.eventsNamed("imported-track-adopted").at(-1);
  assert.equal(adopted.details.translate, false);
  assert.equal(adopted.details.translateReason, "track-already-in-target-language");
}

// Netflix documents do not always carry a language label. The full cue text is
// still enough to recognize the target language, and that decision happens
// before cache reconciliation or a provider request.
{
  const harness = createHarness(CUE_TRACK, {
    site: "netflix",
    settings: { targetLanguage: "English", autoTranslateAhead: false },
  });
  await harness.start({ captureTrack: true });
  await harness.show("I don't know.", 10.2);
  assert.deepEqual(
    harness.translationRequests(),
    [],
    "an unlabeled English Netflix track is not translated to English",
  );
  assert.deepEqual(
    [...harness.overlayTexts().translated],
    [],
    "the native same-language caption is not duplicated in the LST overlay",
  );
  assert.equal(
    harness.sentMessageTypes().includes("CACHE_RECONCILE_FALLBACK"),
    false,
    "a same-language track does not start cache reconciliation",
  );
  await harness.flushDiagnostics();
  assert.equal(
    harness.eventsNamed("translation-skipped").at(-1)?.details.reason,
    "subtitle-script-matches-target",
  );
}

// A captured document cannot replace a file the viewer chose: the service keeps
// sending its own track while the imported one plays.
{
  const harness = createHarness(IMPORTED_SRT, {
    site: "netflix",
    settings: { targetLanguage: "English" },
  });
  harness.setImportedTrack(
    importedTrackFor({
      episodeKey: "80100172",
      text: IMPORTED_SRT,
      language: "English",
      fileName: "[Judas] Show - S01E01.en.srt",
    }),
  );
  await harness.start({ captureTrack: false });
  await harness.capture(CUE_TRACK);
  await harness.flushDiagnostics();
  const ignored = harness.eventsNamed("subtitle-track-ignored");
  assert.ok(ignored.length >= 1, "the captured document is refused by name");
  assert.equal(ignored[0].details.reason, "imported-track-in-use");
  assert.equal(
    harness.eventsNamed("subtitle-track-accepted").length,
    0,
    "an imported track is not replaced by a captured one",
  );
  await harness.frame(10);
  assert.deepEqual(
    [...harness.overlayTexts().translated],
    ["Line one"],
    "the imported file is still the track in use",
  );

  // The service's own caption is a different track: it is neither adopted nor
  // rendered as a fallback line next to the imported subtitle.
  await harness.show("雨が降っても", 10.4);
  assert.deepEqual(
    harness.translationRequests(),
    [],
    "the service's own line is not translated while an import is in use",
  );
  assert.deepEqual(
    [...harness.overlayTexts().translated],
    ["Line one"],
    "only the imported cue is on screen",
  );
}

// Removing the import on the options page puts the player back on the service's
// own track, without a reload.
{
  const harness = createHarness(CUE_TRACK, {
    site: "netflix",
    settings: { targetLanguage: "English" },
  });
  harness.setImportedTrack(
    importedTrackFor({
      episodeKey: "80100172",
      text: IMPORTED_SRT,
      language: "English",
      fileName: "[Judas] Show - S01E01.en.srt",
    }),
  );
  await harness.start({ captureTrack: false });
  await harness.frame(10);
  assert.deepEqual([...harness.overlayTexts().translated], ["Line one"]);

  harness.setImportedTrack(null);
  const response = await harness.pageMessage({ type: "IMPORT_CHANGED" });
  await harness.flushDiagnostics();
  assert.equal(response.applied, false, "the player is back on the captured track");
  assert.equal(harness.eventsNamed("imported-track-released").length, 1);
  assert.equal(harness.elementById("lst-hud") !== null, true, "the player stays up");
}

// An import that cannot be read is reported and does not silence the player.
{
  const harness = createHarness(CUE_TRACK, {
    site: "netflix",
    settings: { targetLanguage: "English" },
  });
  harness.setImportedTrack(
    importedTrackFor({
      episodeKey: "80100172",
      text: "this file is not a subtitle at all",
    }),
  );
  await harness.start({ captureTrack: true });
  await harness.flushDiagnostics();
  const unreadable = harness.eventsNamed("imported-track-unreadable");
  assert.equal(unreadable.length, 1);
  assert.equal(unreadable[0].details.reason, "no-readable-cues");
  assert.equal(
    harness.eventsNamed("subtitle-track-accepted").length,
    1,
    "the service's own track is used instead",
  );
}

// --- Where the subtitles on screen come from ----------------------------------
//
// The player says which track is in use, because an imported file is a different
// thing from the service's own captions and the viewer should not have to open a
// settings page to find out which one they are watching.
{
  const harness = createHarness(CUE_TRACK, {
    site: "netflix",
    settings: { targetLanguage: "English" },
  });
  harness.setImportedTrack(
    importedTrackFor({
      episodeKey: "80100172",
      text: IMPORTED_SRT,
      language: "English",
      fileName: "[Judas] Show - S01E01.en.srt",
      translateReason: "viewer-choice",
      translate: false,
    }),
  );
  await harness.start({ captureTrack: false });
  await harness.frame(10);

  const chip = harness.pillPart("#lst-pill-source");
  assert.equal(chip.hidden, false, "the player says an imported file is on screen");
  assert.equal(chip.textContent, "Imported");
  const note = harness.pillPart("#lst-pill-source-note").textContent;
  assert.match(note, /\[Judas\] Show - S01E01\.en\.srt/, "the note names the file");
  assert.match(note, /shown as it is/, "and says why nothing is translated");
  assert.match(note, /already English/, "naming the language the file is in");

  // The service's own track says so too, rather than saying nothing.
  const plain = createHarness(CUE_TRACK, { site: "netflix" });
  await plain.start({ captureTrack: true });
  await plain.frame(10);
  assert.equal(plain.pillPart("#lst-pill-source").hidden, true);
  assert.match(plain.pillPart("#lst-pill-source-note").textContent, /Netflix's own subtitles/);
}

// --- How much of the episode is loaded ---------------------------------------
//
// The pill answers "how much is loaded" with the episode's own share, not with
// the share of what is left from where the viewer is standing. The two part ways
// as soon as an episode is watched from anywhere but its first second, and the
// number beside the bar has no room to say which question it answered — so it
// always answers the episode's, and the sentence in the panel says it in cues,
// where the figure can be checked rather than trusted.
{
  const harness = createHarness(CUE_TRACK, { site: "netflix" });
  harness.setCachedCueIndexes([0]);
  await harness.start();
  await harness.frame(10);

  assert.equal(
    harness.pillPart("#lst-pill-progress").hidden,
    false,
    "the pill shows how much of the episode is loaded",
  );
  assert.equal(
    harness.pillPart("#lst-pill-percent").textContent,
    "· 33%",
    "the number is the episode's share, not the share ahead of the viewer",
  );
  assert.equal(
    harness.pillPart("#lst-pill-progress-fill").style.width,
    "33%",
    "the bar and the number are one figure",
  );
  assert.equal(
    harness.pillPart("#lst-pill-load-note").textContent,
    "33% of this episode's subtitles cached · 1 of 3 cues.",
    "the panel says the same thing in cues",
  );

  // Watched from the third cue with only the first cached: the share ahead of the
  // viewer is nothing at all, and the episode's share is still a third. The pill
  // reports the episode's.
  await harness.frame(30.5);
  assert.equal(
    harness.pillPart("#lst-pill-percent").textContent,
    "· 33%",
    "the figure does not follow the viewer down the episode",
  );
  const fromHere = await harness.pageMessage({ type: "GET_PAGE_STATUS" });
  assert.equal(
    fromHere.status.progressPercent,
    0,
    "the share left from here is nothing — the other question, answered elsewhere",
  );
  assert.equal(fromHere.status.episodeProgressPercent, 33.3);

  // A whole episode cached is a different sentence from a share of one.
  const done = createHarness(CUE_TRACK, { site: "netflix" });
  done.setCachedCueIndexes([0, 1, 2]);
  await done.start();
  await done.frame(10);
  assert.equal(done.pillPart("#lst-pill-percent").textContent, "· 100%");
  assert.equal(done.pillPart("#lst-pill-progress-fill").style.width, "100%");
  assert.equal(
    done.pillPart("#lst-pill-load-note").textContent,
    "The whole episode is cached: 3 of 3 cues.",
    "a finished episode says so rather than quoting a percentage of itself",
  );

  // Nothing captured is nothing to report.
  const waiting = createHarness(CUE_TRACK, { site: "primevideo" });
  await waiting.start({ captureTrack: false });
  await waiting.frame(10);
  assert.equal(waiting.pillPart("#lst-pill-progress").hidden, true);
  assert.equal(waiting.pillPart("#lst-pill-percent").hidden, true);
  assert.equal(waiting.pillPart("#lst-pill-load-note").hidden, true);

  // A file already in the viewer's language is all there and none of it is
  // translated, so a percentage of it would read as a failure rather than as a
  // file that needs nothing.
  const asIs = createHarness(IMPORTED_SRT, {
    site: "netflix",
    settings: { targetLanguage: "English" },
  });
  asIs.setImportedTrack(
    importedTrackFor({
      episodeKey: "80100172",
      text: IMPORTED_SRT,
      language: "English",
      fileName: "[Judas] Show - S01E01.en.srt",
      translateReason: "viewer-choice",
      translate: false,
    }),
  );
  await asIs.start({ captureTrack: false });
  await asIs.frame(10);
  assert.equal(
    asIs.pillPart("#lst-pill-progress").hidden,
    true,
    "a file shown as it is has nothing loading",
  );
  assert.equal(asIs.pillPart("#lst-pill-load-note").hidden, true);
}

// A share that rounds up to the whole episode while one cue is still missing is
// the one lie a percentage can tell, so the last percent is not reached until the
// last cue is: a long track with one cue outstanding reads 99%.
{
  const cues = Array.from({ length: 201 }, (_, index) => {
    const clock = (seconds) =>
      `00:${String(Math.floor(seconds / 60)).padStart(2, "0")}:` +
      `${String(seconds % 60).padStart(2, "0")}.000`;
    const start = 10 + index * 2;
    return `${clock(start)} --> ${clock(start + 1)}\nLine ${index + 1}`;
  });
  const harness = createHarness(["WEBVTT", "", ...cues, ""].join("\n\n"), {
    site: "netflix",
  });
  harness.setCachedCueIndexes(Array.from({ length: 200 }, (_, index) => index));
  await harness.start();
  await harness.frame(10);

  assert.equal(
    harness.pillPart("#lst-pill-percent").textContent,
    "· 99%",
    "one outstanding cue is not a loaded episode",
  );
  assert.equal(harness.pillPart("#lst-pill-progress-fill").style.width, "99%");
  assert.equal(
    harness.pillPart("#lst-pill-load-note").textContent,
    "99% of this episode's subtitles cached · 200 of 201 cues.",
  );
}

// The readout is three parts and one writer. A part that cannot be hidden is a
// part that stays on screen with nothing to say: an author `display` beats the
// browser's own rule for [hidden], which is how that happened here before.
{
  const playerCss = await fs.readFile(
    new URL("../styles.css", import.meta.url),
    "utf8",
  );
  assert.match(contentSource, /function loadProgress\(\)/);
  assert.match(contentSource, /function updatePillProgress\(\)/);
  for (const [part, rule] of [
    ["the number beside the state", /\.lst-pill-percent\[hidden\]\s*\{\s*display:\s*none/],
    ["the bar along the trigger", /\.lst-pill-progress\[hidden\]\s*\{\s*display:\s*none/],
    ["the sentence in the panel", /\.lst-pill-load-note\[hidden\]\s*\{\s*display:\s*none/],
  ]) {
    assert.match(playerCss, rule, `${part} must be hideable on its own`);
  }
  assert.match(
    playerCss,
    /#lst-pill-trigger\s*\{[^}]*position:\s*relative/,
    "the bar is positioned against the trigger it is drawn along",
  );
}

// --- What Jimaku holds for a show, on arrival ---------------------------------
//
// The sentence on arrival comes from a note LST already had, never from a search
// run because a page was opened: the request that would tell a third party which
// shows are being watched is the viewer's to make, not a page's.
{
  const harness = createHarness(CUE_TRACK, {
    site: "netflix",
    settings: { targetLanguage: "English" },
  });
  harness.setTitle("Watch Example Show | Netflix");
  harness.setJimakuFinding({
    siteId: "netflix",
    showName: "Example Show",
    query: "Example Show",
    entryCount: 3,
    entryId: 0,
    entryName: "",
    fileCount: null,
    episode: null,
    checkedAt: new Date().toISOString(),
  });
  await harness.start({ captureTrack: true });
  await harness.frame(10);
  await harness.frame(11);

  // The show was named, so there was a note to look for.
  assert.deepEqual(
    harness.jimakuAskedShowKeys(),
    ["example-show"],
    "the note is read for the show the page is about",
  );
  assert.equal(
    harness.sentMessageTypes().includes("IMPORT_SEARCH"),
    false,
    "arriving at an episode never asks Jimaku",
  );
  // The note outlives the status line, which says what the player is doing and
  // replaces itself within a second of arriving.
  const note = harness.elementById("lst-jimaku-note");
  assert.ok(note, "the player draws a note of its own");
  assert.equal(note.hidden, false, "and shows it when there is something to say");
  assert.match(
    note.querySelector("#lst-jimaku-note-text").textContent,
    /Jimaku holds 3 entries for Example Show/,
    "in the module's own sentence",
  );
  assert.match(note.querySelector("#lst-jimaku-note-text").textContent, /LST controls/);
  assert.equal(note.dataset.tone, "info");
  const pillNote = harness.pillPart("#lst-pill-jimaku-note").textContent;
  assert.match(pillNote, /Jimaku holds 3 entries for Example Show/);
  assert.equal(harness.pillPart("#lst-pill-jimaku-note").hidden, false);
  // The status line carries on with its own work, unchanged by the note.
  assert.equal(
    harness.elementById("not-status").textContent.includes("Jimaku"),
    false,
    "the note does not take over the status line",
  );
}

// A show nobody asked about is left alone, and an imported file is the answer
// rather than a note about one.
{
  const quiet = createHarness(CUE_TRACK, { site: "netflix" });
  quiet.setTitle("Watch Some Other Show | Netflix");
  await quiet.start({ captureTrack: true });
  await quiet.frame(10);
  assert.equal(quiet.pillPart("#lst-pill-jimaku-note").hidden, true);
  assert.equal(
    quiet.elementById("lst-jimaku-note").hidden,
    true,
    "nothing is said about a show nobody asked about",
  );

  const imported = createHarness(CUE_TRACK, {
    site: "netflix",
    settings: { targetLanguage: "English" },
  });
  imported.setTitle("Watch Example Show | Netflix");
  imported.setImportedTrack(
    importedTrackFor({
      episodeKey: "80100172",
      text: IMPORTED_SRT,
      language: "English",
      fileName: "[Judas] Show - S01E01.en.srt",
    }),
  );
  imported.setJimakuFinding({
    siteId: "netflix",
    showName: "Example Show",
    entryCount: 3,
    fileCount: null,
    checkedAt: new Date().toISOString(),
  });
  await imported.start({ captureTrack: false });
  await imported.frame(10);
  assert.equal(
    imported.pillPart("#lst-pill-jimaku-note").hidden,
    true,
    "the file in use is the answer, and a note about one adds nothing to it",
  );
  assert.equal(
    imported.elementById("lst-jimaku-note").hidden,
    true,
    "and an episode already using a file is not told what Jimaku holds",
  );
}

// What the player tells an extension page about itself carries the note, so the
// popup can show the same sentence without asking anyone.
{
  const harness = createHarness(CUE_TRACK, {
    site: "netflix",
    settings: { targetLanguage: "English" },
  });
  harness.setTitle("Watch Example Show | Netflix");
  await harness.start({ captureTrack: true });
  await harness.frame(10);
  harness.setJimakuFinding({
    siteId: "netflix",
    showName: "Example Show",
    entryCount: 3,
    fileCount: null,
    checkedAt: new Date().toISOString(),
  });
  const status = await harness.pageMessage({ type: "GET_PAGE_STATUS" });
  assert.equal(status.ok, true);
  assert.equal(status.status.jimaku, null, "nothing is known until the viewer asks");

  // The card's answer arrives as a message, and the player adopts it.
  const response = await harness.pageMessage({
    type: "JIMAKU_CHANGED",
    finding: {
      showKey: "example-show",
      siteId: "netflix",
      showName: "Example Show",
      entryCount: 3,
      fileCount: null,
      checkedAt: new Date().toISOString(),
    },
  });
  assert.equal(response.applied, true);
  const adopted = await harness.pageMessage({ type: "GET_PAGE_STATUS" });
  assert.equal(adopted.status.jimaku.entryCount, 3);
  assert.match(
    harness.pillPart("#lst-pill-jimaku-note").textContent,
    /Jimaku holds 3 entries for Example Show/,
  );

  // The same message reaches every tab, and the others are watching something
  // else: a note for another show is not adopted here.
  const elsewhere = await harness.pageMessage({
    type: "JIMAKU_CHANGED",
    finding: {
      showKey: "some-other-show",
      showName: "Some Other Show",
      entryCount: 9,
      checkedAt: new Date().toISOString(),
    },
  });
  assert.equal(elsewhere.applied, false);
  assert.equal((await harness.pageMessage({ type: "GET_PAGE_STATUS" })).status.jimaku.entryCount, 3);

  // Forgetting it is handed over too, so the player stops saying it.
  const cleared = await harness.pageMessage({
    type: "JIMAKU_CHANGED",
    cleared: true,
    showKey: "example-show",
  });
  assert.equal(cleared.reason, "cleared");
  assert.equal(harness.pillPart("#lst-pill-jimaku-note").hidden, true);
  assert.equal((await harness.pageMessage({ type: "GET_PAGE_STATUS" })).status.jimaku, null);
  // A note for another show is not the note this tab is showing.
  const other = await harness.pageMessage({
    type: "JIMAKU_CHANGED",
    cleared: true,
    showKey: "some-other-show",
  });
  assert.equal(other.ok, true);
  assert.equal(
    harness.pillPart("#lst-pill-jimaku-note").hidden,
    true,
    "clearing a note for another show leaves this one alone",
  );
}

console.log("Subtitle matching checks passed.");
