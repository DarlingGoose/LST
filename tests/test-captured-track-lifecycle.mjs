import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { repositoryPath } from "./helpers/repository-path.mjs";

const source = await fs.readFile(
  new URL(repositoryPath("captured-track-lifecycle.js"), import.meta.url),
  "utf8",
);
const context = vm.createContext({});
vm.runInContext(source, context, { filename: "captured-track-lifecycle.js" });
const api = context.LSTCapturedTrackLifecycle;

let clock = 10_000;
const createLifecycle = () =>
  api.createCapturedTrackLifecycle({
    freshMs: 2_000,
    restartedItemSeconds: 60,
    now: () => clock,
  });

function hold(lifecycle, overrides = {}) {
  return lifecycle.hold({
    url: "https://captions.example/episode.ttml",
    text: "subtitle document",
    details: { capture: "playback-resources", language: "ja" },
    videoId: "episode-2",
    pageVideoId: "series-page",
    videoTime: 180,
    foldedLines: ["next line", "another line"],
    ...overrides,
  });
}

{
  const lifecycle = createLifecycle();
  assert.equal(lifecycle.snapshot().held, false);
  assert.equal(hold(lifecycle).action, "held");
  assert.deepEqual(JSON.parse(JSON.stringify(lifecycle.snapshot())), {
    held: true,
    ageMs: 0,
    videoId: "episode-2",
    pageVideoId: "series-page",
  });

  const adopted = lifecycle.offerEmptyTrack({
    reason: "episode-changed",
    currentVideoId: "episode-2",
    currentPageVideoId: "series-page",
  });
  assert.equal(adopted.action, "adopt");
  assert.equal(adopted.reason, "episode-changed");
  assert.equal(adopted.document.videoId, "episode-2");
  assert.equal(lifecycle.snapshot().held, false, "an adopted document is one-shot");
}

{
  const lifecycle = createLifecycle();
  hold(lifecycle);
  const kept = lifecycle.offerEmptyTrack({
    reason: "episode-changed",
    currentVideoId: "episode-3",
    currentPageVideoId: "different-page",
  });
  assert.equal(kept.action, "keep");
  assert.equal(kept.reason, "held-document-other-episode");
  assert.equal(lifecycle.snapshot().held, true);

  clock += 2_001;
  const stale = lifecycle.offerEmptyTrack({
    reason: "playback-start",
    currentVideoId: "episode-2",
    currentPageVideoId: "series-page",
  });
  assert.equal(stale.reason, "held-document-stale");
  assert.equal(stale.ageMs, 2_001);
}

clock = 20_000;
{
  const lifecycle = createLifecycle();
  hold(lifecycle);
  assert.equal(
    lifecycle.offerEmptyTrack({ hasTrack: true }).reason,
    "track-not-empty",
  );
  const restarted = lifecycle.offerRestart({ videoTime: 20 });
  assert.equal(restarted.action, "adopt");
  assert.equal(restarted.reason, "item-restarted-in-held-document");
  assert.equal(restarted.details.capturedVideoTimeMs, 180_000);
  assert.equal(restarted.details.videoTimeMs, 20_000);
}

{
  const lifecycle = createLifecycle();
  hold(lifecycle);
  const current = lifecycle.offerRenderedLine({
    foldedText: "next line",
    currentTrackHasLine: true,
  });
  assert.equal(current.reason, "rendered-line-in-current-track");
  assert.equal(
    lifecycle.offerRenderedLine({ foldedText: "next line" }).reason,
    "rendered-line-already-offered",
    "a repeated rendered mismatch is evaluated once",
  );
  lifecycle.resetRenderedLine();
  const adopted = lifecycle.offerRenderedLine({ foldedText: "next line" });
  assert.equal(adopted.action, "adopt");
  assert.equal(adopted.reason, "rendered-line-in-held-document");
}

{
  const lifecycle = createLifecycle();
  hold(lifecycle, { text: "current document" });
  assert.equal(
    lifecycle.dropIfCurrentDocument("other", { incomingWithinExisting: true }).action,
    "keep",
  );
  const dropped = lifecycle.dropIfCurrentDocument("current document", {
    incomingWithinExisting: true,
  });
  assert.equal(dropped.action, "drop");
  assert.equal(dropped.reason, "document-is-current-track");
  assert.equal(lifecycle.snapshot().held, false);
}

const manifest = JSON.parse(
  await fs.readFile(new URL("../src/manifest.json", import.meta.url), "utf8"),
);
const isolated = manifest.content_scripts.find((entry) =>
  entry.js.includes("content/index.js"));
assert.ok(isolated.js.includes("content/captured-track-lifecycle.js"));
assert.ok(
  isolated.js.indexOf("content/captured-track-lifecycle.js") <
    isolated.js.indexOf("content/index.js"),
);

console.log("Captured-track lifecycle checks passed.");
