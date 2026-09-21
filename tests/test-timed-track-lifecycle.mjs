import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { repositoryPath } from "./helpers/repository-path.mjs";

const source = await fs.readFile(
  new URL(repositoryPath("timed-track-lifecycle.js"), import.meta.url),
  "utf8",
);
const context = vm.createContext({});
vm.runInContext(source, context, { filename: "timed-track-lifecycle.js" });
const api = context.LSTTimedTrackLifecycle;

{
  const lifecycle = api.createTimedTrackLifecycle({ mismatchGraceMs: 300 });
  assert.equal(lifecycle.state, "unverified");
  assert.equal(lifecycle.automaticOffsetSeconds, 0);

  const anchored = lifecycle.anchor({
    renderedText: "First line",
    cueStart: 12,
    videoTime: 10,
  });
  assert.equal(lifecycle.state, "verified");
  assert.ok(Math.abs(anchored.automaticOffsetSeconds - 2.04) < 0.000001);

  const started = lifecycle.beginMismatch("unknown-text", 1_000);
  assert.equal(started.started, true);
  assert.equal(started.mismatchId, 1);
  assert.equal(started.withinGrace, true);
  const pending = lifecycle.beginMismatch("unknown-text", 1_299);
  assert.equal(pending.started, false);
  assert.equal(pending.withinGrace, true);
  assert.equal(
    lifecycle.beginMismatch("unknown-text", 1_300).withinGrace,
    false,
  );

  const confirmed = lifecycle.confirmMismatch("Different line", 1_300);
  assert.equal(confirmed.newlyConfirmed, true);
  assert.equal(confirmed.durationMs, 300);
  assert.equal(lifecycle.state, "mismatch");

  const idle = lifecycle.noteIdle(1_500);
  assert.equal(idle.reported, true);
  assert.equal(idle.verified, false);
  assert.equal(lifecycle.state, "mismatch", "silence must not verify a mismatch");
  assert.equal(lifecycle.noteIdle(1_600).reported, true);
  assert.equal(lifecycle.state, "mismatch");

  const resolved = lifecycle.verify("Matching line", 1_700);
  assert.equal(resolved.resolved.mismatchId, 1);
  assert.equal(lifecycle.state, "verified");
  assert.equal(lifecycle.lastRenderedText, "Matching line");
}

{
  const lifecycle = api.createTimedTrackLifecycle({ mismatchGraceMs: 300 });
  lifecycle.anchor({ renderedText: "One", cueStart: 1, videoTime: 1 });
  lifecycle.beginMismatch("known-cue-boundary", 2_000);
  const reanchored = lifecycle.reanchor({
    renderedText: "Later cue",
    cueStart: 50,
    videoTime: 10,
    at: 2_450,
  });
  assert.equal(reanchored.mismatchId, 1);
  assert.equal(reanchored.durationMs, 450);
  assert.equal(reanchored.previousReason, "known-cue-boundary");
  assert.ok(Math.abs(reanchored.automaticOffsetSeconds - 40.04) < 0.000001);
  assert.equal(lifecycle.state, "verified");
}

{
  const lifecycle = api.createTimedTrackLifecycle();
  lifecycle.noteNoCue(5_000);
  assert.equal(lifecycle.noCueDuration(5_220), 220);
  lifecycle.clearNoCue();
  assert.equal(lifecycle.noCueDuration(5_500), 0);
  lifecycle.reset({ nextState: "verified", resetSequence: true });
  assert.equal(lifecycle.state, "verified");
  lifecycle.withdraw();
  assert.equal(lifecycle.state, "unverified");
}

const manifest = JSON.parse(
  await fs.readFile(new URL("../src/manifest.json", import.meta.url), "utf8"),
);
const isolated = manifest.content_scripts.find((entry) =>
  entry.js.includes("content/index.js"));
assert.ok(isolated.js.includes("content/timed-track-lifecycle.js"));
assert.ok(
  isolated.js.indexOf("content/timed-track-lifecycle.js") <
    isolated.js.indexOf("content/index.js"),
);

console.log("Timed-track lifecycle checks passed.");
