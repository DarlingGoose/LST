import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { repositoryPath } from "./helpers/repository-path.mjs";

const source = await fs.readFile(
  new URL(repositoryPath("subtitle-parser.js"), import.meta.url),
  "utf8",
);
const context = vm.createContext({});
vm.runInContext(source, context, { filename: "subtitle-parser.js" });
const parser = context.LSTSubtitleParser;

assert.equal(parser.parseClock("1500ms"), 1.5);
assert.equal(parser.parseClock("90s"), 90);
assert.equal(parser.parseClock("2m"), 120);
assert.equal(parser.parseClock("01:02:03.250"), 3723.25);
assert.equal(parser.parseClock("5000000t", 10_000_000), 0.5);
assert.ok(Number.isNaN(parser.parseClock("not-a-time")));

assert.deepEqual(
  JSON.parse(JSON.stringify(parser.parseVtt(`WEBVTT

first
00:00:01.000 --> 00:00:02.500 position:50%
Hello <i>world</i>
second line

00:03.000 --> 00:04.000
Next
`))),
  [
    { id: "first", start: 1, end: 2.5, text: "Hello world\nsecond line" },
    { id: "1", start: 3, end: 4, text: "Next" },
  ],
);

let delegated = "";
const srt = parser.parseSubtitleDocument("1\n00:00:01,000 --> 00:00:02,000\nHi", {
  parseSrt(text) {
    delegated = text;
    return [{ id: "srt" }];
  },
});
assert.equal(delegated.startsWith("1\n"), true);
assert.deepEqual(JSON.parse(JSON.stringify(srt)), [{ id: "srt" }]);
assert.deepEqual(JSON.parse(JSON.stringify(parser.parseSubtitleDocument("unknown"))), []);

const manifest = JSON.parse(
  await fs.readFile(new URL("../src/manifest.json", import.meta.url), "utf8"),
);
const isolated = manifest.content_scripts.find((entry) =>
  entry.js.includes("content/index.js"));
assert.ok(isolated.js.includes("content/subtitle-parser.js"));
assert.ok(
  isolated.js.indexOf("content/subtitle-parser.js") <
    isolated.js.indexOf("content/index.js"),
);
const verify = await fs.readFile(
  new URL("../scripts/verify-package.mjs", import.meta.url),
  "utf8",
);
assert.match(verify, /"content\/subtitle-parser\.js"/);

console.log("Subtitle document parser checks passed.");
