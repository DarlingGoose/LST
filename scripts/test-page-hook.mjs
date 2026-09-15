import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

let pathname = "/browse";
let responseReads = 0;
let xhrListeners = 0;
const messages = [];
const subtitle = `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello world`;

const response = {
  url: "https://www.netflix.com/subtitle.vtt",
  headers: { get(name) {
    return name === "content-type" ? "text/vtt" : "0";
  } },
  clone() {
    responseReads++;
    return { async text() { return subtitle; } };
  }
};

const window = {
  async fetch() { return response; },
  postMessage(message) { messages.push(message); }
};
function MockXHR() {}
MockXHR.prototype.open = function () {};
MockXHR.prototype.send = function () {};
MockXHR.prototype.addEventListener = function () { xhrListeners++; };

const context = vm.createContext({
  window,
  location: { get pathname() { return pathname; } },
  XMLHttpRequest: MockXHR
});
vm.runInContext(await fs.readFile(new URL("../page-hook.js", import.meta.url), "utf8"), context);

await window.fetch("/subtitle.vtt");
await Promise.resolve();
assert.equal(responseReads, 0);
assert.equal(messages.length, 0);
new MockXHR().send();
assert.equal(xhrListeners, 0);

pathname = "/search";
await window.fetch("/subtitle.vtt");
await Promise.resolve();
assert.equal(responseReads, 0);

pathname = "/watch/123456";
await window.fetch("/subtitle.vtt");
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(responseReads, 1);
assert.equal(messages.length, 1);
assert.equal(messages[0].type, "SUBTITLE_DOCUMENT");
new MockXHR().send();
assert.equal(xhrListeners, 1);

pathname = "/browse";
await window.fetch("/subtitle.vtt");
await Promise.resolve();
assert.equal(responseReads, 1);
new MockXHR().send();
assert.equal(xhrListeners, 1);

let storageReads = 0;
let routeCheck;
let playbackDomCalls = 0;
const contentContext = vm.createContext({
  location: { get pathname() { return pathname; } },
  document: {
    addEventListener() {},
    querySelector() { playbackDomCalls++; return null; },
    get documentElement() { playbackDomCalls++; return {}; }
  },
  window: { addEventListener() {} },
  browser: {
    runtime: { onMessage: { addListener() {} } },
    storage: { local: { async get() { storageReads++; return {}; } } }
  },
  setInterval(callback) { routeCheck = callback; return 1; },
  console
});
vm.runInContext(await fs.readFile(new URL("../content.js", import.meta.url), "utf8"), contentContext);
await Promise.resolve();
assert.equal(storageReads, 0);
assert.equal(playbackDomCalls, 0);
pathname = "/search";
routeCheck();
await Promise.resolve();
assert.equal(storageReads, 0);
assert.equal(playbackDomCalls, 0);
console.log("Netflix route checks passed.");
