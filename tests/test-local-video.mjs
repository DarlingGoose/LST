import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const context = vm.createContext({ TextEncoder });
for (const file of ["playback-site.js", "episode-identity.js", "local-video.js"]) {
  const directory = file === "local-video.js" ? "shared" : file === "playback-site.js" ? "sites" : "shared";
  vm.runInContext(
    await fs.readFile(new URL(`../src/${directory}/${file}`, import.meta.url), "utf8"),
    context,
    { filename: file },
  );
}

const local = context.LSTLocalVideo;
const identity = context.LSTEpisodeIdentity;
const video = { name: "episode.mkv", size: 1234, lastModified: 10 };
const subtitle = { name: "episode.ja.srt", size: 200, lastModified: 11 };
const firstId = local.mediaIdentity(video, subtitle, "subtitle text");
assert.match(firstId, /^local-[a-f0-9]{16}$/);
assert.equal(local.mediaIdentity(video, subtitle, "subtitle text"), firstId);
assert.notEqual(local.mediaIdentity(video, subtitle, "changed text"), firstId);

const cacheId = identity.encodeCacheId({
  siteId: "local",
  videoId: firstId,
  provider: "ollama",
  model: "model:latest",
  targetLanguage: "English",
});
assert.equal(cacheId, `local~${firstId}:model%3Alatest:English`);
assert.deepEqual(
  JSON.parse(JSON.stringify(identity.decodeCacheId(cacheId))),
  {
    videoId: firstId,
    siteId: "local",
    provider: "ollama",
    model: "model:latest",
    targetLanguage: "English",
    namespace: "site",
    reason: "ok",
  },
);

const cues = [
  { start: 1, end: 2, text: "one" },
  { start: 1.5, end: 3, text: "two" },
];
assert.deepEqual(
  JSON.parse(JSON.stringify(local.activeCuesAt(cues, 1.75))),
  cues,
);
assert.equal(local.activeCuesAt(cues, 3).length, 0);
assert.equal(local.cueKey(cues[0]), "1000:2000:one");

const html = await fs.readFile(
  new URL("../src/ui/local-player/local-player.html", import.meta.url),
  "utf8",
);
const script = await fs.readFile(
  new URL("../src/ui/local-player/local-player.js", import.meta.url),
  "utf8",
);
const popup = await fs.readFile(
  new URL("../src/ui/popup/popup.html", import.meta.url),
  "utf8",
);
assert.match(html, /type="file" accept="video\/\*"/);
assert.match(html, /type="file" accept="\.srt/);
assert.match(html, /id="displayMode"/);
assert.match(html, /id="progress"/);
assert.match(html, /id="fullscreen"/);
assert.match(script, /importApi\.parseSrt/);
assert.match(script, /type: "TRANSLATE_BATCH"/);
assert.match(script, /type: "CACHE_GET"/);
assert.match(script, /type: "CACHE_SET"/);
assert.match(script, /addEventListener\("seeked", renderSubtitles\)/);
assert.match(script, /playerShell.*requestFullscreen/);
assert.match(popup, /id="localVideo"/);

console.log("Local video player checks passed.");
