import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const context = vm.createContext({});
const source = await fs.readFile(
  new URL("../src/shared/translation-guard.js", import.meta.url),
  "utf8",
);
vm.runInContext(source, context, { filename: "translation-guard.js" });

const guard = context.LSTTranslationGuard;

function verdict(source, translation, targetLanguage) {
  return guard.verify({ source, translation, targetLanguage });
}

// The reported bug: Japanese captions reach the cache for an English target.
const leaked = verdict("本当だ。", "本当だ。", "English");
assert.equal(leaked.verdict, "reject");
assert.equal(leaked.reason, "source-language-leaked");
assert.equal(leaked.letterCount, 3);
assert.match(guard.describeRejection(leaked), /instead of translating into English/);

// A partial translation that keeps Japanese word order still counts as English.
assert.equal(verdict("行かなければならない。", "We have to go.", "English").verdict, "accept");

// Japanese target with an English result is the same failure in reverse.
const reversed = verdict("We have to go.", "We have to go.", "Japanese");
assert.equal(reversed.verdict, "reject");
assert.equal(reversed.reason, "source-language-leaked");

assert.equal(verdict("We have to go.", "行かなければならない。", "Japanese").verdict, "accept");
assert.equal(verdict("雨が降っても", "雨が降っても", "Japanese").verdict, "accept");

// A third script is not the source and not the target.
const thirdScript = verdict("本当だ。", "Правда.", "English");
assert.equal(thirdScript.verdict, "reject");
assert.equal(thirdScript.reason, "wrong-script");

// Romanization shares the target's script, so script comparison cannot see it.
// This is the guard's stated limit, and it is what the docs call a wrong
// language that shares the target's writing system.
assert.equal(verdict("本当だ。", "Hontou da.", "English").verdict, "accept");
assert.equal(verdict("本当だ。", "Hontou da.", "English").reason, "expected-script");

// A single Latin token survives translation in most languages, so a non-Latin
// target tolerates brand names and acronyms.
assert.equal(verdict("はい", "Netflix", "Japanese").reason, "single-token");
assert.equal(verdict("はい", "SNS", "Japanese").reason, "too-short");

// Targets that share the source's script cannot be judged by script at all.
// English output for a Spanish target passes, which is the guard's stated limit.
assert.equal(verdict("Tienes que ir.", "You have to go.", "Spanish").verdict, "accept");

// Lines with nothing to judge stay out of the way.
assert.equal(verdict("1789", "1789", "English").reason, "no-letters");
assert.equal(verdict("...", "...", "English").reason, "no-letters");
assert.equal(verdict("はい", "OK", "Japanese").reason, "too-short");
assert.equal(verdict("はい", "", "English").verdict, "reject");
assert.equal(verdict("はい", "", "English").reason, "empty");

// Language names, codes, and qualifiers all resolve to writing systems.
assert.deepEqual([...guard.scriptsForLanguage("English")], ["Latin"]);
assert.deepEqual([...guard.scriptsForLanguage("en-US")], ["Latin"]);
assert.deepEqual([...guard.scriptsForLanguage("Français")], ["Latin"]);
assert.deepEqual([...guard.scriptsForLanguage("Brazilian Portuguese")], ["Latin"]);
assert.equal(guard.scriptsForLanguage("Klingon"), null);
assert.equal(guard.scriptsForLanguage(""), null);
assert.deepEqual([...guard.scriptsForLanguage("Japanese")], ["Han", "Hiragana", "Katakana"]);
assert.deepEqual([...guard.scriptsForLanguage("zh-TW")], ["Han"]);

// Endonyms and accented names resolve too, since the target language is typed
// by hand.
assert.deepEqual([...guard.scriptsForLanguage("Français")], ["Latin"]);
assert.deepEqual([...guard.scriptsForLanguage("Türkçe")], ["Latin"]);
assert.deepEqual([...guard.scriptsForLanguage("日本語")], ["Han", "Hiragana", "Katakana"]);
assert.deepEqual([...guard.scriptsForLanguage("Русский")], ["Cyrillic"]);
assert.deepEqual([...guard.scriptsForLanguage("한국어")], ["Han", "Hangul"]);

// An unrecognized target language is never judged.
assert.equal(verdict("本当だ。", "本当だ。", "Klingon").reason, "unknown-target-language");

// Accented Latin text is still Latin text.
assert.equal(verdict("You must go.", "Il faut y aller.", "French").verdict, "accept");
assert.equal(verdict("你必須去。", "You must go.", "English").verdict, "accept");
assert.equal(verdict("You must go.", "你必須去。", "English").verdict, "reject");
assert.equal(verdict("You must go.", "你必须去。", "Chinese").verdict, "accept");
assert.equal(verdict("You must go.", "Du musst gehen.", "Russian").verdict, "reject");

const summary = guard.summarize([
  verdict("本当だ。", "Right.", "English"),
  verdict("本当だ。", "本当だ。", "English"),
  verdict("次の字幕です", "次の字幕です", "English"),
]);
assert.deepEqual(JSON.parse(JSON.stringify(summary)), {
  status: "checked",
  checked: 3,
  accepted: 1,
  rejected: 2,
  reason: "source-language-leaked",
});

console.log("Translation guard checks passed.");
