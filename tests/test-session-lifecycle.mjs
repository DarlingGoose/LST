import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { repositoryPath } from "./helpers/repository-path.mjs";

const source = await fs.readFile(
  new URL(repositoryPath("session-lifecycle.js"), import.meta.url),
  "utf8",
);
const context = vm.createContext({});
vm.runInContext(source, context, { filename: "session-lifecycle.js" });
const lifecycle = context.LSTSessionLifecycle.createSessionLifecycle({
  transitionLimit: 2,
});

assert.deepEqual(JSON.parse(JSON.stringify(lifecycle.snapshot())), {
  active: false,
  playbackGeneration: 0,
  cacheGeneration: 0,
  transitions: [],
});

const first = lifecycle.start();
assert.equal(first, 1);
assert.equal(lifecycle.active, true);
assert.equal(lifecycle.playbackIsCurrent(first), true);
assert.equal(lifecycle.playbackIsCurrent(0), false);

lifecycle.recordTransition({ state: "started", reason: "one" });
lifecycle.recordTransition({ state: "stopped", reason: "two" });
lifecycle.recordTransition({ state: "started", reason: "three" });
assert.deepEqual(
  JSON.parse(JSON.stringify(lifecycle.transitions())).map((entry) => entry.reason),
  ["two", "three"],
);

const cache = lifecycle.bumpCacheGeneration();
assert.equal(cache, 1);
assert.equal(lifecycle.cacheIsCurrent(cache), true);
assert.equal(lifecycle.cacheIsCurrent(0), false);

assert.equal(lifecycle.stop(), 2);
assert.equal(lifecycle.active, false);
const second = lifecycle.start();
assert.equal(second, 3);
assert.equal(lifecycle.deactivate(2), false, "a stale startup cannot stop a newer session");
assert.equal(lifecycle.active, true);
assert.equal(lifecycle.deactivate(second), true);
assert.equal(lifecycle.active, false);

const manifest = JSON.parse(
  await fs.readFile(new URL("../src/manifest.json", import.meta.url), "utf8"),
);
const isolated = manifest.content_scripts.find((entry) =>
  entry.js.includes("content/index.js"));
assert.ok(isolated.js.includes("content/session-lifecycle.js"));
assert.ok(
  isolated.js.indexOf("content/session-lifecycle.js") <
    isolated.js.indexOf("content/index.js"),
);

console.log("Player session lifecycle checks passed.");
