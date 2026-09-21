import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const source = await fs.readFile(
  new URL("../src/shared/playback-policy.js", import.meta.url),
  "utf8",
);
const context = vm.createContext({});
vm.runInContext(source, context, { filename: "playback-policy.js" });
const policy = context.LSTPlaybackPolicy;

const ready = {
  videoPaused: true,
  cacheWhilePaused: true,
  translationPaused: false,
  model: "test-model",
  cueCount: 100,
  needsTranslation: true,
  precomputing: false,
  complete: false,
};

assert.deepEqual(
  { ...policy.pausedCacheDecision(ready) },
  { allowed: true, reason: "ready" },
);

for (const [patch, reason, sentence] of [
  [{ videoPaused: false }, "video-playing", /Pause the video/],
  [{ cacheWhilePaused: false }, "cache-while-paused-disabled", /turned off/],
  [{ translationPaused: true }, "translation-paused", /caching is paused too/],
  [{ model: "" }, "no-model", /Choose a translation model/],
  [{ cueCount: 0 }, "no-full-track", /DOM realtime mode cannot build/],
  [{ needsTranslation: false }, "translation-unnecessary", /no translation cache is needed/],
  [{ precomputing: true }, "precomputing", /already running/],
  [{ complete: true }, "cache-complete", /already cached/],
]) {
  const decision = policy.pausedCacheDecision({ ...ready, ...patch });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, reason);
  assert.match(policy.describePausedCacheDecision(decision), sentence);
}

console.log("Playback policy checks passed.");
