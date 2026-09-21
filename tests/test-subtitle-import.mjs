import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { repositoryPath } from "./helpers/repository-path.mjs";

// Subtitle import — the module that decides where an imported subtitle comes
// from, which file belongs to which episode, what a SubRip file says, and
// whether the file needs translating at all. Every table below is a table of
// facts about other people's services, so each case names the reason it exists.

const context = vm.createContext({ URL, console, TextDecoder });
const read = (name) =>
  fs.readFile(new URL(repositoryPath(name), import.meta.url), "utf8");

const playbackSiteSource = await read("playback-site.js");
const netflixSiteSource = await read("netflix.js");
const primeVideoSiteSource = await read("prime-video.js");
const identitySource = await read("episode-identity.js");
const importSource = await read("subtitle-import.js");
const manifest = JSON.parse(await read("manifest.json"));

vm.runInContext(playbackSiteSource, context, { filename: "playback-site.js" });
vm.runInContext(netflixSiteSource, context, { filename: "netflix.js" });
vm.runInContext(primeVideoSiteSource, context, { filename: "prime-video.js" });
vm.runInContext(identitySource, context, { filename: "episode-identity.js" });
vm.runInContext(importSource, context, { filename: "subtitle-import.js" });

const imported = context.LSTSubtitleImport;
const identity = context.LSTEpisodeIdentity;

// Values that cross the vm boundary keep the other realm's prototypes, so they
// are compared as plain JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));

assert.ok(imported, "subtitle-import.js should publish LSTSubtitleImport");
assert.ok(identity, "episode-identity.js should publish LSTEpisodeIdentity");

// --- Formats -----------------------------------------------------------------

// A named but unreadable format is refused before it is offered, because a
// subtitle that fails at parse time looks like a broken extension.
const formats = [
  ["ep.srt", "srt", true, "subtitle-format-from-extension"],
  ["ep.SRT", "srt", true, "subtitle-format-from-extension"],
  ["ep.vtt", "vtt", true, "subtitle-format-from-extension"],
  ["ep.webvtt", "vtt", true, "subtitle-format-from-extension"],
  ["ep.ttml", "ttml", true, "subtitle-format-from-extension"],
  ["ep.dfxp", "ttml", true, "subtitle-format-from-extension"],
  ["ep.ass", "ass", false, "subtitle-format-unsupported"],
  ["ep.ssa", "ass", false, "subtitle-format-unsupported"],
  ["ep.zip", "zip", false, "subtitle-format-unsupported"],
  ["ep.sub", "sub", false, "subtitle-format-unsupported"],
  ["ep", "unknown", false, "subtitle-format-unknown"],
  ["", "unknown", false, "subtitle-format-unknown"],
];
for (const [name, format, supported, reason] of formats) {
  const result = imported.subtitleFormat(name);
  assert.equal(result.format, format, `${name} should be a ${format}`);
  assert.equal(result.supported, supported, `${name} support level`);
  assert.equal(result.reason, reason, `${name} reason`);
}

// --- Episode numbers ---------------------------------------------------------

// The names below are the ones a real entry serves: fansub releases that put
// the episode after a dash, a season/episode marker, a version suffix, and
// release noise (resolution, codec, group hash) that must not be read as an
// episode number.
const episodes = [
  ["[Judas] Mobile Suit Gundam - The Witch from Mercury - S01E01.ja.srt", 1, "season-episode"],
  ["[Judas] Show - S01E12.ja.srt", 12, "season-episode"],
  ["Show.S01.E12.srt", 12, "season-episode"],
  ["Show - 02.srt", 2, "dash-number"],
  ["Show - 03  (RKK 1280x720 x264 AAC).srt", 3, "dash-number"],
  ["Show - 01v2 [1080p HEVC][B3D444BD].srt", 1, "dash-number"],
  ["Show Ep05.srt", 5, "episode-marker"],
  ["Show Episode 7.srt", 7, "episode-marker"],
  ["Show - E10.srt", 10, "episode-marker"],
  ["Show [04].srt", 4, "bracketed-number"],
  ["Mobile Suit Gundam 08.srt", 8, "loose-number"],
];
for (const [name, episode, reason] of episodes) {
  const result = imported.episodeNumberFromFileName(name);
  assert.equal(result.episode, episode, `${name} episode`);
  assert.equal(result.reason, reason, `${name} reason`);
}

// A number that is only release noise is not an episode.
assert.equal(imported.episodeNumberFromFileName("Show 1080p.srt").episode, null);
assert.equal(imported.episodeNumberFromFileName("Show [B3D444BD].srt").episode, null);
assert.equal(imported.episodeNumberFromFileName("").reason, "empty-file-name");
assert.equal(imported.episodeNumberFromFileName("Show.srt").reason, "no-episode-number");
// A movie has no episode at all, and saying "no episode number" is the answer.
assert.equal(imported.episodeNumberFromFileName("Movie (2019) [1080p].srt").episode, null);

// --- File languages ----------------------------------------------------------

const languages = [
  ["[Judas] Show - S01E01.ja.srt", "Japanese", "dotted-language-tag"],
  ["Show.S01E02.en.srt", "English", "dotted-language-tag"],
  ["Show.S01E02.eng.srt", "English", "dotted-language-tag"],
  ["Show - 03 [ja].srt", "Japanese", "bracketed-language-tag"],
  ["Show - 03 (en).srt", "English", "bracketed-language-tag"],
  ["Show - 03.en-US.srt", "English", "delimited-language-tag"],
  ["Show - S01E01.English.srt", "English", "language-word"],
  ["Show - S01E01.Japanese.srt", "Japanese", "language-word"],
];
for (const [name, language, reason] of languages) {
  const result = imported.languageFromFileName(name);
  assert.equal(result.language, language, `${name} language`);
  assert.equal(result.reason, reason, `${name} reason`);
}

// Two-letter words in a romaji title are not language tags: "no" is Norwegian
// and "Majo no" is not a translation.
assert.equal(imported.languageFromFileName("Kidou Senshi Gundam Suisei no Majo - 03.srt").language, "");
assert.equal(imported.languageFromFileName("Show - 03.srt").reason, "no-language-tag");
assert.equal(imported.languageFromFileName("").reason, "empty-file-name");
// A bracketed release group is not a language either.
assert.equal(
  imported.languageFromFileName("[KureyonRaws] Show - 03 (RKK 1280x720 x264 AAC).srt").language,
  "",
);

assert.equal(imported.languageCodeOf("Japanese"), "ja");
assert.equal(imported.languageCodeOf("JAPANESE"), "ja");
assert.equal(imported.languageCodeOf("jpn"), "ja");
assert.equal(imported.languageCodeOf("English"), "en");
assert.equal(imported.languageCodeOf("Klingon"), "");
assert.equal(imported.languageNameOf("ja"), "Japanese");
assert.equal(imported.languageNameOf("Klingon"), "");

// --- Scripts -----------------------------------------------------------------

assert.equal(imported.scriptOf("編入手続きよし").script, "japanese");
assert.equal(imported.scriptOf("制服よし").script, "japanese");
assert.equal(imported.scriptOf("Even if it rains, we still have to go.").script, "latin");
assert.equal(imported.scriptOf("До свидания").script, "cyrillic");
assert.equal(imported.scriptOf("안녕하세요").script, "korean");
assert.equal(imported.scriptOf("你好，世界").script, "han");
assert.equal(imported.scriptOf("مرحبا").script, "arabic");
assert.equal(imported.scriptOf("").reason, "no-text");
assert.equal(imported.scriptOf("12345 ----").reason, "no-letters");
// Japanese is decided by kana even when kanji outnumber them.
assert.equal(imported.scriptOf("機動戦士ガンダム 水星の魔女").script, "japanese");
assert.deepEqual(plain(imported.scriptsForLanguage("Japanese")), ["japanese", "han"]);
assert.deepEqual(plain(imported.scriptsForLanguage("English")), ["latin"]);
assert.equal(imported.scriptsForLanguage("Klingon"), null);

// --- Does this file need translating? ----------------------------------------

// The whole point of importing a file is the case where it does not: a file the
// viewer can already read must never be sent to a translation provider.
const translateCases = [
  // A Japanese file for a viewer reading English.
  [{ language: "Japanese", targetLanguage: "English", sampleText: "こんにちは" },
    true, "track-language-differs"],
  [{ language: "English", targetLanguage: "English", sampleText: "Hello" },
    false, "track-already-in-target-language"],
  [{ language: "eng", targetLanguage: "English", sampleText: "Hello" },
    false, "track-already-in-target-language"],
  [{ language: "en", targetLanguage: "English", sampleText: "Hello" },
    false, "track-already-in-target-language"],
  // No language tag, but the writing says it plainly.
  [{ language: "", targetLanguage: "English", sampleText: "Hello there." },
    false, "script-matches-target-language"],
  [{ language: "", targetLanguage: "English", sampleText: "こんにちは、世界。" },
    true, "script-differs-from-target-language"],
  [{ language: "", targetLanguage: "Japanese", sampleText: "こんにちは、世界。" },
    false, "script-matches-target-language"],
  [{ language: "", targetLanguage: "Japanese", sampleText: "Hello there." },
    true, "script-differs-from-target-language"],
  // A language LST cannot compare is decided by script when the sample allows
  // it, and is translated rather than displayed untranslated when it does not.
  [{ language: "Klingon", targetLanguage: "Klingon", sampleText: "nuqneH" },
    false, "track-already-in-target-language"],
  // An exact name match is trusted even when LST has no code for the language:
  // the name the file gives itself is the only evidence there is.
  [{ language: "Klingon", targetLanguage: "Klingon", sampleText: "日本語の字幕" },
    false, "track-already-in-target-language"],
  // The file states a language and the viewer's target could not be compared
  // with it, so the track is translated rather than shown unchecked.
  [{ language: "Klingon", targetLanguage: "English", sampleText: "nuqneH" },
    true, "target-language-unknown"],
  [{ language: "en", targetLanguage: "Klingon", sampleText: "Hello there" },
    true, "target-language-unknown"],
  // A qualified name is the same language.
  [{ language: "Portuguese", targetLanguage: "Brazilian Portuguese", sampleText: "Olá" },
    false, "track-already-in-target-language"],
  [{ language: "Chinese", targetLanguage: "Traditional Chinese", sampleText: "你好" },
    false, "track-already-in-target-language"],
  [{ language: "", targetLanguage: "Klingon", sampleText: "nuqneH" },
    true, "track-language-unknown"],
  [{ language: "", targetLanguage: "English", sampleText: "" },
    true, "track-language-unknown"],
  [{ language: "", targetLanguage: "", sampleText: "" },
    true, "track-language-unknown"],
];
for (const [input, translate, reason] of translateCases) {
  const result = imported.needsTranslation(input);
  assert.equal(
    result.translate,
    translate,
    `${JSON.stringify(input)} should${translate ? "" : " not"} translate`,
  );
  assert.equal(result.reason, reason, `${JSON.stringify(input)} reason`);
}

// --- SubRip ------------------------------------------------------------------

// Real SubRip as these sources write it: a byte-order mark, Windows endings,
// two-line cues, and a leading parenthesised speaker.
const srtSample = "\ufeff1\r\n00:00:03,087 --> 00:00:04,964\r\n（スレッタ）\r\n編入手続きよし\r\n\r\n" +
  "2\r\n00:00:05,297 --> 00:00:06,632\r\n制服よし\r\n\r\n" +
  "3\n00:00:08,467 --> 00:00:10,636\nコックピットの\nレギュレーションよし\n";

const parsed = imported.parseSrt(srtSample);
assert.equal(parsed.length, 3, "three cues");
assert.equal(parsed[0].start, 3.087);
assert.equal(parsed[0].end, 4.964);
assert.equal(parsed[0].text, "（スレッタ）\n編入手続きよし");
assert.equal(parsed[1].text, "制服よし");
assert.equal(parsed[2].start, 8.467);
assert.equal(parsed[2].text, "コックピットの\nレギュレーションよし");
assert.deepEqual(
  plain(parsed.map((cue) => cue.id)),
  ["0", "1", "2"],
  "cues carry their index as an id",
);

// Sequence numbers are optional, timestamps may use a dot, a position suffix is
// not part of the text, markup is stripped, and a `\N` is a line break.
const looseSrt = [
  "00:00:01.000 --> 00:00:02.000",
  "<i>Hello</i>",
  "",
  "7",
  "00:00:03,000 --> 00:00:04,000 X1:100 X2:200 Y1:1 Y2:2",
  "{\\an8}Above line\\Nsecond line",
].join("\n");
const looseCues = imported.parseSrt(looseSrt);
assert.equal(looseCues.length, 2);
assert.equal(looseCues[0].text, "Hello");
assert.equal(looseCues[1].text, "Above line\nsecond line");

// Minutes-only timestamps and hours beyond the first are accepted.
assert.equal(imported.parseSrtTimestamp("00:00:03,087"), 3.087);
assert.equal(imported.parseSrtTimestamp("01:02:03,500"), 3723.5);
assert.equal(imported.parseSrtTimestamp("02:03,500"), 123.5);
assert.ok(Number.isNaN(imported.parseSrtTimestamp("nonsense")));
assert.ok(Number.isNaN(imported.parseSrtTimestamp("")));

// Text that is not SubRip produces no cues rather than nonsense.
assert.equal(imported.parseSrt("").length, 0);
assert.equal(imported.parseSrt("   \n\n ").length, 0);
assert.equal(imported.parseSrt("<tt><body/></tt>").length, 0);
assert.equal(
  imported.parseSrt('<tt><body><div><p begin="1s" end="2s">Hi</p></div></body></tt>').length,
  0,
  "a timed-text document is not a SubRip document",
);
// An inverted or empty cue is dropped instead of rendering backwards.
assert.equal(imported.parseSrt("1\n00:00:05,000 --> 00:00:04,000\nBackwards").length, 0);
assert.equal(imported.parseSrt("1\n00:00:04,000 --> 00:00:05,000\n\n").length, 0);

// --- Endpoints ---------------------------------------------------------------

assert.equal(
  imported.searchUrl("The Witch from Mercury"),
  "https://www.subtitlebot.com/api/jimaku/search?query=The+Witch+from+Mercury&limit=50&anime=true",
);
assert.equal(
  imported.searchUrl("Frieren", { limit: 10, anime: false }),
  "https://www.subtitlebot.com/api/jimaku/search?query=Frieren&limit=10&anime=false",
);
assert.equal(imported.entryPageUrl(1811), "https://jimaku.cc/entry/1811");
assert.equal(imported.filesUrl(1811), "https://jimaku.cc/api/entries/1811/files");
assert.equal(
  imported.filesUrl(1811, 3),
  "https://jimaku.cc/api/entries/1811/files?episode=3",
);
assert.equal(imported.filesUrl(1811, null), "https://jimaku.cc/api/entries/1811/files");
assert.equal(imported.filesUrl("1811", 0), "https://jimaku.cc/api/entries/1811/files?episode=0");

// An entry can be named directly instead of searched for.
assert.deepEqual(plain(imported.parseEntryReference("1811")), { entryId: 1811, reason: "entry-id" });
assert.deepEqual(plain(imported.parseEntryReference("https://jimaku.cc/entry/1811")), {
  entryId: 1811,
  reason: "entry-url",
});
assert.deepEqual(plain(imported.parseEntryReference("https://jimaku.cc/entry/1811/files")), {
  entryId: 1811,
  reason: "entry-url",
});
assert.deepEqual(plain(imported.parseEntryReference("entry/3488")), { entryId: 3488, reason: "entry-path" });
assert.deepEqual(plain(imported.parseEntryReference("")), { entryId: null, reason: "empty-entry-reference" });
assert.deepEqual(plain(imported.parseEntryReference("not an entry")), {
  entryId: null,
  reason: "unrecognized-entry-reference",
});

// The query is the show, not the episode: the same search serves a season.
assert.equal(
  imported.queryFromShowName("Mobile Suit Gundam: The Witch from Mercury"),
  "Mobile Suit Gundam: The Witch from Mercury",
);
assert.equal(imported.queryFromShowName("Show - Season 2"), "Show");
assert.equal(imported.queryFromShowName("Show S01E04"), "Show");
assert.equal(imported.queryFromShowName("Show Episode 4"), "Show");
assert.equal(imported.queryFromShowName("Show - 4"), "Show");
assert.equal(imported.queryFromShowName(""), "");

// A season written in Japanese is the same problem as one written in Latin, and
// the reason this section exists: Netflix states the season inside the show's
// own name, and Jimaku files the entry under the bare name, so the query that
// carries the season finds nothing at all. The name that works is the name this
// must produce.
assert.equal(
  imported.queryFromShowName("機動戦士ガンダム 水星の魔女 シーズン1"),
  "機動戦士ガンダム 水星の魔女",
  "the season Netflix states in the name must not reach Jimaku",
);
assert.equal(
  imported.queryFromShowName("機動戦士ガンダム 水星の魔女"),
  "機動戦士ガンダム 水星の魔女",
  "a name with no season on it is the query, unchanged",
);
assert.equal(imported.queryFromShowName("機動戦士ガンダム 水星の魔女　シーズン1"), "機動戦士ガンダム 水星の魔女", "a full-width space separates too");
assert.equal(imported.queryFromShowName("機動戦士ガンダム 水星の魔女シーズン1"), "機動戦士ガンダム 水星の魔女", "a season need not be spaced off");
assert.equal(imported.queryFromShowName("機動戦士ガンダム 水星の魔女 第2期"), "機動戦士ガンダム 水星の魔女");
assert.equal(imported.queryFromShowName("機動戦士ガンダム 水星の魔女 2期"), "機動戦士ガンダム 水星の魔女");
assert.equal(imported.queryFromShowName("機動戦士ガンダム 水星の魔女 第2シーズン"), "機動戦士ガンダム 水星の魔女");
assert.equal(imported.queryFromShowName("機動戦士ガンダム 水星の魔女 第2クール"), "機動戦士ガンダム 水星の魔女");
assert.equal(imported.queryFromShowName("機動戦士ガンダム 水星の魔女 パート2"), "機動戦士ガンダム 水星の魔女");
assert.equal(imported.queryFromShowName("機動戦士ガンダム 水星の魔女 第2季"), "機動戦士ガンダム 水星の魔女", "a Chinese season word is a season word");
assert.equal(imported.queryFromShowName("機動戦士ガンダム 水星の魔女 第1話"), "機動戦士ガンダム 水星の魔女");
assert.equal(imported.queryFromShowName("機動戦士ガンダム 水星の魔女 第1話「魔女と花嫁」"), "機動戦士ガンダム 水星の魔女", "an episode title after the number goes with it");
assert.equal(imported.queryFromShowName("機動戦士ガンダム 水星の魔女（第2期）"), "機動戦士ガンダム 水星の魔女");
assert.equal(imported.queryFromShowName("機動戦士ガンダム 水星の魔女（シーズン2）"), "機動戦士ガンダム 水星の魔女");
assert.equal(imported.queryFromShowName("機動戦士ガンダム 水星の魔女 シーズン1 第4話"), "機動戦士ガンダム 水星の魔女", "a title can carry two markers");
assert.equal(imported.queryFromShowName("Show - Season 2 - Episode 3"), "Show", "trimming one marker can expose another");
assert.equal(imported.queryFromShowName("Show (第3話)"), "Show");

// A marker is never the whole name: a show actually called シーズン1 or 第2期
// must still be searchable, which is why no pattern may empty the query.
assert.equal(imported.queryFromShowName("シーズン1"), "シーズン1");
assert.equal(imported.queryFromShowName("第2期"), "第2期");
assert.equal(imported.queryFromShowName("第1話"), "第1話");

// A word that only looks like a marker is left alone: 編 and 話 close a
// subtitle, not a season, and the titles that end in one keep it.
assert.equal(imported.queryFromShowName("進撃の巨人 完結編"), "進撃の巨人 完結編");
assert.equal(imported.queryFromShowName("鬼滅の刃 無限列車編"), "鬼滅の刃 無限列車編");
assert.equal(imported.queryFromShowName("Re:Zero"), "Re:Zero", "a colon inside a name is not punctuation to trim");

// The separator a marker left behind goes too, and a name that is nothing but
// punctuation is not a name.
assert.equal(imported.queryFromShowName("Show - 第2期"), "Show");
assert.equal(imported.queryFromShowName("Show:"), "Show");
assert.equal(imported.queryFromShowName("-"), "");
assert.equal(imported.queryFromShowName("   "), "");

// --- Search results ----------------------------------------------------------

// The payload the search endpoint really returns, with its placeholder-free
// names and its flags.
const searchPayload = [
  {
    id: 1811,
    name: "Kidou Senshi Gundam: Suisei no Majo",
    flags: { anime: true, unverified: false, external: true, movie: false, adult: false },
    last_modified: "2025-02-28T21:58:34Z",
    anilist_id: 139274,
    notes: "Netflix files originally numbered E02-13",
    english_name: "Mobile Suit Gundam: The Witch from Mercury",
    japanese_name: "機動戦士ガンダム 水星の魔女",
  },
  {
    id: 3485,
    name: "Kidou Senshi Gundam: Suisei no Majo Season 2",
    flags: { anime: true, unverified: false, external: false, movie: false, adult: false },
    last_modified: "2024-09-26T22:56:19Z",
    creator_id: 37,
    anilist_id: 155158,
    notes: "Netflix files originally numbered E14-25",
    english_name: "Mobile Suit Gundam: The Witch from Mercury Season 2",
    japanese_name: "機動戦士ガンダム 水星の魔女 Season2",
  },
];

const search = imported.parseSearchResults(searchPayload);
assert.equal(search.reason, "search-results");
assert.equal(search.entries.length, 2);
assert.equal(search.entries[0].entryId, 1811);
assert.equal(search.entries[0].displayName, "Mobile Suit Gundam: The Witch from Mercury");
assert.equal(search.entries[0].displayNameReason, "english-name");
assert.equal(search.entries[0].japaneseName, "機動戦士ガンダム 水星の魔女");
assert.equal(search.entries[0].notes, "Netflix files originally numbered E02-13");
assert.equal(search.entries[0].anilistId, 139274);
assert.equal(search.entries[0].pageUrl, "https://jimaku.cc/entry/1811");
assert.equal(search.entries[0].movie, false);
assert.equal(search.entries[0].external, true);
assert.equal(search.entries[1].entryId, 3485);

// A result without a usable id or name is skipped, not offered.
const filtered = imported.parseSearchResults([
  { id: "not a number", name: "Broken" },
  { id: 0, name: "Broken" },
  { id: 42 },
  { id: 43, name: "Fine" },
]);
assert.equal(filtered.entries.length, 1);
assert.equal(filtered.skipped, 3);

assert.equal(imported.parseSearchResults({}).reason, "search-payload-not-a-list");
assert.equal(imported.parseSearchResults([]).reason, "search-no-results");
assert.equal(imported.parseSearchResults(null).entries.length, 0);

// --- File listings -----------------------------------------------------------

const filesPayload = [
  {
    url: "https://jimaku.cc/entry/1811/download/%5BJudas%5D%20Show%20-%20S01E01.ja.srt",
    name: "[Judas] Show - S01E01.ja.srt",
    size: 30974,
    last_modified: "2025-02-28T21:58:34Z",
  },
  {
    // A relative URL is what the entry page itself uses, so it is resolved
    // against the origin the listing came from.
    url: "/entry/1811/download/%5BJudas%5D%20Show%20-%20S01E02.ja.srt",
    name: "[Judas] Show - S01E02.ja.srt",
    size: 30000,
    last_modified: "2025-02-28T21:58:34Z",
  },
  {
    url: "https://example.invalid/archive.zip",
    name: "Show Batch.zip",
    size: 900000,
    last_modified: "2025-02-28T21:58:34Z",
  },
];

const files = imported.parseFileList(filesPayload);
assert.equal(files.reason, "file-list");
assert.equal(files.files.length, 3);
assert.equal(files.files[0].episode, 1);
assert.equal(files.files[0].language, "Japanese");
assert.equal(files.files[0].format, "srt");
assert.equal(files.files[0].supported, true);
assert.equal(files.files[0].urlAllowed, true);
assert.equal(files.files[0].urlHost, "jimaku.cc");
assert.equal(
  files.files[1].url,
  "https://jimaku.cc/entry/1811/download/%5BJudas%5D%20Show%20-%20S01E02.ja.srt",
  "a relative download URL is resolved",
);
assert.equal(files.files[2].supported, false, "a zip is listed but not offered");
assert.equal(files.files[2].urlAllowed, false, "a listing cannot name another host");
assert.equal(files.files[2].urlReason, "file-url-off-origin");

assert.equal(imported.parseFileList({}).reason, "file-list-not-a-list");
assert.equal(imported.parseFileList([]).reason, "file-list-empty");
assert.equal(imported.parseFileList([{ name: "no-url.srt" }]).skipped, 1);
assert.equal(imported.resolveJimakuUrl("").reason, "empty-file-url");
assert.equal(imported.resolveJimakuUrl("http://jimaku.cc/x.srt").reason, "file-url-off-origin");

// --- Which file belongs to the episode ---------------------------------------

const ep1 = { name: "Show - S01E01.ja.srt", supported: true, episode: 1, language: "Japanese", languageCode: "ja", size: 30000 };
const ep2 = { name: "Show - S01E02.ja.srt", supported: true, episode: 2, language: "Japanese", languageCode: "ja", size: 31000 };
const ep2en = { name: "Show - S01E02.en.srt", supported: true, episode: 2, language: "English", languageCode: "en", size: 28000 };
const zipped = { name: "Show Batch.zip", supported: false, episode: null, language: "", languageCode: "", size: 900000 };
const unnumbered = { name: "Show Movie.srt", supported: true, episode: null, language: "Japanese", languageCode: "ja", size: 20000 };

// A viewer reading English is offered the file already written in English
// first, because that is the file that needs no translation at all.
const chosen = imported.chooseFileForEpisode([ep1, ep2, ep2en, zipped], 2, {
  targetLanguage: "English",
});
assert.equal(chosen.file.name, "Show - S01E02.en.srt");
assert.equal(chosen.ambiguous, true, "more than one file could be this episode");
assert.equal(chosen.reason, "episode-matches-tie");
assert.equal(chosen.candidates, 2);
assert.equal(chosen.rejected, 2, "another episode and an archive are not candidates");

// The same listing recommends the Japanese file to a viewer reading Japanese.
assert.equal(
  imported.chooseFileForEpisode([ep1, ep2, ep2en, zipped], 2, {
    targetLanguage: "Japanese",
  }).file.name,
  "Show - S01E02.ja.srt",
);

// One file naming the episode is not a tie even when another file exists.
const singleMatch = imported.chooseFileForEpisode([ep1, unnumbered], 1);
assert.equal(singleMatch.file.name, "Show - S01E01.ja.srt");
assert.equal(singleMatch.reason, "episode-match");
assert.equal(singleMatch.ambiguous, false);

// Two releases of the same episode are still a choice for the viewer, and the
// recommendation between them is by size: a smaller file is likelier to be the
// single episode than a batch.
const tie = imported.chooseFileForEpisode(
  [{ ...ep2, name: "A.srt", size: 40000 }, { ...ep2, name: "B.srt", size: 20000 }],
  2,
);
assert.equal(tie.ambiguous, true);
assert.equal(tie.reason, "episode-matches-tie");
assert.equal(tie.file.name, "B.srt");

// A file with no language tag at all ranks below a labelled one.
assert.equal(
  imported.chooseFileForEpisode(
    [{ ...ep2, name: "Untagged.srt", languageCode: "", size: 1000 }, ep2en],
    2,
    { targetLanguage: "English" },
  ).file.name,
  "Show - S01E02.en.srt",
);

// A file that names another episode is never silently used for this one.
assert.equal(imported.chooseFileForEpisode([ep1, zipped], 5).file, null);
assert.equal(imported.chooseFileForEpisode([ep1, zipped], 5).reason, "no-file-for-episode");
// A file that names no episode is the only candidate when nothing else is.
assert.equal(
  imported.chooseFileForEpisode([zipped, unnumbered], 5).file.name,
  "Show Movie.srt",
);
assert.equal(
  imported.chooseFileForEpisode([zipped, unnumbered], 5).reason,
  "no-episode-number-in-name",
);
// An archive alone is not a subtitle.
assert.equal(imported.chooseFileForEpisode([zipped], 1).reason, "no-supported-file");
assert.equal(imported.chooseFileForEpisode([], 1).reason, "no-files");
assert.equal(imported.chooseFileForEpisode(null, 1).reason, "no-files");

// --- Imported tracks ---------------------------------------------------------

assert.equal(imported.episodeKeyFor("8123", "netflix"), "8123");
assert.equal(imported.episodeKeyFor("8123", "primevideo"), "primevideo~8123");
assert.equal(
  imported.episodeKeyFor("B0B6GZ954Y", "primevideo"),
  "primevideo~B0B6GZ954Y",
);
assert.equal(
  imported.episodeKeyFor("amzn1.dv.gti.abc-123", "primevideo"),
  "primevideo~amzn1.dv.gti.abc-123",
);
assert.equal(imported.episodeKeyFor("unknown", "netflix"), "");
assert.equal(imported.episodeKeyFor("", "netflix"), "");
// Episode keys and cache ids agree about which service an id belongs to.
assert.equal(identity.decodeEpisodeKey(imported.episodeKeyFor("8123", "netflix")).siteId, "netflix");
assert.equal(
  identity.decodeEpisodeKey(imported.episodeKeyFor("B0B6GZ954Y", "primevideo")).siteId,
  "primevideo",
);

const track = {
  episodeKey: "primevideo~B0B6GZ954Y",
  entryId: 1811,
  entryName: "Mobile Suit Gundam: The Witch from Mercury",
  entryUrl: "https://jimaku.cc/entry/1811",
  fileName: "[Judas] Show - S01E01.ja.srt",
  fileUrl: "https://jimaku.cc/entry/1811/download/x.srt",
  size: 30974,
  format: "srt",
  language: "Japanese",
  languageCode: "ja",
  translate: false,
  translateReason: "track-language-differs",
  cueCount: 3,
  importedAt: "2026-09-18T07:00:00.000Z",
  text: srtSample,
};

const normalized = imported.normalizeImportedTrack(track);
assert.equal(normalized.episodeKey, "primevideo~B0B6GZ954Y");
assert.equal(normalized.language, "Japanese");
assert.equal(normalized.translate, false);
assert.equal(normalized.text, srtSample);
// The summary the interfaces read never carries the subtitle text.
const summary = imported.trackSummary(track);
assert.equal(summary.text, undefined, "a summary must not carry subtitle text");
assert.equal(summary.hasText, true);
assert.equal(summary.fileName, "[Judas] Show - S01E01.ja.srt");
assert.equal(imported.trackSummary(null), null);
assert.equal(imported.trackTextLength(track), srtSample.length);
assert.equal(imported.importedTrackBytes({ a: track, b: { text: "12345" } }), srtSample.length + 5);

assert.equal(imported.normalizeImportedTrack({ episodeKey: "8123", text: "" }), null);
assert.equal(imported.normalizeImportedTrack(null), null);
assert.equal(
  imported.normalizeImportedTrack({ episodeKey: "", text: "x" }),
  null,
  "a track without an episode key cannot be filed",
);

// A track stored before the source was recorded came from a Jimaku download,
// because that was the only way in.
assert.equal(imported.normalizeImportedTrack(track).source, "jimaku-download");
assert.equal(
  imported.normalizeImportedTrack({ ...track, source: "local-file", fileUrl: "" }).source,
  "local-file",
);
assert.equal(
  imported.normalizeImportedTrack({ ...track, source: "local-file", fileUrl: "" }).fileUrl,
  "",
  "a file from this device has no address to report",
);

// --- Where a file's timeline sits on the video's clock -----------------------
//
// A file made for another release of the same episode states its lines seconds
// or minutes away from the copy being watched, which is what the viewer sees as
// "not even close". LST renders an imported file from its own timeline, so that
// distance has to be expressible: the correction belongs to the file, and it has
// to reach far enough to be useful.

assert.equal(imported.FILE_TIMING_LIMIT_MS, 600000, "ten minutes either way");
assert.equal(imported.TIMING_GLOBAL_LIMIT_MS, 2000, "the setting's own range is unchanged");
assert.deepEqual(
  plain(imported.FILE_TIMING_STEPS_MS),
  [30000, 5000, 1000, 100],
  "coarse enough to reach another release, fine enough to finish by eye",
);
for (const step of imported.FILE_TIMING_STEPS_MS) {
  assert.ok(
    step > 0 && step <= imported.FILE_TIMING_LIMIT_MS,
    `a step of ${step}ms has to be inside the range it moves within`,
  );
}

// A correction that is not a number is not a correction, and one beyond the
// range is pulled back rather than refused: the viewer's press still counts.
assert.equal(imported.normalizeFileTiming(0), 0);
assert.equal(imported.normalizeFileTiming(undefined), 0);
assert.equal(imported.normalizeFileTiming(null), 0);
assert.equal(imported.normalizeFileTiming(""), 0);
assert.equal(imported.normalizeFileTiming("later"), 0);
assert.equal(imported.normalizeFileTiming(NaN), 0);
assert.equal(imported.normalizeFileTiming(Infinity), 0);
assert.equal(imported.normalizeFileTiming(8000), 8000);
assert.equal(imported.normalizeFileTiming(8000.6), 8001, "milliseconds are whole");
assert.equal(imported.normalizeFileTiming(-8000), -8000);
assert.equal(imported.normalizeFileTiming(600000), 600000);
assert.equal(imported.normalizeFileTiming(-700000), -600000);
assert.equal(imported.normalizeFileTiming(1e9), 600000);

// The one place the two corrections are added: the file's and the global one,
// both "positive is later". The player looks that much earlier in the timeline,
// and asks the same function for the reverse.
assert.equal(imported.timingLookupOffsetSeconds({}), 0);
assert.equal(
  imported.timingLookupOffsetSeconds({ fileTimingMs: 8000 }),
  8,
  "a file that has to be shown later is looked up earlier by the same amount",
);
assert.equal(
  imported.timingLookupOffsetSeconds({ fileTimingMs: 8000, globalOffsetMs: 500 }),
  8.5,
  "the global setting still applies on top of the file's own correction",
);
assert.equal(
  imported.timingLookupOffsetSeconds({ globalOffsetMs: 500 }),
  0.5,
  "with no file in use only the global setting moves anything",
);
assert.equal(
  imported.timingLookupOffsetSeconds({ fileTimingMs: "nonsense", globalOffsetMs: NaN }),
  0,
  "a correction that is not a number cannot move a subtitle",
);

// Whose clock the timing controls move. Both pages ask this, so neither can
// point at a different one than the other.
assert.equal(imported.timingTargetFor(null).scope, "global");
assert.equal(
  imported.timingTargetFor(undefined, { globalOffsetMs: 250 }).offsetMs,
  250,
  "with no imported file the buttons move the global setting, unchanged",
);
assert.equal(imported.timingTargetFor(null).limitMs, 2000);
const fileTarget = imported.timingTargetFor(
  { episodeKey: "primevideo~B0B6GZ954Y", fileName: "ep.srt", timingOffsetMs: 8000 },
  { globalOffsetMs: 250 },
);
assert.equal(fileTarget.scope, "imported-file");
assert.equal(fileTarget.episodeKey, "primevideo~B0B6GZ954Y", "the correction is stored per episode");
assert.equal(fileTarget.offsetMs, 8000, "an imported file's own number, not the global one");
assert.equal(fileTarget.limitMs, 600000);
assert.equal(fileTarget.fileName, "ep.srt");
assert.equal(
  imported.timingTargetFor({ episodeKey: "8123", timingOffsetMs: "nonsense" }).offsetMs,
  0,
  "a file stored before this existed is in step with the video",
);

// One sentence for the correction, so the player, the popup and the card cannot
// describe the same number three ways.
const inStep = plain(imported.describeFileTiming(0));
assert.equal(inStep.label, "in step");
assert.equal(inStep.tone, "");
assert.match(inStep.sentence, /where the file says/);
const later = plain(imported.describeFileTiming(8000));
assert.equal(later.label, "+8 s");
assert.match(later.sentence, /8 seconds later than the file says/);
const earlier = plain(imported.describeFileTiming(-1500));
assert.equal(earlier.label, "-1.5 s");
assert.match(earlier.sentence, /1.5 seconds earlier than the file says/);
const oneSecond = plain(imported.describeFileTiming(1000));
assert.equal(oneSecond.label, "+1 s");
assert.match(oneSecond.sentence, /1 second later/, "one second is not one seconds");
// A correction at the limit says so: a file that far out is usually a file for
// another release, and no further press will fix it.
const atLimit = plain(imported.describeFileTiming(600000));
assert.equal(atLimit.atLimit, true);
assert.equal(atLimit.tone, "warn");
assert.match(atLimit.sentence, /another release/);

// The correction travels with the file, and a file stored before it existed is
// shown where its own timeline says.
assert.equal(imported.normalizeImportedTrack({ ...track, timingOffsetMs: 8000 }).timingOffsetMs, 8000);
assert.equal(imported.normalizeImportedTrack(track).timingOffsetMs, 0);
assert.equal(
  imported.normalizeImportedTrack({ ...track, timingOffsetMs: "nonsense" }).timingOffsetMs,
  0,
);
assert.equal(
  imported.normalizeImportedTrack({ ...track, timingOffsetMs: 1e9 }).timingOffsetMs,
  600000,
  "a stored correction is read back inside the range the module allows",
);
// The summary the interfaces read carries it, so the popup moves the same number
// the player does.
assert.equal(imported.trackSummary({ ...track, timingOffsetMs: 8000 }).timingOffsetMs, 8000);
assert.equal(imported.trackSummary(track).text, undefined);

// --- What Jimaku held for a show ---------------------------------------------
//
// The player answers "are there subtitles for this show?" on arrival, and it does
// that from a note rather than from a request. A note is what a search or a file
// listing left behind, and these are the rules it is written and read by.

const checkedAt = "2026-09-18T09:00:00.000Z";
const now = Date.parse("2026-09-18T12:00:00.000Z");

// A note is only usable when it names a show and says when it was taken. This
// module has no clock of its own, so a caller that forgets to state one gets no
// note rather than one stamped with a guess.
assert.equal(
  imported.findingFromSearch({ showKey: "the-witcher", entries: [], checkedAt }).entryCount,
  0,
  "a search that found nothing is still an answer worth keeping",
);
assert.equal(
  imported.findingFromSearch({ showKey: "the-witcher", entries: [], checkedAt: "" }),
  null,
  "a note without a time is refused rather than stamped with a guess",
);
assert.equal(
  imported.findingFromSearch({ showKey: "", entries: [], checkedAt }),
  null,
  "a note without a show cannot be found again",
);
assert.equal(imported.findingFromSearch({ entries: [], checkedAt }), null);
assert.equal(imported.normalizeJimakuFinding({ showKey: "a", checkedAt: "not a time" }), null);
assert.equal(imported.normalizeJimakuFinding(null), null);

const searchNote = imported.findingFromSearch({
  showKey: "the-witcher",
  siteId: "netflix",
  showName: "The Witcher",
  query: "The Witcher",
  entries: [{ entryId: 1811 }, { entryId: 1812 }],
  checkedAt,
});
assert.equal(searchNote.entryCount, 2);
assert.equal(searchNote.fileCount, null, "a search lists entries, not files");
assert.equal(searchNote.episode, null);
assert.equal(searchNote.entryId, 0);

// Listing an entry's files sharpens the note instead of making a new one, which
// is the difference between "Jimaku knows this show" and "there is a file for
// this episode".
const filesNote = imported.findingForFiles({
  finding: searchNote,
  entryId: 1811,
  entryName: "Mobile Suit Gundam: The Witch from Mercury",
  files: [{ url: "a" }, { url: "b" }],
  episode: 7,
  checkedAt: "2026-09-18T10:00:00.000Z",
});
assert.equal(filesNote.showKey, "the-witcher");
assert.equal(filesNote.fileCount, 2);
assert.equal(filesNote.episode, 7);
assert.equal(filesNote.entryName, "Mobile Suit Gundam: The Witch from Mercury");
assert.equal(filesNote.checkedAt, "2026-09-18T10:00:00.000Z");
assert.equal(
  imported.findingForFiles({ finding: null, files: [], checkedAt }),
  null,
  "a listing cannot invent a note about a show nobody searched for",
);
const emptyListing = imported.findingForFiles({
  finding: searchNote,
  entryId: 1811,
  entryName: "The Witcher",
  files: [],
  episode: 7,
  checkedAt,
});
assert.equal(emptyListing.fileCount, 0, "no files is an answer, not a missing value");

// One owner for what a note means, so the player, the popup and the options card
// cannot describe the same note three ways.
assert.equal(imported.describeJimakuFinding(null), null);
assert.equal(imported.describeJimakuFinding({ showKey: "a" }), null);
const nothing = imported.describeJimakuFinding(
  imported.findingFromSearch({ showKey: "x", showName: "Some Show", entries: [], checkedAt }),
  { now },
);
assert.match(nothing.headline, /lists nothing for Some Show/);
assert.equal(nothing.tone, "warn");
assert.match(nothing.detail, /today/);
const entries = imported.describeJimakuFinding(searchNote, { now });
assert.match(entries.headline, /holds 2 entries for The Witcher/);
assert.equal(entries.tone, "info");
assert.equal(imported.describeJimakuFinding(searchNote).detail.includes("on 2026-09-18"), true,
  "without a clock the date is stated rather than an age guessed at");
const listed = imported.describeJimakuFinding(filesNote, { now });
assert.match(listed.headline, /has 2 files for episode 7/);
assert.equal(listed.tone, "good");
const missing = imported.describeJimakuFinding(emptyListing, { now });
assert.match(missing.headline, /lists no file for episode 7/);
assert.equal(missing.tone, "warn");
// Every sentence states when LST asked, because a note is only ever as fresh as
// the last search the viewer ran.
for (const described of [nothing, entries, listed, missing]) {
  assert.match(described.detail, /(today|yesterday|days ago|on \d{4}-\d{2}-\d{2})/);
  assert.ok(described.reason, "every description says what the note is");
}
assert.equal(entries.headline.includes("1 entries"), false, "one entry is not one entries");
assert.equal(
  imported.describeJimakuFinding(
    imported.findingFromSearch({ showKey: "x", showName: "X", entries: [{}], checkedAt }),
    { now },
  ).headline,
  "Jimaku holds 1 entry for X",
);

// A note is refused once it is old enough that the listing behind it has
// probably changed.
assert.equal(imported.findingIsExpired(searchNote, now), false);
assert.equal(imported.findingIsExpired(searchNote, now + 30 * 24 * 60 * 60 * 1000), false);
assert.equal(imported.findingIsExpired(searchNote, now + 61 * 24 * 60 * 60 * 1000), true);
assert.equal(imported.findingIsExpired(searchNote, Date.parse("2026-09-01T00:00:00.000Z")), false,
  "a note is not expired because the clock moved backwards");
assert.equal(imported.findingIsExpired({ showKey: "a", checkedAt: "nonsense" }, now), true);
assert.equal(imported.findingIsExpired(null, now), true);
assert.equal(imported.JIMAKU_FINDING_MAX_AGE_MS, 60 * 24 * 60 * 60 * 1000);

// The four descriptions are four different reasons, so a note that reads oddly
// can be traced to the rule that wrote it.
assert.equal(
  new Set([nothing.reason, entries.reason, listed.reason, missing.reason]).size,
  4,
  "each kind of note says which kind it is",
);
assert.deepEqual(
  JSON.parse(JSON.stringify(imported.FINDING_REASON)),
  {
    none: "no-finding-yet",
    noShowKey: "no-show-key",
    nothingFound: "search-found-nothing",
    entriesFound: "search-found-entries",
    filesListed: "files-listed-for-episode",
    filesMissing: "entry-has-no-files",
    expired: "finding-expired",
    unreadable: "finding-unreadable",
  },
);

// --- Text becoming a track ----------------------------------------------------

// The same questions are asked about a file downloaded from Jimaku and about a
// file the viewer already had, so both go through describeTextTrack. These
// cases are the ones where the answer decides what a viewer sees on screen.

const vttSample = "WEBVTT\n\n00:00:03.087 --> 00:00:04.964\n編入手続きよし\n";
const ttmlSample =
  '<?xml version="1.0" encoding="utf-8"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="3s" end="4.9s">編入手続きよし</p></div></body></tt>';

// A file is only treated as timed text when it is shaped like it: a mislabelled
// file is refused at import time instead of stored and then dropped by the
// player.
assert.equal(imported.looksLikeTimedText(srtSample).reason, "timing-arrows");
assert.equal(imported.looksLikeTimedText(vttSample).reason, "webvtt-header");
assert.equal(imported.looksLikeTimedText(ttmlSample).reason, "ttml-root");
assert.equal(imported.looksLikeTimedText("").ok, false);
assert.equal(imported.looksLikeTimedText("Just some prose about a show.").reason, "not-timed-text");

const japaneseSrt = imported.describeTextTrack({
  fileName: "[Judas] Show - S01E04.ja.srt",
  text: srtSample,
  targetLanguage: "English",
  episode: 4,
});
assert.equal(japaneseSrt.ok, true);
assert.equal(japaneseSrt.format, "srt");
assert.equal(japaneseSrt.cueCount, 3);
assert.equal(japaneseSrt.bytes, srtSample.length);
assert.equal(japaneseSrt.language, "Japanese");
assert.equal(japaneseSrt.languageCode, "ja");
assert.equal(japaneseSrt.translate, true);
assert.equal(japaneseSrt.translateReason, "track-language-differs");
assert.equal(japaneseSrt.viewerChose, false);
assert.equal(japaneseSrt.episodeMatch.reason, "episode-match");

// The same file, read by a viewer who wants Japanese: nothing to translate, and
// therefore nothing to ask a provider for.
const alreadyReadable = imported.describeTextTrack({
  fileName: "[Judas] Show - S01E04.ja.srt",
  text: srtSample,
  targetLanguage: "Japanese",
});
assert.equal(alreadyReadable.translate, false);
assert.equal(alreadyReadable.translateReason, "track-already-in-target-language");

// The viewer's own instruction outranks the file's language, and says so.
const overruled = imported.describeTextTrack({
  fileName: "[Judas] Show - S01E04.ja.srt",
  text: srtSample,
  targetLanguage: "Japanese",
  translate: true,
});
assert.equal(overruled.translate, true);
assert.equal(overruled.translateReason, "viewer-choice");
assert.equal(overruled.viewerChose, true);

// WebVTT and TTML are parsed by content.js, so the module only checks that the
// text is timed text at all and reports no cues of its own.
const vtt = imported.describeTextTrack({
  fileName: "Show - S01E04.en.vtt",
  text: vttSample,
  targetLanguage: "English",
});
assert.equal(vtt.ok, true);
assert.equal(vtt.format, "vtt");
assert.equal(vtt.cueCount, 0);
assert.equal(vtt.translate, false, "an English file for an English reader is shown as it is");

const ttml = imported.describeTextTrack({
  fileName: "Show - S01E04.ttml",
  text: ttmlSample,
  targetLanguage: "English",
});
assert.equal(ttml.ok, true);
assert.equal(ttml.format, "ttml");

// Every refusal names what is wrong with the file.
const refusals = [
  [{ fileName: "Show.srt", text: "" }, "track-text-empty"],
  [{ fileName: "Show.zip", text: srtSample }, "track-format-unsupported"],
  [{ fileName: "Show.nfo", text: srtSample }, "track-format-unknown"],
  [{ fileName: "Show.srt", text: "this file is not a subtitle at all" }, "track-has-no-readable-cues"],
  [{ fileName: "Show.vtt", text: "Just some prose about a show." }, "track-is-not-timed-text"],
  [{ fileName: "Show.srt", text: srtSample, maxLength: 10 }, "track-text-too-large"],
];
for (const [options, reason] of refusals) {
  const result = imported.describeTextTrack({ targetLanguage: "English", ...options });
  assert.equal(result.ok, false, `${options.fileName} should be refused`);
  assert.equal(result.reason, reason, `${options.fileName} refusal reason`);
  assert.ok(result.fileName, "a refusal still names the file");
}

// The refusal vocabulary is the module's, and the background is the only place
// that turns one into a sentence.
assert.deepEqual(
  plain(imported.TRACK_TEXT_REFUSAL).empty,
  "track-text-empty",
);
assert.equal(
  new Set(Object.values(imported.TRACK_TEXT_REFUSAL)).size,
  Object.values(imported.TRACK_TEXT_REFUSAL).length,
  "each refusal reason is spelled once",
);

// A file whose own episode differs from the one playing is reported, never
// refused: the viewer chose the file and a service may number episodes its own
// way.
const otherEpisode = imported.describeTextTrack({
  fileName: "[Judas] Show - S01E07.ja.srt",
  text: srtSample,
  targetLanguage: "English",
  episode: 4,
});
assert.equal(otherEpisode.ok, true);
assert.equal(otherEpisode.episodeMatch.reason, "episode-mismatch");
assert.equal(otherEpisode.episodeMatch.fileEpisode, 7);
assert.equal(otherEpisode.episodeMatch.targetEpisode, 4);

assert.equal(
  imported.describeTextTrack({ fileName: "Show.srt", text: srtSample, episode: 4 })
    .episodeMatch.reason,
  "no-episode-number",
  "the note keeps the file-name parser's own reason",
);
assert.equal(
  imported.describeTextTrack({ fileName: "Show - S01E04.srt", text: srtSample })
    .episodeMatch.reason,
  "no-target-episode",
  "without a number from the page there is nothing to compare",
);
// A number the listing stated is used as it stands, ahead of the file name.
assert.equal(
  imported.describeTextTrack({
    fileName: "Show - S01E04.ja.srt",
    text: srtSample,
    episode: 4,
    fileEpisode: 5,
  }).episodeMatch.reason,
  "episode-mismatch",
);
assert.equal(
  imported.episodeMatchFor("Show - S01E04.srt", 4, 4).matches,
  true,
  "the listing's own episode number is enough",
);

// --- Bytes before text --------------------------------------------------------

// A subtitle file is bytes, and files packaged for a Japanese release are often
// Shift-JIS rather than UTF-8. Handing those to the player as replacement
// characters would make the import look broken when the file is fine.

const rainInJapanese = "雨が降っても";
const rainInShiftJis = [
  0x89, 0x4a, 0x82, 0xaa, 0x8d, 0x7e, 0x82, 0xc1, 0x82, 0xc4, 0x82, 0xe0,
];
const srtHeader = "1\r\n00:00:03,087 --> 00:00:04,964\r\n";
const shiftJisSrt = (() => {
  const bytes = new Uint8Array(srtHeader.length + rainInShiftJis.length + 2);
  for (let i = 0; i < srtHeader.length; i += 1) bytes[i] = srtHeader.charCodeAt(i);
  bytes.set(rainInShiftJis, srtHeader.length);
  bytes.set([0x0d, 0x0a], srtHeader.length + rainInShiftJis.length);
  return bytes;
})();

const utf8File = imported.decodeSubtitleBytes(new TextEncoder().encode(srtHeader + rainInJapanese + "\r\n"));
assert.equal(utf8File.encoding, "utf-8");
assert.equal(utf8File.reason, "utf-8-decode");
assert.equal(utf8File.text, srtHeader + rainInJapanese + "\r\n");

const legacyFile = imported.decodeSubtitleBytes(shiftJisSrt);
assert.equal(legacyFile.reason, "shift-jis-fallback");
assert.equal(legacyFile.encoding, "shift_jis");
assert.equal(legacyFile.text, srtHeader + rainInJapanese + "\r\n");
// And the text it produced is usable: a Shift-JIS file yields readable cues.
assert.equal(imported.parseSrt(legacyFile.text).length, 1);
assert.equal(imported.parseSrt(legacyFile.text)[0].text, rainInJapanese);
assert.equal(
  imported.describeTextTrack({
    fileName: "Show - S01E04.ja.srt",
    text: legacyFile.text,
    targetLanguage: "Japanese",
  }).cueCount,
  1,
  "a file read from Shift-JIS is as ordinary an import as any other",
);

// A byte-order mark is not part of the first cue.
const withBom = imported.decodeSubtitleBytes(
  new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(srtHeader + rainInJapanese)]),
);
assert.equal(withBom.text.startsWith("1"), true);

assert.equal(imported.decodeSubtitleBytes([]).reason, "empty-subtitle-file");
assert.equal(imported.decodeSubtitleBytes("not bytes").reason, "not-a-byte-sequence");
assert.equal(imported.decodeSubtitleBytes(null).reason, "not-a-byte-sequence");
// A byte sequence in neither encoding is reported rather than guessed at, so a
// file is never silently filled with replacement characters.
const undecodable = imported.decodeSubtitleBytes([0x80]);
assert.equal(undecodable.reason, "undecodable-subtitle-file");
assert.equal(undecodable.text, "");

// --- Permissions and load order ----------------------------------------------

// The two hosts are optional at install time. A test fails if the manifest and
// the module ever disagree about which hosts LST may contact, or if one of them
// silently becomes a required permission.
const optionalHosts = manifest.optional_host_permissions || [];
assert.deepEqual(
  [...imported.HOST_ORIGINS].sort(),
  [...optionalHosts].sort(),
  "the manifest's optional hosts must be exactly the module's host list",
);
for (const origin of imported.HOST_ORIGINS) {
  assert.match(origin, /^https:\/\/[a-z0-9.-]+\/\*$/, `${origin} must be one https host`);
  assert.ok(
    !manifest.host_permissions.includes(origin),
    `${origin} must stay optional, not required`,
  );
  assert.ok(
    !manifest.host_permissions.some((entry) => /<all_urls>|\*:\/\//.test(entry)),
    "no broad host permission may be added",
  );
}
assert.ok(
  !JSON.stringify(manifest).includes("<all_urls>"),
  "the manifest must not ask for every site",
);

// The module is loaded wherever it is used, and after the modules it reads.
const backgroundScripts = manifest.background.scripts;
assert.ok(
  backgroundScripts.indexOf("shared/subtitle-import.js") > backgroundScripts.indexOf("shared/episode-identity.js"),
  "background.js must load after the identity module it reads",
);
assert.ok(
  backgroundScripts.indexOf("shared/subtitle-import.js") < backgroundScripts.indexOf("background/index.js"),
  "subtitle-import.js must load before background.js",
);
const pageScripts = manifest.content_scripts[1].js;
assert.ok(
  pageScripts.includes("shared/subtitle-import.js"),
  "the content script must load the import module",
);
assert.ok(
  pageScripts.indexOf("shared/subtitle-import.js") < pageScripts.indexOf("content/index.js"),
  "subtitle-import.js must load before content.js",
);
assert.ok(
  pageScripts.indexOf("shared/subtitle-import.js") > pageScripts.indexOf("shared/episode-identity.js"),
  "the identity module must load first",
);

for (const page of ["options.html", "popup.html"]) {
  const html = await read(page);
  assert.ok(
    /<script src="\.\.\/\.\.\/shared\/subtitle-import\.js"><\/script>/.test(html),
    `${page} must load subtitle-import.js`,
  );
  assert.ok(
    html.indexOf('<script src="../../shared/episode-identity.js">') <
      html.indexOf('<script src="../../shared/subtitle-import.js">'),
    `${page} must load the identity module first`,
  );
}

const packageJson = JSON.parse(await read("package.json"));
assert.equal(packageJson.scripts["check:syntax"], "node scripts/check-syntax.mjs");
assert.equal(packageJson.scripts["test:subtitle-import"], "node tests/test-subtitle-import.mjs");
assert.match(packageJson.scripts.check, /npm run test:subtitle-import/);
assert.ok(
  packageJson.scripts.check.indexOf("test:subtitle-import") <
    packageJson.scripts.check.indexOf("check:release"),
  "the import suite runs before the release check",
);
// Every file the background loads at runtime has to be in the packaged build.
const prepareBrowser = await read("scripts/prepare-browser.mjs");
assert.match(prepareBrowser, /readdir\("src"\)/);
const verifyPackage = await read("scripts/verify-package.mjs");
assert.match(verifyPackage, /"shared\/subtitle-import\.js"/);

// The interface is driven by element ids and by message names, and both are
// strings: a rename that misses one half fails here rather than at the moment a
// viewer presses Search.
const backgroundSource = await read("background.js");
const optionsSource = await read("options.js");
const contentSource = await read("content.js");
const popupSource = await read("popup.js");
const optionsHtml = await read("options.html");
for (const id of new Set(
  [...optionsSource.matchAll(/\$\("([a-zA-Z][a-zA-Z0-9_-]*)"\)/g)].map((match) => match[1]),
)) {
  assert.match(
    optionsHtml,
    new RegExp(`id="${id}"`),
    `options.js reads #${id}, which options.html does not define`,
  );
}
for (const id of new Set(
  [...(await read("popup.js")).matchAll(/\$\("([a-zA-Z][a-zA-Z0-9_-]*)"\)/g)].map((match) => match[1]),
)) {
  assert.match(
    await read("popup.html"),
    new RegExp(`id="${id}"`),
    `popup.js reads #${id}, which popup.html does not define`,
  );
}

// A popup is clipped at 600px by the browser, so the panel scrolls inside
// itself: a longer show name, the Jimaku note, or one more imported episode
// must not push the last row out of the panel with no way to reach it.
const popupCss = await read("popup.css");
assert.match(
  popupCss,
  /body\s*\{[^}]*max-height:\s*600px/,
  "the popup caps its own height rather than being clipped by the browser",
);
assert.match(
  popupCss,
  /main\s*\{[^}]*overflow-y:\s*auto/,
  "the panels scroll between a header and a footer that stay put",
);
assert.match(
  popupCss,
  /\.topbar\s*\{[^}]*flex:\s*0 0 auto/,
  "the header is not squeezed when the panels scroll",
);
assert.match(
  popupCss,
  /\.popup-footer-actions\s*\{[^}]*flex:\s*0 0 auto/,
  "the footer is not squeezed when the panels scroll",
);

// The in-player panel is the same promise inside the player: it scrolls, and the
// corner it opens from caps it, because a bottom corner leaves less room above it.
const inPlayerCss = await read("styles.css");
assert.match(
  inPlayerCss,
  /#lst-pill-menu\s*\{[^}]*overflow:\s*auto/,
  "the in-player panel scrolls rather than dropping its last section",
);
assert.match(
  inPlayerCss,
  /#lst-hud\[data-position="bottom-right"\] #lst-pill-menu/,
  "a bottom corner caps the panel for the status line and the Jimaku note below it",
);

// --- Correcting a file that does not line up ---------------------------------
//
// The correction is stored with the file, so it has to survive a reload, reach
// the popup, and move the line the viewer is watching without re-reading the
// file. Every one of those is a fact about a file in this repository, and none of
// them is visible from the module's own tests.

// The background refuses a correction for an episode that has no imported file:
// nothing would ever read it, and a number stored against an episode would be a
// correction for a file the viewer never chose.
assert.match(backgroundSource, /case "SET_IMPORTED_TRACK_TIMING":/);
const timingHandler = /case "SET_IMPORTED_TRACK_TIMING":[\s\S]*?\n      \}/.exec(backgroundSource);
assert.ok(timingHandler, "the background keeps one handler for the correction");
assert.match(timingHandler[0], /normalizeFileTiming\(message\.offsetMs\)/, "the module clamps what is stored");
assert.match(timingHandler[0], /reason: "not-imported"/, "a correction with no file to correct is refused");
assert.match(timingHandler[0], /trackSummary\(track\)/, "the caller is told what the track now is");

// A newly imported file starts in step: the correction belonged to the file the
// viewer replaced.
const recordSource = /function importedTrackRecord\([\s\S]*?\n\}/.exec(backgroundSource);
assert.ok(recordSource, "the background keeps one record shape for both sources");
assert.match(recordSource[0], /timingOffsetMs:\s*0/, "a new file is shown where its own timeline says");

// The player applies it in both directions from one function, so the lookup and
// the moment a line stops being shown cannot disagree.
const offsetSource = nestedFunctionSource(contentSource, "syncOffsetSeconds");
assert.match(offsetSource, /timingLookupOffsetSeconds/, "the module adds the two corrections and states the direction");
const lookupSource = nestedFunctionSource(contentSource, "subtitleLookupTime");
assert.match(lookupSource, /syncOffsetSeconds\(\)/, "the lookup asks for the correction that applies now");
assert.match(
  contentSource,
  /match\.cue\.end -[\s\S]{0,80}syncOffsetSeconds\(\)/,
  "the moment a line stops being shown adds the same correction back",
);
const fileTimingSource = nestedFunctionSource(contentSource, "fileTimingOffsetMs");
assert.match(fileTimingSource, /trackIsImported\(\)/, "only an imported file has a correction of its own");

// And the arithmetic itself, run: the player's own lookup, with the whole chain of
// the real functions, has to place a file's line where the viewer put it. A file
// whose lines are spoken eight seconds later than its timeline says is looked up
// eight seconds earlier, so the line the file schedules at 100 s is the line shown
// at 108 s — which is the entire feature, and the one thing a viewer notices if it
// is wrong.
const lookupSandbox = vm.createContext({
  console,
  Math,
  Number,
  Boolean,
  Array,
  // The real module, so the lookup runs against the function that adds the two
  // corrections rather than a copy of it.
  LSTSubtitleImport: imported,
});
const lookupScript = [
  "let cueTrackKind = 'imported';",
  "let importedTrack = { episodeKey: '8123', timingOffsetMs: 8000 };",
  "let settings = { subtitleTimingOffsetMs: 0 };",
  "let timedTrackLifecycle = { automaticOffsetSeconds: 0 };",
  "let warnedMissingSubtitleImport = false;",
  nestedFunctionSource(contentSource, "clamp"),
  nestedFunctionSource(contentSource, "subtitleImport"),
  nestedFunctionSource(contentSource, "trackIsImported"),
  nestedFunctionSource(contentSource, "fileTimingOffsetMs"),
  nestedFunctionSource(contentSource, "syncOffsetSeconds"),
  nestedFunctionSource(contentSource, "naturalSubtitleLookupTime"),
  nestedFunctionSource(contentSource, "subtitleLookupTime"),
  "globalThis.__lookup = subtitleLookupTime;",
  "globalThis.__moduleLoaded = () => typeof LSTSubtitleImport?.timingLookupOffsetSeconds === 'function';",
  "globalThis.__set = (track, offset, global, kind) => {",
  "  importedTrack = track; cueTrackKind = kind;",
  "  settings.subtitleTimingOffsetMs = global;",
  "};",
].join("\n");
vm.runInContext(lookupScript, lookupSandbox, { filename: "content-timing.js" });
assert.equal(
  lookupSandbox.__moduleLoaded(),
  true,
  "the lookup under test must go through the module's own arithmetic",
);

assert.equal(
  lookupSandbox.__lookup(108),
  100,
  "a file eight seconds later than the video is looked up eight seconds earlier",
);
lookupSandbox.__set({ episodeKey: "8123", timingOffsetMs: -10000 }, -10000, 0, "imported");
assert.equal(lookupSandbox.__lookup(108), 118, "a file shown ten seconds earlier is looked up ahead");
lookupSandbox.__set({ episodeKey: "8123", timingOffsetMs: 8000 }, 8000, 500, "imported");
assert.equal(
  lookupSandbox.__lookup(108),
  99.5,
  "the global setting is added to the file's correction rather than replacing it",
);
lookupSandbox.__set({ episodeKey: "8123", timingOffsetMs: 8000 }, 8000, 500, "captured");
assert.equal(
  lookupSandbox.__lookup(108),
  107.5,
  "the service's own track keeps moving with the global setting alone",
);
lookupSandbox.__set(null, 0, -1000, "imported");
assert.equal(lookupSandbox.__lookup(108), 109, "negative is earlier, as the setting has always said");

// Which clock the controls move is decided once, by the module, and both pages
// ask it rather than working it out themselves.
assert.match(contentSource, /timingTargetFor\(/, "the player asks which clock its timing buttons move");
assert.match(popupSource, /timingTargetFor\(/, "the popup asks the same question");
assert.match(contentSource, /SET_IMPORTED_TRACK_TIMING/, "a press in the player stores the correction with the file");
assert.match(popupSource, /SET_IMPORTED_TRACK_TIMING/, "a press in the popup stores the same correction");
// The viewer nudged until the line landed, so the player applies the number now
// rather than re-reading a file it is already showing.
const applySource = nestedFunctionSource(contentSource, "applyImportedFileTiming");
assert.match(applySource, /lastRenderedCueKey = ""/, "the line on screen is re-decided at once");
assert.match(
  nestedFunctionSource(contentSource, "refreshImportedTrack"),
  /applyImportedFileTiming/,
  "a correction made elsewhere reaches the player without re-reading the file",
);

// The buttons a page offers are the steps the module declares, both directions,
// on both pages: a step offered in markup but unknown to the module would move a
// file by an amount nothing else knows about.
const stepsIn = (source, pattern) =>
  [...source.matchAll(pattern)].map((match) => Number(match[1])).sort((a, b) => a - b);
const declaredSteps = [...imported.FILE_TIMING_STEPS_MS].flatMap((step) => [-step, step]).sort((a, b) => a - b);
for (const [label, source, pattern] of [
  ["content.js", contentSource, /data-file-timing-step="(-?\d+)"/g],
  ["popup.html", await read("popup.html"), /data-file-timing-step="(-?\d+)"/g],
]) {
  assert.deepEqual(
    stepsIn(source, pattern),
    declaredSteps,
    `${label} must offer exactly the steps the module declares, in both directions`,
  );
}

// Each page keeps both rows and hides the one that does not apply. A row that is
// a grid needs its own rule, because an author `display` beats the browser's own
// rule for [hidden]: without them both rows show at once, which is how this was
// caught in the popup.
assert.match(contentSource, /id="lst-pill-timing-file"[^>]*hidden/, "the player's file row starts hidden");
assert.match(contentSource, /id="lst-pill-timing-global"/, "the player keeps the global row beside it");
for (const [label, source, pattern] of [
  ["the player's rows", inPlayerCss, /\.lst-pill-timing > div\[hidden\]\s*\{\s*display:\s*none/],
  ["the popup's imported-file row", popupCss, /\.timing-file-grid\[hidden\][^{]*\{[^}]*display:\s*none/],
  ["the popup's global row", popupCss, /\.segmented\[hidden\][^{]*\{[^}]*display:\s*none/],
]) {
  assert.match(source, pattern, `${label} must be able to be hidden: a grid's display beats [hidden]`);
}
const updateTimingSource = nestedFunctionSource(contentSource, "updateQuickPillsTiming");
assert.match(updateTimingSource, /describeFileTiming/, "the panel says where the file is, in the module's own words");
assert.match(updateTimingSource, /globalRow\.hidden = importedScope/, "the row that does not apply is hidden");
assert.match(
  updateTimingSource,
  /also applies/,
  "a viewer who set the global offset is told it is still part of the sum",
);
assert.match(popupSource, /function renderTiming\(/, "the popup says which clock its buttons move");
assert.match(popupSource, /timingHelp/, "and names it in the panel it belongs to");

// The import card is the one place a viewer sees the correction without
// watching, so the file's own number is in the row.
assert.match(optionsSource, /describeFileTiming\(track\.timingOffsetMs\)/);

const senders = { "options.js": optionsSource, "popup.js": popupSource, "content.js": contentSource };
const backgroundMessages = [
  "GET_IMPORT_KEY_STATUS",
  "SET_IMPORT_KEY",
  "IMPORT_SEARCH",
  "IMPORT_LIST_FILES",
  "IMPORT_TRACK",
  "IMPORT_TRACK_TEXT",
  "GET_IMPORTED_TRACK",
  "LIST_IMPORTED_TRACKS",
  "DELETE_IMPORTED_TRACK",
  "GET_JIMAKU_FINDING",
  "DELETE_JIMAKU_FINDING",
];
for (const type of backgroundMessages) {
  assert.match(
    backgroundSource,
    new RegExp(`case "${type}":`),
    `background.js must handle ${type}`,
  );
  assert.ok(
    Object.values(senders).some((source) => source.includes(`type: "${type}"`)),
    `${type} is handled but nobody sends it`,
  );
}
for (const type of ["IMPORT_CHANGED", "GET_PAGE_STATUS"]) {
  assert.match(
    contentSource,
    new RegExp(`case "${type}":`),
    `content.js must handle ${type}`,
  );
  assert.ok(
    optionsSource.includes(`type: "${type}"`) || popupSource.includes(`type: "${type}"`),
    `${type} is handled but no page sends it`,
  );
}

// The player says what Jimaku holds for a show, and it must not find that out by
// asking on arrival: a page the viewer merely opened would then be telling a
// third party which shows are being watched. Every route to the player's copy of
// a note is a local read, and the only place that asks Jimaku is the button the
// viewer pressed.
for (const type of ["JIMAKU_CHANGED"]) {
  assert.match(contentSource, new RegExp(`case "${type}":`), `content.js must handle ${type}`);
  assert.ok(
    optionsSource.includes(`type: "${type}"`),
    `${type} is handled but the options page never sends it`,
  );
}
assert.equal(
  (contentSource.match(/type: "IMPORT_SEARCH"/g) || []).length,
  1,
  "the player asks Jimaku from exactly one place",
);
assert.equal(
  nestedFunctionSource(contentSource, "checkJimakuForShow").includes('type: "IMPORT_SEARCH"'),
  true,
  "and that place is the check the viewer pressed",
);
// One owner of the query: the player's Check Jimaku button and the import
// card's search box both ask this module to trim the show's name, so the two
// cannot trim it differently.
assert.equal(
  contentSource.split("\n").filter((line) => line.includes("queryFromShowName")).length,
  1,
  "the player trims the query in exactly one place, and the module owns it",
);
assert.match(nestedFunctionSource(contentSource, "checkJimakuForShow"), /queryFromShowName/);
assert.match(optionsSource, /queryFromShowName\(/);
assert.match(
  nestedFunctionSource(contentSource, "refreshJimakuFinding"),
  /type: "GET_JIMAKU_FINDING"/,
  "arriving at an episode reads a note rather than asking anyone",
);
assert.equal(
  /IMPORT_SEARCH/.test(nestedFunctionSource(contentSource, "refreshJimakuFinding")),
  false,
  "reading a note must never send a search",
);
assert.equal(
  /IMPORT_SEARCH/.test(nestedFunctionSource(contentSource, "updatePillSubtitleSource")),
  false,
  "drawing the pill must never send a search",
);
// The check is reachable from the pill's own button and nowhere else, so it
// cannot run because a page loaded.
assert.match(
  contentSource,
  /action === "check-jimaku"[\s\S]{0,200}checkJimakuForShow\(\)/,
  "the check runs from the pill button",
);
assert.equal(
  (contentSource.match(/checkJimakuForShow\(/g) || []).length,
  2,
  "checkJimakuForShow is defined and called from the pill button, nowhere else",
);
// The note is read where the episode is, not on a timer.
for (const call of [
  /refreshJimakuFinding\(\{ reason: "playback-start" \}\)/,
  /refreshJimakuFinding\(\{ reason: "episode-changed" \}\)/,
  /refreshJimakuFinding\(\{ reason: "title-resolved" \}\)/,
]) {
  assert.match(contentSource, call, "a note is read when the episode or its title changes");
}
assert.equal(
  /setInterval\([\s\S]{0,200}refreshJimakuFinding/.test(contentSource),
  false,
  "reading a note is not a polling loop",
);

// The note's storage key and its limits have one owner too, and the pages read
// the sentences from the module rather than writing their own.
assert.ok(
  !/["']jimakuFindings["']/.test(backgroundSource) &&
    !/["']jimakuFindings["']/.test(optionsSource) &&
    !/["']jimakuFindings["']/.test(contentSource) &&
    !/["']jimakuFindings["']/.test(popupSource),
  "the findings key is read from the module, not repeated",
);
assert.match(backgroundSource, /JIMAKU_FINDINGS_KEY/);
assert.match(backgroundSource, /findingIsExpired/);
assert.match(backgroundSource, /normalizeJimakuFinding/);
assert.match(popupSource, /describeJimakuFinding/, "the popup says what a note means in the module's words");
assert.match(optionsSource, /describeJimakuFinding/);
assert.match(contentSource, /describeJimakuFinding/);
for (const source of [optionsSource, popupSource]) {
  assert.equal(
    /entryCount|fileCount/.test(source),
    false,
    "a page that formats a note itself would keep working after a rename and then quietly say the wrong thing",
  );
}
assert.match(
  nestedFunctionSource(contentSource, "updateJimakuNote"),
  /jimakuFindingText\(\)/,
  "the player's sentence is the module's sentence",
);
assert.match(
  nestedFunctionSource(contentSource, "jimakuFindingText"),
  /describeJimakuFinding/,
  "and that one place asks the module for it",
);
// The note is the viewer's to close, and closing it is remembered per show.
assert.match(contentSource, /data-jimaku-action="dismiss"/);
assert.match(contentSource, /jimakuNoteDismissed\.add\(jimakuFinding\.showKey\)/);

// The storage key and the API-key slot have one owner, so the background and
// the pages cannot invent a second spelling of either.
assert.match(
  backgroundSource,
  /importScripts\([\s\S]{0,400}"\.\.\/shared\/subtitle-import\.js"/,
);
assert.ok(
  !/["']importedTracks["']/.test(backgroundSource),
  "background.js must read the storage key from the module, not repeat it",
);
assert.ok(
  !/["']importedTracks["']/.test(optionsSource),
  "options.js must read the storage key from the module, not repeat it",
);

// The decoding vocabulary is the module's too: a page that spelled one of its
// reasons itself would keep working after a rename and then quietly stop
// matching.
for (const reason of Object.values(plain(imported.DECODE_REASON))) {
  assert.ok(
    !optionsSource.includes(`"${reason}"`),
    `options.js must read DECODE_REASON.${reason} from the module`,
  );
}
assert.deepEqual(
  new Set(Object.values(plain(imported.DECODE_REASON))).size,
  Object.values(plain(imported.DECODE_REASON)).length,
  "each decode reason is spelled once",
);

// A file the viewer already has must never be fetched: the whole point of that
// path is that it needs no host permission and no network at all.
const localImportBody = /async function importLocalTrack\([\s\S]*?\n}\n/.exec(backgroundSource);
assert.ok(localImportBody, "background.js must keep a local-file import path");
assert.ok(
  !/fetch\(|importFetch\(|importJson\(/.test(localImportBody[0]),
  "importing a file from this device must not make a request",
);
assert.ok(
  !/jimakuApiKey|importKeyStorage/.test(localImportBody[0]),
  "a file from this device must not need the Jimaku key",
);

// Every reason the module can give for refusing a file has a sentence in the
// background, so a refusal is never shown to a viewer as nothing.
const refusalCases = [
  ...backgroundSource.matchAll(/case api\.TRACK_TEXT_REFUSAL\.([a-zA-Z]+):/g),
].map((match) => match[1]);
const refusalNames = Object.keys(plain(imported.TRACK_TEXT_REFUSAL));
for (const name of refusalNames) {
  assert.ok(
    refusalCases.includes(name),
    `TRACK_TEXT_REFUSAL.${name} has no sentence in background.js`,
  );
}
assert.ok(
  refusalCases.length >= refusalNames.length,
  "every refusal the module can report is handled",
);

// The file picker offers only what LST can read, so a viewer is never invited
// to choose a file that is then refused for its format.
const picker = /<input id="importFile"[^>]*accept="([^"]*)"/.exec(optionsHtml);
assert.ok(picker, "options.html must have a file picker");
for (const entry of picker[1].split(",").map((value) => value.trim()).filter(Boolean)) {
  if (entry.includes("/")) continue; // a MIME type, not an extension
  const extension = entry.replace(/^\./, "");
  assert.equal(
    imported.SUBTITLE_FORMATS.srt.extensions.includes(extension) ||
      imported.SUBTITLE_FORMATS.vtt.extensions.includes(extension) ||
      imported.SUBTITLE_FORMATS.ttml.extensions.includes(extension),
    true,
    `the picker offers .${extension}, which LST cannot read`,
  );
}
assert.match(
  optionsHtml,
  /id="importFile"[\s\S]{0,400}?aria-labelledby="importLocalHeading"/,
  "the picker is labelled by the heading beside it",
);

// --- The permission the running copy was loaded with --------------------------

// A browser grants an optional host only if the manifest the copy was *loaded*
// with declared it, and Firefox keeps that manifest for the life of the load.
// A copy loaded before LST declared the two hosts therefore answers with the
// browser's own words — "Cannot request origin permission for
// https://jimaku.cc/* since it was not declared in the manifest" — which name
// neither the cause nor the fix. The page reads the manifest it is actually
// running under instead, and turns that one failure into instructions.

// A top-level function's source, for the module-style guards below.
function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start > -1, `options.js must keep ${name}()`);
  const end = source.indexOf("\n}", start);
  return source.slice(start, end + 2);
}

// The same, for a function nested inside content.js's one IIFE, where nothing
// closes at the start of a line. The parameter list is skipped first — it has
// braces of its own when it destructures — and then braces are counted, so the
// caller gets that function and not the rest of the file.
function nestedFunctionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start > -1, `content.js must keep ${name}()`);
  let parens = 0;
  let body = source.indexOf("(", start);
  for (; body < source.length; body += 1) {
    if (source[body] === "(") parens += 1;
    else if (source[body] === ")") {
      parens -= 1;
      if (parens === 0) break;
    }
  }
  let depth = 0;
  for (let index = source.indexOf("{", body); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

for (const name of ["declaredImportHosts", "declaresImportHosts", "undeclaredImportMessage"]) {
  functionSource(optionsSource, name);
}
assert.match(
  functionSource(optionsSource, "declaredImportHosts"),
  /getManifest/,
  "the live manifest is the only thing that can answer whether a host may be requested",
);
assert.match(
  functionSource(optionsSource, "declaredImportHosts"),
  /optional_permissions/,
  "a build may declare the hosts under the older key, and the browser honours it",
);
assert.match(
  optionsSource,
  /was not declared in the manifest/,
  "the browser's own wording must be recognised, not shown to the viewer",
);
assert.match(
  functionSource(optionsSource, "undeclaredImportMessage"),
  /Reload/,
  "the sentence for an undeclared host has to say what fixes it",
);
assert.match(
  functionSource(optionsSource, "undeclaredImportMessage"),
  /JIMAKU_ORIGIN/,
  "the host in that sentence comes from the module, not from a second spelling",
);
assert.ok(
  !/jimaku\.cc|subtitlebot\.com/.test(optionsSource),
  "options.js must not spell out a host the module already owns",
);

// The decision itself, run for real: declared, undeclared, declared the older
// way, and unreadable.
function pageAccess(manifestObject) {
  const source = [
    functionSource(optionsSource, "declaredImportHosts"),
    functionSource(optionsSource, "declaresImportHosts"),
  ].join("\n");
  const context = vm.createContext({
    ext: { runtime: { getManifest: () => manifestObject } },
  });
  vm.runInContext(`${source}\nglobalThis.__declares = declaresImportHosts;`, context);
  return context.__declares;
}

const hosts = [...imported.HOST_ORIGINS];
assert.equal(pageAccess({ optional_host_permissions: hosts })(hosts), true);
assert.equal(pageAccess({ optional_host_permissions: [...hosts, "https://example.org/*"] })(hosts), true);
assert.equal(
  pageAccess({ optional_host_permissions: [] })(hosts),
  false,
  "a copy loaded without the declaration is caught before the browser refuses it",
);
assert.equal(
  pageAccess({ optional_host_permissions: ["https://jimaku.cc/*"] })(hosts),
  false,
  "half the declaration is not the declaration",
);
assert.equal(
  pageAccess({ optional_permissions: hosts })(hosts),
  true,
  "hosts declared under the older key are declared",
);
assert.equal(
  pageAccess({ optional_permissions: [] })(hosts),
  false,
  "the older key declaring nothing is the same answer as the newer one doing so",
);
assert.equal(
  pageAccess({})(hosts),
  true,
  "a manifest that says nothing about optional hosts is not evidence of staleness",
);
const unreadable = vm.createContext({
  ext: {
    runtime: {
      getManifest: () => {
        throw new Error("no manifest");
      },
    },
  },
});
vm.runInContext(
  `${functionSource(optionsSource, "declaredImportHosts")}
   ${functionSource(optionsSource, "declaresImportHosts")}
   globalThis.__declares = declaresImportHosts;`,
  unreadable,
);
assert.equal(
  unreadable.__declares(hosts),
  true,
  "a manifest that cannot be read is not an accusation either",
);

// Firefox refuses `permissions.request` outside a user input handler (the API
// is declared `requireUserInput`), and an await before the call ends that
// handler's turn — so every click that can ask for access must ask first.
for (const trigger of ["importSearch", "importResults", "importFiles"]) {
  const handler = new RegExp(
    `\\$\\("${trigger}"\\)\\.addEventListener\\("click",[\\s\\S]*?\\n\\}\\);`,
  ).exec(optionsSource);
  assert.ok(handler, `options.js must keep the click handler for #${trigger}`);
  const firstAwait = handler[0].indexOf("await");
  assert.ok(firstAwait > -1, `the #${trigger} handler must await the permission step`);
  assert.ok(
    handler[0].slice(firstAwait).startsWith("await ensureImportAccess()"),
    `the #${trigger} handler must ask for access before anything else: an await first would make the browser refuse the request`,
  );
}

console.log("subtitle-import tests passed");
