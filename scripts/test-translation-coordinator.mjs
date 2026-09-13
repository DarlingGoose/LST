import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const context = vm.createContext({ Promise });
const source = await fs.readFile(
  new URL("../translation-coordinator.js", import.meta.url),
  "utf8",
);
vm.runInContext(source, context, { filename: "translation-coordinator.js" });

let releaseBatch;
let batchCalls = 0;
const events = [];
const coordinator = new context.LSTTranslationCoordinator({
  keyFor: (cue) => cue.key,
  runBatch: async (cues) => {
    batchCalls += 1;
    await new Promise((resolve) => { releaseBatch = resolve; });
    return {
      entries: Object.fromEntries(cues.map((cue) => [cue.key, `translated:${cue.key}`])),
      failures: [],
    };
  },
  onEvent: (event, details) => events.push({ event, details }),
});

const cue = { key: "1000:2000" };
const lookAhead = coordinator.translate([cue]);
await Promise.resolve();
const foreground = coordinator.translate([cue]);
assert.equal(coordinator.has(cue.key), true);
assert.equal(batchCalls, 1, "foreground should join the look-ahead request");
assert.equal(events.some(({ event }) => event === "translation-inflight-joined"), true);

releaseBatch();
const [lookAheadResult, foregroundResult] = await Promise.all([lookAhead, foreground]);
assert.equal(lookAheadResult.entries[cue.key], "translated:1000:2000");
assert.equal(foregroundResult.entries[cue.key], "translated:1000:2000");
await Promise.resolve();
assert.equal(coordinator.has(cue.key), false);

let failureCalls = 0;
const failureCoordinator = new context.LSTTranslationCoordinator({
  keyFor: (item) => item.key,
  runBatch: async () => {
    failureCalls += 1;
    throw new Error("offline");
  },
});
const failures = await Promise.allSettled([
  failureCoordinator.translate([{ key: "failed" }]),
  failureCoordinator.translate([{ key: "failed" }]),
]);
assert.equal(failureCalls, 1);
assert.equal(failures.every((result) => result.status === "rejected"), true);

console.log("Translation coordinator checks passed.");
