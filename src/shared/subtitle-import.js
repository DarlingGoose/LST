(() => {
  "use strict";

  // Subtitle import — where a subtitle comes from when it did not come from the
  // player.
  //
  // A viewer watching a title the service does not subtitle can attach a
  // subtitle file instead, and LST uses that file as the episode's track: the
  // same cues, the same overlay, the same cache as a captured track, with one
  // difference that matters — a file written in the language the viewer wants to
  // read is displayed without asking any translation provider for anything.
  //
  // Every fact about the two services this uses lives here, so the background,
  // the extension's own pages, and the content script answer the same
  // questions the same way:
  //
  //  * which endpoints are asked, and with which parameters;
  //  * what a search result, a file listing, and a subtitle file look like;
  //  * which file belongs to which episode, and why;
  //  * which SubRip cues a file contains;
  //  * what language a file is in, and whether that language is the one the
  //    viewer asked for;
  //  * where an imported track is stored, keyed by episode rather than by
  //    model, so changing the translation model does not lose the import.
  //
  // This module is pure: it takes strings and returns records. It performs no
  // network request, touches no storage, and starts no timer. `HOST_ORIGINS` is
  // the one place that names the two hosts, and the manifest's optional
  // permissions, the options page and the tests all read it from here so none
  // of them can disagree about what LST may contact.

  const JIMAKU_ORIGIN = "https://jimaku.cc";
  const SUBTITLEBOT_ORIGIN = "https://www.subtitlebot.com";

  // Requested at the moment a viewer asks for an import, never at install: LST
  // keeps the two hosts out of its install-time permission set.
  const HOST_ORIGINS = Object.freeze([
    `${JIMAKU_ORIGIN}/*`,
    `${SUBTITLEBOT_ORIGIN}/*`,
  ]);

  const SEARCH_PATH = "/api/jimaku/search";
  const SEARCH_LIMIT = 50;

  // One storage key holds every imported track, keyed by episode.
  const IMPORTED_TRACKS_KEY = "importedTracks";
  const IMPORTED_TRACK_LIMIT = 500;
  const MAX_TRACK_BYTES = 8 * 1024 * 1024;
  const MAX_TRACK_TEXT_LENGTH = 8 * 1024 * 1024;

  const JIMAKU_KEY_STORAGE = "jimakuApiKey";

  // What Jimaku held for a show the last time LST asked. One key holds every
  // note, keyed by show.
  const JIMAKU_FINDINGS_KEY = "jimakuFindings";
  const JIMAKU_FINDING_LIMIT = 200;
  // A note about a show the viewer stopped watching is not worth keeping, and a
  // stale one is worse than none: it would send them to a listing that changed.
  const JIMAKU_FINDING_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

  // Where a track came from. It is recorded rather than inferred, because the
  // two sources are not interchangeable to the viewer: one was downloaded from
  // a host LST was granted access to, the other never left the device.
  const TRACK_SOURCE = Object.freeze({
    jimaku: "jimaku-download",
    localFile: "local-file",
  });

  const FORMAT_REASON = Object.freeze({
    known: "subtitle-format-from-extension",
    unknown: "subtitle-format-unknown",
  });

  // Every reason a piece of text can fail to become a track. The background
  // turns each of these into one sentence and a test fails if a reason ever
  // escapes without a sentence of its own.
  const TRACK_TEXT_REFUSAL = Object.freeze({
    empty: "track-text-empty",
    tooLarge: "track-text-too-large",
    unsupportedFormat: "track-format-unsupported",
    unknownFormat: "track-format-unknown",
    unreadableCues: "track-has-no-readable-cues",
    notTimedText: "track-is-not-timed-text",
  });

  // How a file's bytes were read. The encoding is named rather than assumed, so
  // "the subtitles look wrong" can be answered with what LST actually did.
  const DECODE_REASON = Object.freeze({
    utf8: "utf-8-decode",
    shiftJis: "shift-jis-fallback",
    utf8Lossy: "utf-8-with-replacements",
    notBytes: "not-a-byte-sequence",
    empty: "empty-subtitle-file",
    undecodable: "undecodable-subtitle-file",
  });

  // What LST can read. SubRip is what the sources this feature talks to mostly
  // serve; WebVTT and TTML arrive from the player and are parsed by content.js.
  // A format that is named and unsupported is reported as unsupported rather
  // than offered and then failing at parse time.
  const SUBTITLE_FORMATS = Object.freeze({
    srt: { label: "SubRip", supported: true, extensions: ["srt"] },
    vtt: { label: "WebVTT", supported: true, extensions: ["vtt", "webvtt"] },
    ttml: {
      label: "TTML",
      supported: true,
      extensions: ["ttml", "dfxp", "xml"],
    },
    ass: { label: "ASS/SSA", supported: false, extensions: ["ass", "ssa"] },
    zip: { label: "archive", supported: false, extensions: ["zip"] },
    sub: { label: "MicroDVD", supported: false, extensions: ["sub"] },
  });

  const UNKNOWN_FORMAT = Object.freeze({
    format: "unknown",
    label: "unrecognized format",
    supported: false,
    reason: FORMAT_REASON.unknown,
  });

  function fileExtension(name) {
    const match = /\.([a-z0-9]{1,8})$/i.exec(String(name || "").trim());
    return match ? match[1].toLowerCase() : "";
  }

  function subtitleFormat(name) {
    const extension = fileExtension(name);
    if (!extension) return { ...UNKNOWN_FORMAT };
    for (const [format, entry] of Object.entries(SUBTITLE_FORMATS)) {
      if (!entry.extensions.includes(extension)) continue;
      return {
        format,
        label: entry.label,
        supported: entry.supported,
        reason: entry.supported ? FORMAT_REASON.known : "subtitle-format-unsupported",
      };
    }
    return { ...UNKNOWN_FORMAT };
  }

  // Episode numbers -----------------------------------------------------------
  //
  // This is a guess, and it is labelled as one: the file name is the only thing
  // that says which episode a file belongs to. The patterns run from the most
  // explicit form to the loosest, and the reason records which one decided, so a
  // wrong match can be seen rather than guessed at.

  const EPISODE_PATTERNS = [
    { reason: "season-episode", pattern: /s(\d{1,2})\s*[.\-_ ]?\s*e(\d{1,3})/i, group: 2 },
    { reason: "episode-marker", pattern: /\be(?:p(?:isode)?)?\s*[.\-_ ]?\s*(\d{1,3})\b/i, group: 1 },
    { reason: "dash-number", pattern: /\s[-–—]\s(\d{1,3})(?:v\d)?(?=\s|\.|\[|\(|$)/, group: 1 },
    { reason: "bracketed-number", pattern: /\[(\d{1,3})(?:v\d)?\]/, group: 1 },
  ];

  // Release noise that would otherwise be read as an episode number.
  const FILE_NOISE_PATTERNS = [
    /\[[0-9a-f]{6,16}\]/gi,
    /\([^()]*\)/g,
    /\[[^\]]*\]/g,
    /\b\d{3,4}x\d{3,4}\b/gi,
    /\b\d{3,4}p\b/gi,
    /\b(?:x|h)26[45]\b/gi,
    /\b(?:hevc|avc|av1|vp9|10bit|8bit|web-?dl|blu-?ray|bd(?:rip)?|dvd(?:rip)?|remux|hdtv|atvp|amzn|dsnp|nf|cr|hulu)\b/gi,
    /\b(?:aac|ac3|eac3|flac|opus|dts|mp3)\b/gi,
    /\b(?:multi|dual|vostfr|subs?|cc|hi|sdh|signs?|songs?)\b/gi,
    /\b(?:season|saison|staffel|temporada)\b/gi,
    /\b(?:19|20)\d{2}\b/g,
  ];

  const MAX_EPISODE_NUMBER = 2000;

  function episodeNumberFromFileName(name) {
    const raw = String(name || "").trim();
    if (!raw) return { episode: null, reason: "empty-file-name" };
    const base = raw.replace(/\.[a-z0-9]{1,8}$/i, "");

    for (const { reason, pattern, group } of EPISODE_PATTERNS) {
      const match = pattern.exec(base);
      if (!match) continue;
      const value = Number(match[group]);
      if (!Number.isInteger(value) || value < 0 || value > MAX_EPISODE_NUMBER) {
        continue;
      }
      return { episode: value, reason };
    }

    // Last resort: whatever number survives once release noise is removed. It
    // is still reported as a loose match, because a title may carry a number of
    // its own.
    let stripped = base;
    for (const pattern of FILE_NOISE_PATTERNS) {
      stripped = stripped.replace(pattern, " ");
    }
    const loose = [...stripped.matchAll(/(?:^|[\s._-])(\d{1,3})(?:v\d)?(?:$|[\s._-])/g)]
      .map((match) => Number(match[1]))
      .filter(
        (value) =>
          Number.isInteger(value) && value > 0 && value <= MAX_EPISODE_NUMBER,
      );
    if (loose.length) {
      return { episode: loose[loose.length - 1], reason: "loose-number" };
    }
    return { episode: null, reason: "no-episode-number" };
  }

  // File languages ------------------------------------------------------------

  // The codes these sources actually tag files with, mapped to the name LST
  // compares against the viewer's target language. A code LST does not know is
  // reported as unknown rather than assumed English.
  const LANGUAGE_BY_CODE = Object.freeze({
    ar: "Arabic",
    bg: "Bulgarian",
    ca: "Catalan",
    cs: "Czech",
    da: "Danish",
    de: "German",
    el: "Greek",
    en: "English",
    es: "Spanish",
    et: "Estonian",
    fa: "Persian",
    fi: "Finnish",
    fil: "Filipino",
    fr: "French",
    he: "Hebrew",
    hi: "Hindi",
    hr: "Croatian",
    hu: "Hungarian",
    id: "Indonesian",
    it: "Italian",
    ja: "Japanese",
    ko: "Korean",
    lt: "Lithuanian",
    lv: "Latvian",
    ms: "Malay",
    nl: "Dutch",
    no: "Norwegian",
    pl: "Polish",
    pt: "Portuguese",
    ro: "Romanian",
    ru: "Russian",
    sk: "Slovak",
    sl: "Slovenian",
    sr: "Serbian",
    sv: "Swedish",
    th: "Thai",
    tr: "Turkish",
    uk: "Ukrainian",
    vi: "Vietnamese",
    zh: "Chinese",
  });

  // Spellings that appear in file names but do not follow the two-letter code.
  const LANGUAGE_ALIASES = Object.freeze({
    jp: "ja",
    jpn: "ja",
    japanese: "ja",
    "日本語": "ja",
    eng: "en",
    english: "en",
    "英語": "en",
    chi: "zh",
    zho: "zh",
    chs: "zh",
    cht: "zh",
    chinese: "zh",
    "中文": "zh",
    "简体": "zh",
    "繁體": "zh",
    kor: "ko",
    korean: "ko",
    "한국어": "ko",
    deu: "de",
    ger: "de",
    german: "de",
    fre: "fr",
    fra: "fr",
    french: "fr",
    spa: "es",
    spanish: "es",
    por: "pt",
    portuguese: "pt",
    ita: "it",
    italian: "it",
    rus: "ru",
    russian: "ru",
    dut: "nl",
    nld: "nl",
    dutch: "nl",
    pol: "pl",
    polish: "pl",
    swe: "sv",
    swedish: "sv",
    dan: "da",
    danish: "da",
    nor: "no",
    norwegian: "no",
    fin: "fi",
    finnish: "fi",
    cze: "cs",
    ces: "cs",
    czech: "cs",
    hun: "hu",
    hungarian: "hu",
    gre: "el",
    ell: "el",
    greek: "el",
    heb: "he",
    hebrew: "he",
    ara: "ar",
    arabic: "ar",
    per: "fa",
    fas: "fa",
    persian: "fa",
    hin: "hi",
    hindi: "hi",
    tha: "th",
    thai: "th",
    tur: "tr",
    turkish: "tr",
    ukr: "uk",
    ukrainian: "uk",
    vie: "vi",
    vietnamese: "vi",
    ind: "id",
    indonesian: "id",
    may: "ms",
    msa: "ms",
    malay: "ms",
    rum: "ro",
    ron: "ro",
    romanian: "ro",
    bul: "bg",
    bulgarian: "bg",
    hrv: "hr",
    croatian: "hr",
    srp: "sr",
    serbian: "sr",
    slo: "sk",
    slk: "sk",
    slovak: "sk",
    slv: "sl",
    slovenian: "sl",
    cat: "ca",
    catalan: "ca",
    est: "et",
    estonian: "et",
    lav: "lv",
    latvian: "lv",
    lit: "lt",
    lithuanian: "lt",
    fil: "fil",
    tgl: "fil",
    tagalog: "fil",
    filipino: "fil",
  });

  function normalizeLanguageToken(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/^[._\-(\[]+/, "")
      .replace(/[._\-)\]]+$/, "");
  }

  // A language name or a language code, resolved to the code LST uses.
  function languageCodeOf(value) {
    const token = normalizeLanguageToken(value);
    if (!token) return "";
    if (Object.prototype.hasOwnProperty.call(LANGUAGE_BY_CODE, token)) {
      return token;
    }
    if (Object.prototype.hasOwnProperty.call(LANGUAGE_ALIASES, token)) {
      return LANGUAGE_ALIASES[token];
    }
    for (const [code, name] of Object.entries(LANGUAGE_BY_CODE)) {
      if (name.toLowerCase() === token) return code;
    }
    return "";
  }

  function languageNameOf(value) {
    const code = languageCodeOf(value);
    return code ? LANGUAGE_BY_CODE[code] : "";
  }

  // Language names long enough that a word in a romaji title cannot be mistaken
  // for one. Short codes are only read where a separator demonstrates that the
  // token really is a tag: "Suisei no Majo" contains the Norwegian code "no",
  // and a release name is not a place to look for two-letter words.
  const LANGUAGE_WORDS = Object.freeze(
    Object.values(LANGUAGE_BY_CODE).filter((name) => name.length >= 4),
  );
  const LANGUAGE_WORD_PATTERN = new RegExp(
    `(?:^|[^\\p{L}])(${LANGUAGE_WORDS.join("|")})(?=$|[^\\p{L}])`,
    "giu",
  );

  function languageFromFileName(name) {
    const raw = String(name || "").trim();
    if (!raw) return { language: "", code: "", reason: "empty-file-name" };
    const base = raw.replace(/\.[a-z0-9]{1,8}$/i, "");

    const tagged = [
      // ".ja", "_en", "-es" at the end of the name, with an optional version.
      { reason: "dotted-language-tag", pattern: /(?:^|[._-])([a-z]{2,3})(?:v\d)?$/gi },
      // "[ja]", "(en)", "[eng]"
      { reason: "bracketed-language-tag", pattern: /[[(]([a-z]{2,3})[\])]/gi },
      // ".ja.", "_en_", "-es-"
      { reason: "delimited-language-tag", pattern: /[._-]([a-z]{2,3})(?=[._-])/gi },
    ];

    for (const { reason, pattern } of tagged) {
      for (const match of base.matchAll(pattern)) {
        const code = languageCodeOf(match[1]);
        if (code) return { language: LANGUAGE_BY_CODE[code], code, reason };
      }
    }

    for (const match of base.matchAll(LANGUAGE_WORD_PATTERN)) {
      const code = languageCodeOf(match[1]);
      if (code) {
        return { language: LANGUAGE_BY_CODE[code], code, reason: "language-word" };
      }
    }

    return { language: "", code: "", reason: "no-language-tag" };
  }

  // Scripts ------------------------------------------------------------------

  const SCRIPT_PATTERNS = [
    { script: "japanese", pattern: /[\u3040-\u309f\u30a0-\u30ff\uff66-\uff9f]/g },
    { script: "korean", pattern: /[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/g },
    { script: "han", pattern: /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g },
    { script: "cyrillic", pattern: /[\u0400-\u04ff]/g },
    { script: "greek", pattern: /[\u0370-\u03ff]/g },
    { script: "hebrew", pattern: /[\u0590-\u05ff]/g },
    { script: "arabic", pattern: /[\u0600-\u06ff\u0750-\u077f]/g },
    { script: "devanagari", pattern: /[\u0900-\u097f]/g },
    { script: "thai", pattern: /[\u0e00-\u0e7f]/g },
    { script: "latin", pattern: /[A-Za-z\u00c0-\u024f]/g },
  ];

  // A line of Japanese contains kanji too, so the script a sample is written in
  // is the one that appears most often after kana and hangul have had their
  // say — those two cannot be mistaken for anything else.
  const SCRIPT_DECIDES = Object.freeze(["japanese", "korean"]);

  function scriptOf(text) {
    const sample = String(text || "").slice(0, 4000);
    if (!sample) return { script: "", reason: "no-text" };

    const counts = [];
    for (const { script, pattern } of SCRIPT_PATTERNS) {
      const matches = sample.match(pattern);
      const count = matches ? matches.length : 0;
      if (count) counts.push({ script, count });
    }
    if (!counts.length) return { script: "", reason: "no-letters" };

    const decisive = counts.find((entry) => SCRIPT_DECIDES.includes(entry.script));
    if (decisive) {
      return { script: decisive.script, reason: "script-with-signature-letters" };
    }
    counts.sort((left, right) => right.count - left.count);
    return { script: counts[0].script, reason: "script-by-letter-count" };
  }

  const SCRIPTS_BY_LANGUAGE = Object.freeze({
    ar: ["arabic"],
    bg: ["cyrillic"],
    el: ["greek"],
    fa: ["arabic"],
    he: ["hebrew"],
    hi: ["devanagari"],
    ja: ["japanese", "han"],
    ko: ["korean", "han"],
    ru: ["cyrillic"],
    sr: ["cyrillic"],
    th: ["thai"],
    uk: ["cyrillic"],
    zh: ["han"],
  });

  function scriptsForLanguage(value) {
    const code = languageCodeOf(value);
    if (!code) return null;
    return SCRIPTS_BY_LANGUAGE[code] || ["latin"];
  }

  // Does this file need translating? ------------------------------------------
  //
  // The answer is either "no, and here is why" or "yes, and here is why". A
  // viewer can always overrule it; this only decides the default. Nothing here
  // inspects the target translation provider: a file that needs no translation
  // is never sent to one.

  const TRANSLATE_REASON = Object.freeze({
    alreadyInTarget: "track-already-in-target-language",
    languageDiffers: "track-language-differs",
    scriptMatches: "script-matches-target-language",
    scriptDiffers: "script-differs-from-target-language",
    targetUnknown: "target-language-unknown",
    unknown: "track-language-unknown",
  });

  // Two spellings of one language: an exact name, two codes that mean the same
  // language, or a name one of them qualifies ("Portuguese" and "Brazilian
  // Portuguese", "Chinese" and "Traditional Chinese").
  function sameLanguageName(left, right) {
    if (!left || !right) return false;
    if (left === right) return true;
    const leftCode = languageCodeOf(left);
    const rightCode = languageCodeOf(right);
    if (leftCode && rightCode) return leftCode === rightCode;
    const words = (value) => value.split(/[^\p{L}]+/u).filter(Boolean);
    return (
      words(left).includes(right) ||
      words(right).includes(left)
    );
  }

  function needsTranslation({ language, targetLanguage, sampleText } = {}) {
    const target = normalizeLanguageToken(targetLanguage);
    const track = normalizeLanguageToken(language);

    if (track && target) {
      if (sameLanguageName(track, target)) {
        return { translate: false, reason: TRANSLATE_REASON.alreadyInTarget };
      }
      const trackCode = languageCodeOf(track);
      const targetCode = languageCodeOf(target);
      if (trackCode && targetCode) {
        return { translate: true, reason: TRANSLATE_REASON.languageDiffers };
      }
      // The file states a language and the viewer asked for one, and the two
      // could not be compared. The file is translated: reading a subtitle in a
      // language nobody checked is worse than translating one already readable.
      return {
        translate: true,
        reason: TRANSLATE_REASON.targetUnknown,
        trackLanguage: track,
        targetLanguage: target,
      };
    }

    const expected = scriptsForLanguage(target);
    const { script, reason: scriptReason } = scriptOf(sampleText);
    if (expected && script) {
      return expected.includes(script)
        ? { translate: false, reason: TRANSLATE_REASON.scriptMatches, script }
        : { translate: true, reason: TRANSLATE_REASON.scriptDiffers, script };
    }

    // Nothing about the file was legible enough to decide, so the track is
    // translated rather than displayed untranslated by accident.
    return {
      translate: true,
      reason: TRANSLATE_REASON.unknown,
      scriptReason,
      targetLanguageKnown: Boolean(expected),
    };
  }

  // SubRip ---------------------------------------------------------------------

  function parseSrtTimestamp(value) {
    const text = String(value || "").trim().replace(",", ".");
    const match = /^(?:(\d{1,3}):)?(\d{1,3}):(\d{1,3})(?:\.(\d{1,3}))?$/.exec(text);
    if (!match) return NaN;
    const hours = match[1] === undefined ? 0 : Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    const fraction = match[4] === undefined ? 0 : Number(`0.${match[4]}`);
    if ([hours, minutes, seconds, fraction].some((part) => !Number.isFinite(part))) {
      return NaN;
    }
    return hours * 3600 + minutes * 60 + seconds + fraction;
  }

  const SRT_TIMING_PATTERN = /^(\S+)\s*-->\s*(\S+)(?:\s+(.*))?$/;

  function srtCueText(lines) {
    return lines
      .map((line) =>
        String(line)
          .replace(/<[^>]*>/g, "")
          .replace(/\{\\[^}]*\}/g, "")
          .replace(/\{\\[^}]*$/g, "")
          .replace(/\s*\\([Nn])\s*/g, "\n")
          .replace(/\u00a0/g, " ")
          .replace(/[ \t]+/g, " ")
          .trim(),
      )
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  // SubRip as the sources this feature reads actually write it: a byte-order
  // mark, Windows line endings, sequence numbers that may be missing, an
  // optional position suffix after the timestamp, markup inside the payload,
  // and a last block with no blank line after it.
  function parseSrt(text) {
    const source = String(text || "").replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
    if (!source.trim()) return [];

    const cues = [];
    const blocks = source.split(/\n{2,}/);
    let skipped = 0;

    for (const block of blocks) {
      const lines = block.split("\n").filter((line) => line.trim() !== "");
      if (!lines.length) continue;

      let index = 0;
      // An optional sequence number, which several tools omit.
      if (!SRT_TIMING_PATTERN.test(lines[0].trim()) && lines.length > 1) {
        if (/^\d{1,6}$/.test(lines[0].trim())) index = 1;
      }

      const timing = SRT_TIMING_PATTERN.exec(lines[index]?.trim() || "");
      if (!timing) {
        skipped += 1;
        continue;
      }

      const start = parseSrtTimestamp(timing[1]);
      const end = parseSrtTimestamp(timing[2]);
      const cueText = srtCueText(lines.slice(index + 1));
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end <= start ||
        !cueText
      ) {
        skipped += 1;
        continue;
      }

      cues.push({ id: String(cues.length), start, end, text: cueText });
    }

    return cues;
  }

  // Turning text into a track ---------------------------------------------------
  //
  // One owner for the question "is this text usable as an episode's track, and
  // what will LST do with it". Both sources go through it — a file downloaded
  // from Jimaku and a file the viewer already had on disk — so the two can
  // never decide the language, or whether to translate, differently.
  //
  // The module reads SubRip itself and leaves WebVTT and TTML to content.js,
  // which already has a parser for them. What it does check for those formats
  // is that the text is shaped like timed text at all, so a mislabelled file is
  // refused at import time rather than stored and then dropped by the player.

  // A subtitle file is bytes before it is text, and the bytes are not always
  // UTF-8: a file packaged for a Japanese release is often Shift-JIS. UTF-8 is
  // tried strictly first, and a file that is not UTF-8 at all is read in the
  // encoding such files are usually written in rather than arriving as
  // replacement characters. A file that decodes as neither is reported, not
  // guessed at.
  function decodeSubtitleBytes(bytes) {
    // A view is recognised by its internal slot rather than by `instanceof`,
    // which only answers for the realm the class came from.
    const view = ArrayBuffer.isView(bytes)
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : Array.isArray(bytes)
        ? Uint8Array.from(bytes)
        : null;
    if (!view) return { text: "", encoding: "", reason: DECODE_REASON.notBytes };
    if (!view.length) return { text: "", encoding: "", reason: DECODE_REASON.empty };

    try {
      return {
        text: new TextDecoder("utf-8", { fatal: true }).decode(view),
        encoding: "utf-8",
        reason: DECODE_REASON.utf8,
      };
    } catch {
      // Not UTF-8. Shift-JIS only wins if it read every byte without a
      // replacement character of its own, so a file in some third encoding is
      // not mislabelled as Japanese.
      try {
        const legacy = new TextDecoder("shift_jis").decode(view);
        if (!legacy.includes("\ufffd") && legacy.replace(/\s/g, "")) {
          return { text: legacy, encoding: "shift_jis", reason: DECODE_REASON.shiftJis };
        }
      } catch {}
      const lossy = new TextDecoder("utf-8").decode(view);
      if (lossy.replace(/[\ufffd\s]/g, "")) {
        return { text: lossy, encoding: "utf-8", reason: DECODE_REASON.utf8Lossy };
      }
      return { text: "", encoding: "", reason: DECODE_REASON.undecodable };
    }
  }

  function looksLikeTimedText(text) {
    const source = String(text || "").replace(/^\ufeff/, "").trimStart();
    if (!source) return { ok: false, reason: "not-timed-text" };
    if (/^\ufeff?WEBVTT\b/.test(source)) return { ok: true, reason: "webvtt-header" };
    if (/^<\?xml[^>]*\?>\s*<tt[\s>]/i.test(source) || /^<tt[\s>]/i.test(source)) {
      return { ok: true, reason: "ttml-root" };
    }
    if (/-->/.test(source)) return { ok: true, reason: "timing-arrows" };
    if (/<tt[\s>]/i.test(source) && /<(?:p|div|body)[\s>]/i.test(source)) {
      return { ok: true, reason: "ttml-elements" };
    }
    return { ok: false, reason: "not-timed-text" };
  }

  // Which episode the file itself claims, measured against the episode the page
  // says is playing. This is a note for the viewer, never a refusal: they chose
  // the file, and a title may number its episodes differently from the service.
  function episodeMatchFor(fileName, episode, fileEpisode) {
    const target = Number.isInteger(episode) && episode > 0 ? episode : null;
    const parsed = Number.isInteger(fileEpisode) && fileEpisode >= 0
      ? { episode: fileEpisode, reason: "listed-episode" }
      : episodeNumberFromFileName(fileName);
    const file = Number.isInteger(parsed.episode) ? parsed.episode : null;
    if (file === null) {
      return { fileEpisode: null, targetEpisode: target, matches: false, reason: parsed.reason };
    }
    if (target === null) {
      return { fileEpisode: file, targetEpisode: null, matches: false, reason: "no-target-episode" };
    }
    return {
      fileEpisode: file,
      targetEpisode: target,
      matches: file === target,
      reason: file === target ? "episode-match" : "episode-mismatch",
    };
  }

  function describeTextTrack(options = {}) {
    const fileName = String(options.fileName || "").trim();
    const text = typeof options.text === "string" ? options.text : "";
    const maxLength = Number(options.maxLength) || MAX_TRACK_TEXT_LENGTH;

    if (!text.trim()) {
      return { ok: false, reason: TRACK_TEXT_REFUSAL.empty, fileName };
    }
    if (text.length > maxLength) {
      return { ok: false, reason: TRACK_TEXT_REFUSAL.tooLarge, fileName };
    }

    const format = subtitleFormat(fileName);
    if (!format.supported) {
      return {
        ok: false,
        fileName,
        format: format.format,
        formatLabel: format.label,
        reason:
          format.reason === FORMAT_REASON.unknown
            ? TRACK_TEXT_REFUSAL.unknownFormat
            : TRACK_TEXT_REFUSAL.unsupportedFormat,
      };
    }

    const cues = format.format === "srt" ? parseSrt(text) : [];
    if (format.format === "srt" && !cues.length) {
      return {
        ok: false,
        fileName,
        format: format.format,
        formatLabel: format.label,
        reason: TRACK_TEXT_REFUSAL.unreadableCues,
      };
    }
    if (format.format !== "srt" && !looksLikeTimedText(text).ok) {
      return {
        ok: false,
        fileName,
        format: format.format,
        formatLabel: format.label,
        reason: TRACK_TEXT_REFUSAL.notTimedText,
      };
    }

    // The file name is the only evidence a file carries about its own language
    // when nothing else names one, so it is read once and the name and the code
    // come from the same reading.
    const fromName = languageFromFileName(fileName);
    const language = String(options.language || "").trim() || fromName.language;
    const languageCode = String(options.languageCode || "").trim() || fromName.code;

    const decision = needsTranslation({
      language,
      targetLanguage: options.targetLanguage,
      sampleText: text.slice(0, 4000),
    });
    const viewerChose = options.translate === true || options.translate === false;

    return {
      ok: true,
      fileName,
      format: format.format,
      formatLabel: format.label,
      bytes: text.length,
      cues,
      cueCount: cues.length,
      language,
      languageCode,
      languageReason: language === fromName.language ? fromName.reason : "listed-language",
      translate: viewerChose ? options.translate : decision.translate,
      translateReason: viewerChose ? "viewer-choice" : decision.reason,
      viewerChose,
      episodeMatch: episodeMatchFor(fileName, options.episode, options.fileEpisode),
    };
  }

  // Endpoints ------------------------------------------------------------------

  function searchUrl(query, options = {}) {
    const url = new URL(SEARCH_PATH, SUBTITLEBOT_ORIGIN);
    url.searchParams.set("query", String(query || "").trim());
    url.searchParams.set("limit", String(Number(options.limit) || SEARCH_LIMIT));
    url.searchParams.set("anime", options.anime === false ? "false" : "true");
    return url.toString();
  }

  function entryPageUrl(entryId) {
    return `${JIMAKU_ORIGIN}/entry/${Number(entryId) || 0}`;
  }

  function filesUrl(entryId, episode) {
    const url = new URL(`/api/entries/${Number(entryId) || 0}/files`, JIMAKU_ORIGIN);
    if (Number.isInteger(episode) && episode >= 0) {
      url.searchParams.set("episode", String(episode));
    }
    return url.toString();
  }

  // Search results --------------------------------------------------------------

  function normalizeEntry(raw) {
    const entryId = Number(raw?.id);
    if (!Number.isInteger(entryId) || entryId <= 0) return null;
    const name = String(raw?.name || "").trim();
    const englishName = String(raw?.english_name || "").trim();
    const japaneseName = String(raw?.japanese_name || "").trim();
    if (!name && !englishName && !japaneseName) return null;
    const displayName = englishName || name || japaneseName;
    return {
      entryId,
      name,
      englishName,
      japaneseName,
      displayName,
      displayNameReason: englishName ? "english-name" : name ? "romaji-name" : "japanese-name",
      notes: String(raw?.notes || "").trim(),
      anilistId: Number.isInteger(Number(raw?.anilist_id)) ? Number(raw.anilist_id) : null,
      tmdbId: String(raw?.tmdb_id || "").trim(),
      anime: raw?.flags?.anime === true,
      movie: raw?.flags?.movie === true,
      external: raw?.flags?.external === true,
      unverified: raw?.flags?.unverified === true,
      adult: raw?.flags?.adult === true,
      lastModified: String(raw?.last_modified || ""),
      pageUrl: entryPageUrl(entryId),
    };
  }

  function parseSearchResults(payload) {
    if (!Array.isArray(payload)) {
      return { entries: [], skipped: 0, reason: "search-payload-not-a-list" };
    }
    const entries = [];
    let skipped = 0;
    for (const raw of payload) {
      const entry = normalizeEntry(raw);
      if (entry) entries.push(entry);
      else skipped += 1;
    }
    return {
      entries,
      skipped,
      reason: entries.length ? "search-results" : "search-no-results",
    };
  }

  // File listings ---------------------------------------------------------------

  // A file URL is resolved against the origin it was listed on, and a URL that
  // leaves that origin is reported rather than fetched: LST asks for permission
  // to reach one host, and a listing cannot widen that by naming another.
  function resolveJimakuUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return { url: "", ok: false, host: "", reason: "empty-file-url" };
    try {
      const parsed = new URL(raw, JIMAKU_ORIGIN);
      const ok = parsed.protocol === "https:" && parsed.hostname === "jimaku.cc";
      return {
        url: parsed.toString(),
        ok,
        host: parsed.hostname,
        reason: ok ? "file-url-on-jimaku" : "file-url-off-origin",
      };
    } catch {
      return { url: raw, ok: false, host: "", reason: "unparseable-file-url" };
    }
  }

  function normalizeFile(raw) {
    const resolved = resolveJimakuUrl(raw?.url);
    const name = String(raw?.name || "").trim() || resolved.url.split("/").pop() || "";
    if (!resolved.url || !name) return null;
    const format = subtitleFormat(name);
    const episode = episodeNumberFromFileName(name);
    const language = languageFromFileName(name);
    return {
      name,
      url: resolved.url,
      urlHost: resolved.host,
      urlAllowed: resolved.ok,
      urlReason: resolved.reason,
      size: Number.isFinite(Number(raw?.size)) ? Number(raw.size) : 0,
      lastModified: String(raw?.last_modified || ""),
      format: format.format,
      formatLabel: format.label,
      formatReason: format.reason,
      supported: format.supported,
      episode: episode.episode,
      episodeReason: episode.reason,
      language: language.language,
      languageCode: language.code,
      languageReason: language.reason,
    };
  }

  function parseFileList(payload) {
    if (!Array.isArray(payload)) {
      return { files: [], skipped: 0, reason: "file-list-not-a-list" };
    }
    const files = [];
    let skipped = 0;
    for (const raw of payload) {
      const file = normalizeFile(raw);
      if (file) files.push(file);
      else skipped += 1;
    }
    return {
      files,
      skipped,
      reason: files.length ? "file-list" : "file-list-empty",
    };
  }

  // Which file belongs to the episode the viewer is watching. A file whose name
  // states a different episode is never chosen, a file that states no episode
  // is only a candidate when nothing else is, and more than one candidate is
  // reported as a choice to make rather than resolved silently. Among the
  // candidates, the file already written in the language the viewer asked for is
  // preferred first: that is the one that needs no translation at all.
  function chooseFileForEpisode(files, episode, options = {}) {
    const list = Array.isArray(files) ? files : [];
    const target = normalizeLanguageToken(options.targetLanguage);
    const supported = list.filter((file) => file?.supported);
    if (!list.length) {
      return { file: null, ambiguous: false, considered: 0, rejected: 0, reason: "no-files" };
    }
    if (!supported.length) {
      return {
        file: null,
        ambiguous: false,
        considered: list.length,
        rejected: list.length,
        reason: "no-supported-file",
      };
    }

    const targetNumber = Number.isInteger(episode) && episode > 0 ? episode : null;
    const matching = supported.filter(
      (file) =>
        targetNumber !== null &&
        Number.isInteger(file.episode) &&
        file.episode === targetNumber,
    );
    const unnumbered = supported.filter((file) => !Number.isInteger(file.episode));

    const pool = matching.length ? matching : unnumbered;
    if (!pool.length) {
      return {
        file: null,
        ambiguous: false,
        considered: list.length,
        rejected: list.length - unnumbered.length,
        reason: "no-file-for-episode",
      };
    }

    const languageRank = (file) => {
      if (
        target &&
        sameLanguageName(normalizeLanguageToken(file.language), target)
      ) {
        return 2;
      }
      return file.languageCode ? 1 : 0;
    };
    const ranked = [...pool].sort((left, right) => {
      const byLanguage = languageRank(right) - languageRank(left);
      if (byLanguage) return byLanguage;
      const bySize = (Number(left.size) || 0) - (Number(right.size) || 0);
      if (bySize) return bySize;
      return left.name.localeCompare(right.name);
    });
    const ambiguous = ranked.length > 1;
    return {
      file: ranked[0],
      ambiguous,
      considered: list.length,
      rejected: list.length - pool.length,
      candidates: ranked.length,
      reason: matching.length
        ? ambiguous
          ? "episode-matches-tie"
          : "episode-match"
        : "no-episode-number-in-name",
    };
  }

  // Imported tracks ---------------------------------------------------------------
  //
  // A track is stored per episode, not per cache id: the cache id also names the
  // model and the target language, and changing either must not throw away the
  // subtitle file the viewer imported.

  function episodeKeyFor(videoId, siteId) {
    const identity = globalThis.LSTEpisodeIdentity;
    if (identity?.encodeEpisodeKey) {
      return identity.encodeEpisodeKey({ videoId, siteId });
    }
    // Without the identity module the namespace rule is repeated rather than
    // skipped, so an import still lands on the right service.
    const id = String(videoId || "").trim();
    if (!id || id === "unknown") return "";
    const namespace = siteId && siteId !== "netflix" ? `${siteId}~` : "";
    return `${namespace}${encodeURIComponent(id)}`;
  }

  function trackSummary(track) {
    if (!track || typeof track !== "object") return null;
    const {
      text: _text,
      ...rest
    } = track;
    return { ...rest, hasText: typeof track.text === "string" && track.text.length > 0 };
  }

  function trackTextLength(track) {
    return typeof track?.text === "string" ? track.text.length : 0;
  }

  function normalizeImportedTrack(track) {
    if (!track || typeof track !== "object") return null;
    const episodeKey = String(track.episodeKey || "").trim();
    const text = typeof track.text === "string" ? track.text : "";
    if (!episodeKey || !text) return null;
    const fileName = String(track.fileName || "");
    const format = subtitleFormat(fileName);
    return {
      episodeKey,
      // A track stored before this field existed was downloaded from Jimaku, so
      // that is what its absence means.
      source: String(track.source || TRACK_SOURCE.jimaku),
      entryId: Number(track.entryId) || 0,
      entryName: String(track.entryName || ""),
      entryUrl: String(track.entryUrl || ""),
      fileName,
      fileUrl: String(track.fileUrl || ""),
      size: Number(track.size) || 0,
      lastModified: String(track.lastModified || ""),
      format: String(track.format || format.format),
      language: String(track.language || ""),
      languageCode: String(track.languageCode || ""),
      translate: track.translate !== false,
      translateReason: String(track.translateReason || ""),
      cueCount: Number(track.cueCount) || 0,
      importedAt: String(track.importedAt || ""),
      // Where the file's own timeline sits on the video's clock, as the viewer
      // corrected it. A track stored before this existed is shown as it says.
      timingOffsetMs: normalizeFileTiming(track.timingOffsetMs),
      text,
    };
  }

  function importedTrackBytes(tracks) {
    let bytes = 0;
    for (const track of Object.values(tracks || {})) {
      bytes += trackTextLength(track);
    }
    return bytes;
  }

  // Where a file's timeline sits on the video's clock -------------------------
  //
  // A subtitle file states when each of its lines is spoken, and a file made for
  // another release of the same episode states it seconds or minutes away from
  // the copy being watched: a different cut, a recap the file does not have, a
  // broadcast master against a streaming one. LST renders an imported file from
  // its own timeline — that is what makes a title the service does not subtitle
  // work at all — so the distance is the viewer's to correct, and the correction
  // belongs to the file.
  //
  // It is stored with the file, for the episode it was imported for, rather than
  // in one setting: two files for two episodes are two distances, and fixing one
  // must not move the other. The global timing offset keeps its meaning and still
  // applies on top, because it is what the viewer tuned for the service's own
  // track. Both are "positive is later": a positive correction shows every line
  // later than the file says.
  //
  // This cannot rescue a file for a re-cut episode, where the distance changes
  // partway through; no single number fixes that, and LST says so rather than
  // pretending. It is for the ordinary case: right episode, wrong release, one
  // distance from beginning to end.
  const FILE_TIMING_LIMIT_MS = 10 * 60 * 1000;

  // The global setting's own range, which has always been two seconds either way.
  // Named here so the player and the popup stop repeating the number.
  const TIMING_GLOBAL_LIMIT_MS = 2000;

  // The steps the player and the popup offer, in milliseconds. Coarse enough to
  // reach a file for another release in a few presses, fine enough to finish by
  // eye. One owner: both pages build their buttons for these numbers, and a test
  // fails if a page offers a step the module does not.
  const FILE_TIMING_STEPS_MS = Object.freeze([30000, 5000, 1000, 100]);

  // Whose clock a timing control moves.
  const TIMING_SCOPE = Object.freeze({ file: "imported-file", global: "global" });

  function normalizeFileTiming(value) {
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms === 0) return 0;
    return Math.max(
      -FILE_TIMING_LIMIT_MS,
      Math.min(FILE_TIMING_LIMIT_MS, Math.round(ms)),
    );
  }

  // The one place the two corrections are added, and the one place their
  // direction is stated. A positive correction shows every line later than the
  // timeline says, so the player looks that much earlier in it; the same function
  // answers for the reverse, the moment a line stops being shown, so the two
  // directions cannot drift apart.
  function timingLookupOffsetSeconds({ fileTimingMs = 0, globalOffsetMs = 0 } = {}) {
    const global = Number(globalOffsetMs);
    return (
      (normalizeFileTiming(fileTimingMs) + (Number.isFinite(global) ? global : 0)) /
      1000
    );
  }

  // Which clock the timing controls move: an imported file's own, when one is in
  // use, and the global setting otherwise. The player and the popup both ask
  // this, so neither can decide it differently.
  function timingTargetFor(importedTrack, options = {}) {
    const track =
      importedTrack && typeof importedTrack === "object" ? importedTrack : null;
    if (!track) {
      return {
        scope: TIMING_SCOPE.global,
        episodeKey: "",
        fileName: "",
        offsetMs: Number(options.globalOffsetMs) || 0,
        limitMs: TIMING_GLOBAL_LIMIT_MS,
      };
    }
    return {
      scope: TIMING_SCOPE.file,
      episodeKey: String(track.episodeKey || ""),
      fileName: String(track.fileName || ""),
      offsetMs: normalizeFileTiming(track.timingOffsetMs),
      limitMs: FILE_TIMING_LIMIT_MS,
    };
  }

  function fileTimingAmount(seconds) {
    const value = Math.round(Math.abs(Number(seconds) || 0) * 10) / 10;
    return {
      value: Number.isInteger(value) ? String(value) : value.toFixed(1),
      unit: value === 1 ? "second" : "seconds",
    };
  }

  // One sentence for the correction a file carries, so the player, the popup and
  // the import card cannot describe the same number three ways.
  function describeFileTiming(offsetMs) {
    const ms = normalizeFileTiming(offsetMs);
    if (!ms) {
      return {
        offsetMs: 0,
        label: "in step",
        sentence: "This imported file is shown where the file says it should be.",
        atLimit: false,
        tone: "",
      };
    }
    const amount = fileTimingAmount(ms / 1000);
    const atLimit = Math.abs(ms) >= FILE_TIMING_LIMIT_MS;
    return {
      offsetMs: ms,
      label: `${ms > 0 ? "+" : "-"}${amount.value} s`,
      sentence:
        `This imported file is shown ${amount.value} ${amount.unit} ` +
        `${ms > 0 ? "later" : "earlier"} than the file says.` +
        (atLimit
          ? " That is as far as LST moves a file: a file this far out is usually" +
            " one for another release of the episode, and no press will fix it."
          : ""),
      atLimit,
      tone: atLimit ? "warn" : "",
    };
  }

  // What Jimaku held for a show the last time LST asked --------------------------
  //
  // A note, not a live answer. LST writes one when the viewer searches Jimaku and
  // reads it when they open any episode of that show, so the player can say what
  // exists without contacting anyone. Nothing is ever fetched on arrival: a note
  // is only as fresh as the last search the viewer ran, and it says when that
  // was.
  //
  // A note is kept per *show* rather than per episode, because the question it
  // answers — "does Jimaku have subtitles for this?" — is a question about the
  // show, and the viewer asks it again on the next episode.

  // Every reason a note is what it is, so the interface can say why it knows, and
  // a note that is missing can say why it is missing.
  const FINDING_REASON = Object.freeze({
    none: "no-finding-yet",
    noShowKey: "no-show-key",
    nothingFound: "search-found-nothing",
    entriesFound: "search-found-entries",
    filesListed: "files-listed-for-episode",
    filesMissing: "entry-has-no-files",
    expired: "finding-expired",
    unreadable: "finding-unreadable",
  });

  // A note is only usable when it names a show and says when it was taken. There
  // is no clock in this module: the caller that has one states the time, and a
  // note without one is refused rather than stamped with a guess.
  function normalizeJimakuFinding(value) {
    if (!value || typeof value !== "object") return null;
    const showKey = String(value.showKey || "").trim();
    const checkedAt = String(value.checkedAt || "").trim();
    if (!showKey || !Number.isFinite(Date.parse(checkedAt))) return null;
    const episode = Number(value.episode);
    const count = (input) => Math.max(0, Math.round(Number(input) || 0));
    return {
      showKey,
      siteId: String(value.siteId || ""),
      showName: String(value.showName || "").trim(),
      query: String(value.query || "").trim(),
      entryCount: count(value.entryCount),
      entryId: count(value.entryId),
      entryName: String(value.entryName || "").trim(),
      fileCount: value.fileCount === null ? null : count(value.fileCount),
      episode: Number.isInteger(episode) && episode > 0 ? episode : null,
      checkedAt,
    };
  }

  function findingFromSearch({ showKey, siteId, showName, query, entries, checkedAt } = {}) {
    return normalizeJimakuFinding({
      showKey,
      siteId,
      showName,
      query,
      entryCount: Array.isArray(entries) ? entries.length : 0,
      fileCount: null,
      checkedAt,
    });
  }

  // Listing an entry's files answers a second question — do the files for *this
  // episode* exist — so it sharpens the note the search left rather than making a
  // new one.
  function findingForFiles({ finding, entryId, entryName, files, episode, checkedAt } = {}) {
    const base = normalizeJimakuFinding(finding);
    if (!base) return null;
    return normalizeJimakuFinding({
      ...base,
      entryId,
      entryName,
      fileCount: Array.isArray(files) ? files.length : 0,
      episode,
      checkedAt: checkedAt || base.checkedAt,
    });
  }

  // A note is refused once it is old enough that the listing behind it has
  // probably changed. The sender says what "now" is, as with checkedAt.
  function findingIsExpired(finding, now) {
    const note = normalizeJimakuFinding(finding);
    if (!note) return true;
    const elapsed = Number(now) - Date.parse(note.checkedAt);
    if (!Number.isFinite(elapsed)) return true;
    return elapsed > JIMAKU_FINDING_MAX_AGE_MS;
  }

  function describeAge(checkedAt, now) {
    const elapsed = Number(now) - Date.parse(checkedAt);
    if (!Number.isFinite(elapsed) || elapsed < 0) return `on ${checkedAt.slice(0, 10)}`;
    const days = Math.floor(elapsed / 86400000);
    if (days === 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 30) return `${days} days ago`;
    return `on ${checkedAt.slice(0, 10)}`;
  }

  // The one place that says what a note means, so the player, the popup and the
  // options card cannot describe the same note three ways. Without a `now` the
  // date is stated instead of an age, so a caller that has no clock still gets a
  // sentence rather than a guess about how long ago it was.
  function describeJimakuFinding(finding, options = {}) {
    const note = normalizeJimakuFinding(finding);
    if (!note) return null;
    const now = Number(options.now);
    const when = Number.isFinite(now)
      ? describeAge(note.checkedAt, now)
      : `on ${note.checkedAt.slice(0, 10)}`;
    const show = note.showName || "this show";
    const entry = note.entryName || "that entry";
    const files = `${note.fileCount} file${note.fileCount === 1 ? "" : "s"}`;
    const forEpisode = note.episode ? ` for episode ${note.episode}` : "";

    if (note.entryCount === 0) {
      return {
        headline: `Jimaku lists nothing for ${show}`,
        detail: `LST searched Jimaku ${when} and found no entry. A different spelling of the show's name may still find it.`,
        tone: "warn",
        reason: FINDING_REASON.nothingFound,
      };
    }
    if (note.fileCount === 0) {
      return {
        headline: `${entry} lists no file${forEpisode}`,
        detail: `LST listed ${entry}'s files ${when}. Another of Jimaku's ${note.entryCount} entries for ${show} may have it.`,
        tone: "warn",
        reason: FINDING_REASON.filesMissing,
      };
    }
    if (note.fileCount > 0) {
      return {
        headline: `${entry} has ${files}${forEpisode}`,
        detail: `LST listed them ${when}. Jimaku holds ${note.entryCount} entr${note.entryCount === 1 ? "y" : "ies"} for ${show}.`,
        tone: "good",
        reason: FINDING_REASON.filesListed,
      };
    }
    return {
      headline: `Jimaku holds ${note.entryCount} entr${note.entryCount === 1 ? "y" : "ies"} for ${show}`,
      detail: `LST searched Jimaku ${when}. Choose one in the import card to see its files for this episode.`,
      tone: "info",
      reason: FINDING_REASON.entriesFound,
    };
  }

  // A search query is the show, not the episode: the same query serves every
  // episode of a season, and a service that states the season inside the show's
  // own name — 機動戦士ガンダム 水星の魔女 シーズン1 — finds nothing at all when
  // the season is left on the query, because Jimaku files the entry under the
  // bare name. The same words are written in Latin, in Japanese and in Chinese,
  // so all three are trimmed.
  //
  // A marker is never the whole name: the loop below refuses a replacement that
  // would empty the query, so a show actually called 第2期 is searched for as
  // 第2期. Both callers go through here — the player's Check Jimaku button and
  // the import card's search box — so the two cannot trim differently.
  const QUERY_TRAILERS = [
    // A season stated in brackets, which is the most specific form and so is
    // tried first: "Show (Season 2)", "Show（第2期）", "Show（シーズン2）",
    // "Show (第3話)".
    /\s*[（(]\s*(?:第\s*)?\d{1,2}\s*(?:season|series|シーズン|クール|期|季|部|パート)\s*[）)]\s*$/i,
    /\s*[（(]\s*(?:season|series|シーズン|クール|パート)\s*\d{1,2}\s*[）)]\s*$/i,
    /\s*[（(]\s*(?:第\s*)?\d{1,3}\s*(?:話|回|集|章|幕)[^）)]{0,20}[）)]\s*$/,
    /\s*[（(]\s*(?:season|series|シーズン|クール|期|季)\s*[）)]\s*$/i,
    // Latin, as the services write it: "Show - Season 2", "Show S01E04".
    /\s*[-–—|:·、：・]\s*(?:season|series|staffel|saison|temporada)\s*\d+\s*$/i,
    /\s*[-–—|:·、：・]\s*s\d{1,2}\s*$/i,
    /\s*\bs\d{1,2}\s*e\d{1,3}\b.*$/i,
    /\s*\b(?:episode|ep)\s*\d{1,3}\b.*$/i,
    /\s*[-–—|:·、：・]\s*\d{1,3}\s*$/,
    // The same season words with nothing but a space in front of them.
    /\s*(?:season|series|staffel|saison|temporada)\s*\d{1,2}\s*$/i,
    /\s*\d{1,2}(?:st|nd|rd|th)\s+(?:season|series)\s*$/i,
    // Japanese and Chinese season words: シーズン2, 第2シーズン, 2期, 第2期,
    // 第2クール, パート2, 第2季.
    /\s*(?:第\s*)?\d{1,2}\s*(?:シーズン|クール|期|季|部)\s*$/,
    /\s*(?:シーズン|パート)\s*\d{1,2}\s*$/,
    // An episode marker a title carries: 第4話, 4話, 第4回, 4集, and whatever
    // the title says after it — a season's episodes share one Jimaku entry, so
    // an episode number on the query finds nothing either.
    /\s*(?:第\s*)?\d{1,3}\s*(?:話|回|章|幕|集).*$/,
  ];

  // The separator a trimmed marker left behind ("Show - 第2期"), and the
  // punctuation a service hangs off a name.
  const QUERY_DANGLING_SEPARATOR = /[-–—|:·、：・]+$/;

  function queryFromShowName(showName) {
    let query = String(showName || "").trim();
    if (!query) return "";
    // A title can carry more than one marker ("Show シーズン1 第4話"), and
    // trimming one can leave the separator that introduced the next, so the
    // patterns and the separator are applied until a pass changes nothing. A
    // pattern is never allowed to empty the query on its own: a show actually
    // called 第2期 is searched for as 第2期.
    for (let pass = 0; pass < QUERY_TRAILERS.length + 1; pass += 1) {
      let changed = false;
      for (const pattern of QUERY_TRAILERS) {
        const next = query.replace(pattern, "").trim();
        if (next && next !== query) {
          query = next;
          changed = true;
        }
      }
      const tidied = query.replace(QUERY_DANGLING_SEPARATOR, "").trim();
      if (tidied && tidied !== query) {
        query = tidied;
        changed = true;
      }
      if (!changed) break;
    }
    // Nothing but punctuation is not a name to search for.
    return query.replace(QUERY_DANGLING_SEPARATOR, "").trim();
  }

  // A Jimaku entry typed or pasted instead of searched for.
  function parseEntryReference(value) {
    const raw = String(value || "").trim();
    if (!raw) return { entryId: null, reason: "empty-entry-reference" };
    if (/^\d{1,12}$/.test(raw)) {
      return { entryId: Number(raw), reason: "entry-id" };
    }
    const match = new RegExp(`^${JIMAKU_ORIGIN.replace(/\./g, "\\.")}/entry/(\\d{1,12})`).exec(raw);
    if (match) return { entryId: Number(match[1]), reason: "entry-url" };
    const slug = /^entry\/(\d{1,12})/.exec(raw);
    if (slug) return { entryId: Number(slug[1]), reason: "entry-path" };
    return { entryId: null, reason: "unrecognized-entry-reference" };
  }

  const api = Object.freeze({
    DECODE_REASON,
    FILE_TIMING_LIMIT_MS,
    FILE_TIMING_STEPS_MS,
    FINDING_REASON,
    FORMAT_REASON,
    HOST_ORIGINS,
    IMPORTED_TRACKS_KEY,
    IMPORTED_TRACK_LIMIT,
    JIMAKU_FINDINGS_KEY,
    JIMAKU_FINDING_LIMIT,
    JIMAKU_FINDING_MAX_AGE_MS,
    JIMAKU_KEY_STORAGE,
    JIMAKU_ORIGIN,
    MAX_TRACK_BYTES,
    MAX_TRACK_TEXT_LENGTH,
    SEARCH_LIMIT,
    SUBTITLEBOT_ORIGIN,
    SUBTITLE_FORMATS,
    TIMING_GLOBAL_LIMIT_MS,
    TIMING_SCOPE,
    TRACK_SOURCE,
    TRACK_TEXT_REFUSAL,
    TRANSLATE_REASON,
    chooseFileForEpisode,
    decodeSubtitleBytes,
    describeFileTiming,
    describeJimakuFinding,
    describeTextTrack,
    entryPageUrl,
    episodeKeyFor,
    episodeMatchFor,
    episodeNumberFromFileName,
    fileExtension,
    filesUrl,
    findingForFiles,
    findingFromSearch,
    findingIsExpired,
    importedTrackBytes,
    languageCodeOf,
    languageFromFileName,
    languageNameOf,
    looksLikeTimedText,
    needsTranslation,
    normalizeFileTiming,
    normalizeImportedTrack,
    normalizeJimakuFinding,
    parseEntryReference,
    parseFileList,
    parseSearchResults,
    parseSrt,
    parseSrtTimestamp,
    queryFromShowName,
    resolveJimakuUrl,
    scriptOf,
    scriptsForLanguage,
    searchUrl,
    subtitleFormat,
    timingLookupOffsetSeconds,
    timingTargetFor,
    trackSummary,
    trackTextLength,
  });

  globalThis.LSTSubtitleImport = api;
  if (typeof module !== "undefined" && module?.exports) {
    module.exports = api;
  }
})();
