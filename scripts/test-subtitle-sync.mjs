import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const context = vm.createContext({});
const source = await fs.readFile(
  new URL("../subtitle-sync.js", import.meta.url),
  "utf8",
);
vm.runInContext(source, context, { filename: "subtitle-sync.js" });

const sync = context.LSTSubtitleSync;
const cues = [
  { start: 922.004, end: 923.672, text: "本当だ。" },
  { start: 924.465, end: 926.759, text: "次の字幕です" },
  { start: 930.262, end: 933.932, text: "What are you doing?" },
];

const formattingMatch = sync.findUniqueSimplifiedCue(
  cues,
  "WHAT ARE YOU DOING？",
);
assert.equal(formattingMatch?.index, 2);
assert.equal(
  sync.simplifySubtitleText("WHAT ARE YOU DOING？"),
  sync.simplifySubtitleText("What are you doing?"),
);

const previousCue = { cue: cues[0], index: 0 };
assert.equal(
  sync.isInterCueGapMatch(cues, previousCue, 923.676, null),
  true,
  "Netflix retaining the previous cue during the gap is expected",
);
assert.equal(sync.isInterCueGapMatch(cues, previousCue, 924.465, null), false);
assert.equal(
  sync.isInterCueGapMatch(cues, previousCue, 923.676, { cue: cues[1], index: 1 }),
  false,
);

const ambiguousCues = [
  { start: 1, end: 2, text: "Yes!" },
  { start: 3, end: 4, text: "YES?" },
];
assert.equal(
  sync.findUniqueSimplifiedCue(ambiguousCues, "yes."),
  null,
  "format-tolerant matching must not guess between duplicate lines",
);
assert.equal(sync.findUniqueSimplifiedCue(cues, "?"), null);

console.log("Subtitle synchronization checks passed.");
