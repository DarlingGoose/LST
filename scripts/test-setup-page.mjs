import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const read = (file) => fs.readFile(new URL(`../${file}`, import.meta.url), "utf8");
const [html, script, background, css, prepare, verifyPackage, packageJson, playbackSite] =
  await Promise.all([
    read("setup.html"),
    read("setup.js"),
    read("background.js"),
    read("options.css"),
    read("scripts/prepare-browser.mjs"),
    read("scripts/verify-package.mjs"),
    read("package.json"),
    read("playback-site.js")
  ]);

function matches(source, pattern, group = 1) {
  return [...source.matchAll(pattern)].map((match) => match[group]);
}

function first(source, pattern, group = 1) {
  const match = source.match(pattern);
  assert.ok(match, `expected to find ${pattern}`);
  return match[group];
}

// --- Static contract: every element the script reaches for exists in the page ---

const htmlIds = new Set(matches(html, /\bid="([^"]+)"/g));
const referencedIds = [
  ...matches(script, /\$\("([^"]+)"\)/g),
  ...matches(script, /for \(const id of \[([^\]]+)\]\)/g).flatMap((list) =>
    matches(list, /"([^"]+)"/g))
];

assert.ok(referencedIds.length > 30, "expected the setup script to reference many elements");
for (const id of new Set(referencedIds)) {
  assert.ok(htmlIds.has(id), `setup.js references #${id}, which setup.html does not define`);
}

const steps = first(script, /const STEPS = \[([^\]]+)\]/).match(/"([^"]+)"/g)
  .map((value) => value.replaceAll('"', ""));
const tabs = matches(html, /data-setup-tab="([^"]+)"/g);
const panels = matches(html, /data-setup-panel="([^"]+)"/g);
assert.deepEqual(tabs, steps, "sidebar steps must match the script's step order");
assert.deepEqual(panels, steps, "panels must match the script's step order");
for (const step of steps) {
  assert.ok(htmlIds.has(`panel-${step}`), `panel-${step} is missing`);
  assert.ok(htmlIds.has(`tab-${step}`), `tab-${step} is missing`);
  assert.match(html, new RegExp(`aria-controls="panel-${step}"`));
  assert.match(html, new RegExp(`aria-labelledby="tab-${step}"`));
}
assert.match(html, /class="settings-content" data-active-step="welcome"/);
assert.match(html, /<script src="setup\.js"><\/script>/);
assert.match(html, /<link rel="stylesheet" href="options\.css">/);

// The page reuses the settings stylesheet, so its own classes must be styled there.
for (const className of ["setup-tab-index", "setup-lead", "setup-list"]) {
  assert.match(html, new RegExp(`class="[^"]*\\b${className}\\b`), `${className} is unused`);
  assert.match(css, new RegExp(`\\.${className}\\b`), `${className} is not styled in options.css`);
}

// --- Static contract: install-time opening and packaging ---

assert.match(background, /onInstalled\.addListener\(async \(details\) =>/);
assert.match(background, /if \(details\?\.reason !== "install"\) return;/);
assert.match(background, /ext\.tabs\.create\(\{ url: ext\.runtime\.getURL\("setup\.html"\) \}\)/);
assert.match(background, /setupCompleted: false,/);

for (const file of ["setup.html", "setup.js"]) {
  assert.ok(prepare.includes(`"${file}"`), `${file} is not copied into the browser builds`);
  assert.ok(verifyPackage.includes(`"${file}"`), `${file} is not verified in release archives`);
}
assert.ok(JSON.parse(packageJson).scripts["check:syntax"].includes("node --check setup.js"));

// --- Behaviour: drive the real page script against a stub DOM ---

class Option {
  constructor(text = "", value = "") {
    this.textContent = text;
    this.value = value;
  }
}

const SELECTS = new Set(["provider", "model"]);
const elements = new Map();

function element(id) {
  return {
    id,
    tagName: SELECTS.has(id) ? "SELECT" : "INPUT",
    value: "",
    checked: false,
    textContent: "",
    hidden: false,
    disabled: false,
    tabIndex: 0,
    className: "",
    style: {},
    dataset: {},
    options: [],
    children: [],
    listeners: {},
    setAttribute(name, value) { this[name] = value; },
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); },
    append(...children) {
      for (const child of children) this.appendChild(child);
    },
    appendChild(child) {
      this.children.push(child);
      if (this.tagName === "SELECT") {
        this.options.push(child);
        if (this.options.length === 1) this.value = child.value;
      }
      return child;
    },
    replaceChildren(...children) {
      this.children = children;
      if (this.tagName === "SELECT") {
        this.options = children;
        this.value = children[0]?.value ?? "";
      }
    },
    prepend(child) {
      this.children.unshift(child);
      if (this.tagName === "SELECT") this.options.unshift(child);
      return child;
    },
    focus() { this.focused = true; },
    closest(selector) {
      if (selector === "[data-setup-tab]" && this.dataset.setupTab) return this;
      return null;
    },
    async click() {
      for (const handler of this.listeners.click || []) await handler({ target: this });
    },
    async fire(type, target = this) {
      for (const handler of this.listeners[type] || []) await handler({ target });
    }
  };
}

function byId(id) {
  if (!elements.has(id)) elements.set(id, element(id));
  return elements.get(id);
}

for (const id of htmlIds) byId(id);
for (const step of steps) {
  byId(`tab-${step}`).dataset.setupTab = step;
  const panel = byId(`panel-${step}`);
  panel.dataset.setupPanel = step;
  panel.hidden = true;
}

const content = element("settings-content");
const tabList = element("settings-tabs");

const document = {
  title: "",
  getElementById: byId,
  querySelector(selector) {
    if (selector === ".settings-content") return content;
    if (selector === ".settings-tabs") return tabList;
    throw new Error(`Unexpected selector ${selector}`);
  },
  querySelectorAll(selector) {
    if (selector === "[data-setup-tab]") return steps.map((step) => byId(`tab-${step}`));
    if (selector === "[data-setup-panel]") return steps.map((step) => byId(`panel-${step}`));
    // The per-service switches are the rows the services card rendered.
    if (selector === "input[data-service-id]") {
      return byId("serviceList").children.map((row) => row.children[1].children[0]);
    }
    throw new Error(`Unexpected selector ${selector}`);
  },
  createElement: (tagName) => Object.assign(element(""), { tagName: tagName.toUpperCase() })
};

const settings = {
  provider: "ollama",
  ollamaUrl: "http://localhost:11434",
  ollamaModel: "translategemma:4b",
  deepseekModel: "",
  geminiModel: "",
  model: "translategemma:4b",
  targetLanguage: "English",
  enabled: true,
  hideNativeSubtitles: true,
  showOriginal: false,
  showTranslated: true,
  verifyTranslations: true,
  setupCompleted: false
};

const messages = [];
const opened = [];
let configured = { deepseek: false, gemini: false };

const modelsFor = (provider) => provider === "ollama"
  ? [{ name: "translategemma:4b", parameterSize: "4B", quantization: "Q4_K_M" }]
  : [{ name: "deepseek-chat" }];

const context = vm.createContext({
  Option,
  console,
  setTimeout,
  navigator: { clipboard: { async writeText() {} } },
  location: { hash: "" },
  history: { replaceState() {} },
  document,
  chrome: {
    runtime: {
      getURL: (file) => `moz-extension://test/${file}`,
      openOptionsPage: async () => { opened.push("options"); },
      onMessage: { addListener() {} },
      async sendMessage(message) {
        messages.push(message);
        if (message.type === "GET_SETTINGS") return { ok: true, settings };
        if (message.type === "GET_PROVIDER_KEY_STATUS") return { ok: true, configured };
        if (message.type === "GET_MODELS") return { ok: true, models: modelsFor(message.provider) };
        if (message.type === "SAVE_SETTINGS") Object.assign(settings, message.settings);
        return { ok: true };
      }
    },
    tabs: {
      async query() { return []; },
      async sendMessage() {},
      async create(options) { opened.push(options.url); }
    }
  }
});

vm.runInContext(playbackSite, context, { filename: "playback-site.js" });
vm.runInContext(script, context);
const readState = (expression) => vm.runInContext(expression, context);
const settle = async () => {
  for (let turn = 0; turn < 4; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
};

await settle();
assert.equal(readState("currentStep"), "welcome");
assert.equal(byId("setupTitle").textContent, "Welcome to LST");
assert.equal(byId("setupNext").textContent, "Set up translation");
assert.equal(byId("setupBack").hidden, true, "Back is hidden on the first step");
assert.equal(byId("panel-welcome").hidden, false);
assert.equal(byId("panel-engine").hidden, true);
assert.equal(byId("connectionState").textContent, "Connected");
assert.equal(byId("modelCount").textContent, "1 available");
assert.equal(byId("modelSummary").textContent, "translategemma:4b");
assert.equal(byId("status").textContent, "", "the first step must not open with a status message");

// Welcome has nothing to save: it only advances.
await byId("setupNext").click();
await settle();
assert.equal(readState("currentStep"), "engine");
assert.equal(messages.filter((message) => message.type === "SAVE_SETTINGS").length, 0);
assert.equal(byId("setupBack").hidden, false);

// A remote provider without a key cannot be saved.
byId("provider").value = "deepseek";
await byId("provider").fire("change");
await settle();
assert.equal(byId("panel-engine").hidden, false);
assert.equal(byId("modelDownload").hidden, true, "model downloads are Ollama-only");
await byId("setupNext").click();
await settle();
assert.equal(readState("currentStep"), "engine", "the step must not advance on a failed save");
assert.equal(byId("status").dataset.tone, "error");
assert.match(byId("status").textContent, /DeepSeek API key/);

// Back to Ollama, then continue with a real save.
byId("provider").value = "ollama";
await byId("provider").fire("change");
await settle();
assert.equal(byId("modelDownload").hidden, false);

byId("targetLanguage").value = "Français";
await byId("targetLanguage").fire("change");
assert.equal(byId("summaryLanguage").textContent, "Français");
assert.match(byId("previewHeading").textContent, /target: Français$/);

byId("showOriginal").checked = true;
byId("enabled").checked = false;
await byId("showOriginal").fire("change");
await byId("enabled").fire("change");
assert.equal(byId("previewOriginal").style.display, "block");
assert.equal(byId("subtitlePreview").style.opacity, ".28");

await byId("setupNext").click();
await settle();
assert.equal(readState("currentStep"), "language");
const saved = messages.filter((message) => message.type === "SAVE_SETTINGS");
assert.equal(saved.length, 1);
assert.equal(saved[0].settings.targetLanguage, "Français");
assert.equal(saved[0].settings.model, "translategemma:4b");
assert.equal(saved[0].settings.showOriginal, true);
assert.equal(saved[0].settings.verifyTranslations, true);
assert.equal(saved[0].settings.setupCompleted, undefined, "setup is not complete yet");
assert.equal(byId("status").dataset.tone, "success");

await byId("setupNext").click();
await settle();
assert.equal(readState("currentStep"), "ready");
assert.equal(byId("setupNext").textContent, "Save and finish");
assert.equal(byId("summaryProvider").textContent, "Ollama");
assert.equal(byId("summaryModel").textContent, "translategemma:4b");
assert.equal(byId("summaryPrivacy").textContent, "Local endpoint");
assert.equal(byId("summaryPrivacy").className, "success-text");

await byId("setupNext").click();
await settle();
assert.equal(readState("finished"), true);
assert.equal(byId("readyPill").textContent, "Setup complete");
assert.equal(byId("setupNext").textContent, "Start watching");
assert.equal(byId("setupBack").hidden, true);
assert.equal(byId("status").dataset.tone, "success");
assert.match(byId("status").textContent, /Setup complete/);
const completed = messages.filter((message) => message.type === "SAVE_SETTINGS").at(-1);
assert.equal(completed.settings.setupCompleted, true);

// Finishing hands the user to Netflix instead of looping back through the steps.
await byId("setupNext").click();
await settle();
assert.deepEqual(opened, ["https://www.netflix.com/"]);

await byId("openSettings").click();
await settle();
assert.deepEqual(opened, ["https://www.netflix.com/", "options"]);

// Sidebar steps stay usable after finishing, and the header follows the step.
await tabList.fire("click", byId("tab-engine"));
assert.equal(readState("currentStep"), "engine");
assert.equal(byId("setupTitle").textContent, "Choose a translation engine");
assert.equal(byId("setupNext").textContent, "Save and continue");
assert.equal(byId("setupBack").hidden, false);
assert.equal(byId("status").textContent, "", "stale step messages are cleared");
assert.equal(readState("finished"), true, "finishing stays remembered on this page");

// Returning to the last step offers the finish action again, not a service.
await tabList.fire("click", byId("tab-ready"));
assert.equal(byId("setupNext").textContent, "Start watching");
assert.equal(byId("setupBack").hidden, true);


// --- Per-service switches and the renamed setting ---------------------------

// The services card is built from the adapter, so a service added there appears
// here without a second edit.
const serviceRows = () =>
  byId("serviceList").children.map((row) => ({
    label: row.children[0].children[0].textContent,
    input: row.children[1].children[0],
  }));

assert.equal(serviceRows().length, 2, "one row per supported service");
assert.deepEqual(serviceRows().map((row) => row.label), ["Netflix", "Prime Video"]);
assert.deepEqual(serviceRows().map((row) => row.input.dataset.serviceId), ["netflix", "primevideo"]);
assert.deepEqual(serviceRows().map((row) => row.input.checked), [true, true]);
assert.deepEqual(
  [...byId("serviceLinks").children].map((button) => button.textContent),
  ["Open Netflix", "Open Prime Video"],
);

// A legacy install keeps its saved preference: the renamed key is read through,
// and a stored `false` is a real answer that the default must not replace.
settings.hideNativeSubtitles = undefined;
settings.hideNetflixSubtitles = false;
await vm.runInContext("load()", context);
await settle();
assert.equal(byId("hideNativeSubtitles").checked, false, "a legacy false must survive the rename");

settings.hideNativeSubtitles = undefined;
settings.hideNetflixSubtitles = true;
await vm.runInContext("load()", context);
await settle();
assert.equal(byId("hideNativeSubtitles").checked, true);

// The neutral key wins when both are present.
settings.hideNativeSubtitles = false;
settings.hideNetflixSubtitles = true;
await vm.runInContext("load()", context);
await settle();
assert.equal(byId("hideNativeSubtitles").checked, false);
delete settings.hideNetflixSubtitles;

// A service the viewer switched off is off, and the other is untouched.
settings.hideNativeSubtitles = true;
settings.enabledSites = { primevideo: false };
await vm.runInContext("load()", context);
await settle();
assert.deepEqual(serviceRows().map((row) => row.input.checked), [true, false]);
assert.deepEqual(
  [...byId("serviceLinks").children].map((button) => button.textContent),
  ["Open Netflix"],
  "a disabled service is not offered as a way in",
);

// Finishing hands the viewer to a service that is actually switched on, so a
// Prime Video viewer is never sent to Netflix by a Netflix-era default.
opened.length = 0;
await vm.runInContext("openPreferredService()", context);
assert.deepEqual(opened, ["https://www.netflix.com/"]);

settings.enabledSites = { netflix: false };
await vm.runInContext("load()", context);
await settle();
await vm.runInContext("openPreferredService()", context);
assert.deepEqual(opened, ["https://www.netflix.com/", "https://www.primevideo.com/"]);

await byId("open-primevideo").click();
assert.deepEqual(opened.at(-1), "https://www.primevideo.com/");

// The per-service map travels with the saved settings.
settings.enabledSites = { netflix: true, primevideo: false };
await vm.runInContext("load()", context);
await settle();
messages.length = 0;
await vm.runInContext("saveSettings({ quiet: true })", context);
const savedServices = messages.filter((message) => message.type === "SAVE_SETTINGS").at(-1);
assert.deepEqual(
  JSON.parse(JSON.stringify(savedServices.settings.enabledSites)),
  { netflix: true, primevideo: false },
);
assert.equal(savedServices.settings.hideNativeSubtitles, true);
assert.equal(
  Object.prototype.hasOwnProperty.call(savedServices.settings, "hideNetflixSubtitles"),
  false,
  "the setup page must not write the legacy key",
);

console.log("Setup page contract and first-run flow passed.");
