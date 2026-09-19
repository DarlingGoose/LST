/**
 * LST translation guard.
 *
 * The translation model writes the text; this file only inspects it and decides
 * whether the result is plausibly written in the requested target language.
 * Rejected results are retried once and then reported as failures, so a model
 * that echoes its input (for example returning Japanese for an English target)
 * never reaches the translation cache.
 *
 * The judgment is deliberately narrow. It compares writing systems, because
 * that is a fact code can settle without guessing, and it never rewrites text.
 * It cannot detect a wrong language that shares the target's script (English
 * output for a Spanish target), so it fails open instead of guessing.
 *
 * No network access, no storage, and no extension APIs.
 */
(() => {
  "use strict";

  // A translation this short carries too little signal to judge: "OK", "TV",
  // "NHK". Names and acronyms survive in every language.
  const MIN_LETTERS_FOR_JUDGEMENT = 4;

  const SCRIPT_NAMES = [
    "Latin",
    "Cyrillic",
    "Greek",
    "Han",
    "Hiragana",
    "Katakana",
    "Hangul",
    "Arabic",
    "Hebrew",
    "Devanagari",
    "Bengali",
    "Gurmukhi",
    "Gujarati",
    "Tamil",
    "Telugu",
    "Kannada",
    "Malayalam",
    "Sinhala",
    "Thai",
    "Lao",
    "Myanmar",
    "Khmer",
    "Georgian",
    "Armenian",
    "Ethiopic",
    "Tibetan",
    "Mongolian",
  ];

  const SCRIPT_TESTS = SCRIPT_NAMES.map((name) => [
    name,
    new RegExp(`\\p{Script=${name}}`, "u"),
  ]);
  const LETTER_TEST = /\p{L}/u;

  // Script names as users would describe them.
  const SCRIPT_LABELS = {
    Latin: "Latin script",
    Cyrillic: "Cyrillic script",
    Greek: "Greek script",
    Han: "Chinese or Japanese characters",
    Hiragana: "Japanese kana",
    Katakana: "Japanese kana",
    Hangul: "Korean hangul",
    Arabic: "Arabic script",
    Hebrew: "Hebrew script",
    Devanagari: "Devanagari script",
    Bengali: "Bengali script",
    Gurmukhi: "Gurmukhi script",
    Gujarati: "Gujarati script",
    Tamil: "Tamil script",
    Telugu: "Telugu script",
    Kannada: "Kannada script",
    Malayalam: "Malayalam script",
    Sinhala: "Sinhala script",
    Thai: "Thai script",
    Lao: "Lao script",
    Myanmar: "Myanmar script",
    Khmer: "Khmer script",
    Georgian: "Georgian script",
    Armenian: "Armenian script",
    Ethiopic: "Ethiopic script",
    Tibetan: "Tibetan script",
    Mongolian: "Mongolian script",
  };

  // Languages are matched by name or ISO 639-1 code, lower case. A language may
  // use more than one writing system; any of them is accepted.
  const SCRIPTS_BY_LANGUAGE_GROUP = {
    Latin: [
      "english", "en", "spanish", "es", "french", "fr", "german", "de",
      "italian", "it", "portuguese", "pt", "dutch", "nl", "polish", "pl",
      "czech", "cs", "slovak", "sk", "hungarian", "hu", "romanian", "ro",
      "turkish", "tr", "swedish", "sv", "norwegian", "no", "danish", "da",
      "finnish", "fi", "icelandic", "is", "estonian", "et", "latvian", "lv",
      "lithuanian", "lt", "croatian", "hr", "slovenian", "sl", "bosnian",
      "albanian", "sq", "catalan", "ca", "basque", "eu", "galician", "gl",
      "welsh", "cy", "irish", "ga", "indonesian", "id", "malay", "ms",
      "vietnamese", "vi", "tagalog", "filipino", "tl", "swahili", "sw",
      "afrikaans", "af", "zulu", "zu", "yoruba", "yo", "hausa", "ha",
      "esperanto", "eo", "latin", "la",
    ],
    Cyrillic: [
      "russian", "ru", "ukrainian", "uk", "bulgarian", "bg", "serbian", "sr",
      "macedonian", "mk", "belarusian", "be", "kazakh", "kk", "kyrgyz", "ky",
      "mongolian", "mn", "tajik", "tg",
    ],
    Greek: ["greek", "el"],
    // Han covers Chinese and the kanji half of Japanese.
    Han: ["chinese", "zh", "mandarin", "cantonese", "yue", "japanese", "ja", "korean", "ko"],
    Hiragana: ["japanese", "ja"],
    Katakana: ["japanese", "ja"],
    Hangul: ["korean", "ko"],
    Arabic: ["arabic", "ar", "persian", "farsi", "fa", "urdu", "ur", "pashto", "ps", "kurdish", "ku"],
    Hebrew: ["hebrew", "he", "iw"],
    Devanagari: ["hindi", "hi", "marathi", "mr", "nepali", "ne", "sanskrit", "sa"],
    Bengali: ["bengali", "bn"],
    Gurmukhi: ["punjabi", "pa"],
    Gujarati: ["gujarati", "gu"],
    Tamil: ["tamil", "ta"],
    Telugu: ["telugu", "te"],
    Kannada: ["kannada", "kn"],
    Malayalam: ["malayalam", "ml"],
    Sinhala: ["sinhala", "si"],
    Thai: ["thai", "th"],
    Lao: ["lao", "lo"],
    Myanmar: ["burmese", "myanmar", "my"],
    Khmer: ["khmer", "km"],
    Georgian: ["georgian", "ka"],
    Armenian: ["armenian", "hy"],
    Ethiopic: ["amharic", "am", "tigrinya", "ti"],
    Tibetan: ["tibetan", "bo"],
    Mongolian: ["classical mongolian"],
  };

  const SCRIPTS_BY_LANGUAGE = new Map();
  for (const [script, languages] of Object.entries(SCRIPTS_BY_LANGUAGE_GROUP)) {
    for (const language of languages) {
      const scripts = SCRIPTS_BY_LANGUAGE.get(language) || [];
      if (!scripts.includes(script)) scripts.push(script);
      SCRIPTS_BY_LANGUAGE.set(language, scripts);
    }
  }

  // The target language is a free-text setting, so users also type endonyms:
  // "Français", "日本語", "Русский". Keys are compared after diacritic folding.
  const LANGUAGE_ALIASES = {
    "francais": "french",
    "espanol": "spanish",
    "deutsch": "german",
    "italiano": "italian",
    "portugues": "portuguese",
    "brasileiro": "portuguese",
    "nederlands": "dutch",
    "polski": "polish",
    "cestina": "czech",
    "slovencina": "slovak",
    "magyar": "hungarian",
    "romana": "romanian",
    "turkce": "turkish",
    "svenska": "swedish",
    "norsk": "norwegian",
    "dansk": "danish",
    "suomi": "finnish",
    "islenska": "icelandic",
    "eesti": "estonian",
    "latviesu": "latvian",
    "lietuviu": "lithuanian",
    "hrvatski": "croatian",
    "slovenscina": "slovenian",
    "bosanski": "bosnian",
    "shqip": "albanian",
    "catala": "catalan",
    "euskara": "basque",
    "galego": "galician",
    "bahasa indonesia": "indonesian",
    "bahasa melayu": "malay",
    "tieng viet": "vietnamese",
    "kiswahili": "swahili",
    "isizulu": "zulu",
    "yoruba": "yoruba",
    "日本": "japanese",
    "日本语": "japanese",
    "日本語": "japanese",
    "中文": "chinese",
    "简体中文": "chinese",
    "繁體中文": "chinese",
    "汉语": "chinese",
    "한국어": "korean",
    "조선말": "korean",
    "русский": "russian",
    "українська": "ukrainian",
    "беларуская": "belarusian",
    "български": "bulgarian",
    "српски": "serbian",
    "македонски": "macedonian",
    "қазақша": "kazakh",
    "ελληνικά": "greek",
    "العربية": "arabic",
    "فارسی": "persian",
    "اردو": "urdu",
    "עברית": "hebrew",
    "हिन्दी": "hindi",
    "हिंदी": "hindi",
    "मराठी": "marathi",
    "ไทย": "thai",
    "ქართული": "georgian",
    "հայերեն": "armenian",
    "አማርኛ": "amharic",
    "বাংলা": "bengali",
    "ਪੰਜਾਬੀ": "punjabi",
    "ગુજરાતી": "gujarati",
    "தமிழ்": "tamil",
    "తెలుగు": "telugu",
    "ಕನ್ನಡ": "kannada",
    "മലയാളം": "malayalam",
    "සිංහල": "sinhala",
    "မြန်မာ": "burmese",
    "ខ្មែរ": "khmer",
    "ລາວ": "lao",
    "བོད་སྐད་": "tibetan",
  };

  function stringOf(value) {
    return typeof value === "string" ? value : String(value ?? "");
  }

  /**
   * Candidate lookup keys for a typed language name: the literal form first,
   * then a diacritic-folded form. Both are needed. Folding alone would break
   * names where the mark carries meaning ("ру́сский" folds to "рускии"), and the
   * literal form alone would miss "Français".
   */
  function languageKeys(value) {
    const base = stringOf(value)
      .toLowerCase()
      .replace(/\([^)]*\)/g, " ")
      .replace(/[._/-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!base) return [];

    const folded = base
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .normalize("NFC")
      .replace(/\s+/g, " ")
      .trim();

    return folded && folded !== base ? [base, folded] : [base];
  }

  /**
   * Writing systems a target language is plausibly written in, or null when the
   * language is unknown. Unknown languages are never judged.
   */
  function scriptsForLanguage(value) {
    for (const key of languageKeys(value)) {
      const alias = LANGUAGE_ALIASES[key];
      const resolved = alias || key;

      const direct = SCRIPTS_BY_LANGUAGE.get(resolved);
      if (direct) return [...direct];

      const aliased = alias && SCRIPTS_BY_LANGUAGE.get(alias);
      if (aliased) return [...aliased];

      // "english us", "portuguese brazil", "chinese traditional"
      for (const token of resolved.split(" ")) {
        const match = SCRIPTS_BY_LANGUAGE.get(token);
        if (match) return [...match];
      }
    }

    return null;
  }

  function scriptCounts(text) {
    const counts = new Map();
    for (const character of stringOf(text)) {
      if (!LETTER_TEST.test(character)) continue;
      for (const [name, test] of SCRIPT_TESTS) {
        if (!test.test(character)) continue;
        counts.set(name, (counts.get(name) || 0) + 1);
        break;
      }
    }
    return counts;
  }

  function letterCount(counts) {
    let total = 0;
    for (const count of counts.values()) total += count;
    return total;
  }

  /** Script names in the text, most used first, ties broken by name. */
  function scriptsByUse(counts) {
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([name]) => name);
  }

  function scriptLabel(script) {
    return SCRIPT_LABELS[script] || `${script} script`;
  }

  function scriptLabels(scripts) {
    const unique = [];
    for (const script of scripts) {
      const label = scriptLabel(script);
      if (!unique.includes(label)) unique.push(label);
    }
    return unique.join(" or ");
  }

  function isSubset(subset, superset) {
    const allowed = new Set(superset);
    for (const name of subset) {
      if (!allowed.has(name)) return false;
    }
    return true;
  }

  /**
   * Decide whether a model's output is plausibly a translation into the target
   * language. First matching rule wins; every rule is stated here so the
   * outcome can be read off the code rather than inferred from a score.
   */
  function verify({ source, translation, targetLanguage } = {}) {
    const sourceText = stringOf(source);
    const translated = stringOf(translation);
    const expectedScripts = scriptsForLanguage(targetLanguage);

    const result = {
      verdict: "accept",
      reason: "",
      targetLanguage: stringOf(targetLanguage),
      expectedScripts: expectedScripts ? [...expectedScripts] : [],
      observedScripts: [],
      sourceScripts: [],
      letterCount: 0,
    };

    // 1. Nothing came back at all.
    if (!translated.trim()) {
      return { ...result, verdict: "reject", reason: "empty" };
    }

    // 2. An unrecognized target language ("Klingon", a private shorthand) gives
    //    the guard nothing to compare against, so it stays out of the way.
    if (!expectedScripts) {
      return { ...result, reason: "unknown-target-language" };
    }

    const counts = scriptCounts(translated);
    const observedScripts = scriptsByUse(counts);
    const letters = letterCount(counts);
    result.observedScripts = observedScripts;
    result.letterCount = letters;

    // 3. A line with no letters at all ("1,789", "…") has nothing to judge.
    if (!letters) {
      return { ...result, reason: "no-letters" };
    }

    // 4. The ordinary case: the output uses one of the target's scripts.
    if (observedScripts.some((script) => expectedScripts.includes(script))) {
      return { ...result, reason: "expected-script" };
    }

    const sourceCounts = scriptCounts(sourceText);
    const sourceScripts = scriptsByUse(sourceCounts);
    result.sourceScripts = sourceScripts;

    // 5. The output uses only the writing systems the source used, so the model
    //    handed the input back instead of translating it. Length is no defense
    //    here: a three-character Japanese line for an English target is the
    //    reported bug, and a genuine target-language result would have matched
    //    rule 4.
    if (sourceScripts.length && isSubset(observedScripts, sourceScripts)) {
      return { ...result, verdict: "reject", reason: "source-language-leaked" };
    }

    // 6. Short outputs are acronyms, initials, or brand names, which survive
    //    translation unchanged.
    if (letters < MIN_LETTERS_FOR_JUDGEMENT) {
      return { ...result, reason: "too-short" };
    }

    // 7. A single Latin token with no spaces is a brand name, an acronym, or a
    //    transliteration (Netflix, SNS, Toyota), which survives translation
    //    unchanged in nearly every language. Other scripts get no such escape:
    //    a lone Cyrillic or Han token for a Latin target is not a brand name in
    //    the target's writing system.
    if (observedScripts.includes("Latin") && !/\s/.test(translated.trim())) {
      return { ...result, reason: "single-token" };
    }

    // 8. The output is in some third script: not the target's, not the source's.
    //    For a Latin target this also rejects romanization, which is not the
    //    target language even though it is readable.
    return { ...result, verdict: "reject", reason: "wrong-script" };
  }

  /** Human-readable explanation for a rejection, used in status messages. */
  function describeRejection(result) {
    const target = result?.targetLanguage || "the target language";
    const observed = scriptLabels(result?.observedScripts || []);

    switch (result?.reason) {
      case "empty":
        return "Verification failed: the model returned no text.";
      case "source-language-leaked":
        return observed
          ? `Verification failed: the model returned the original ${observed} text instead of translating into ${target}.`
          : `Verification failed: the model returned the original text instead of translating into ${target}.`;
      case "wrong-script":
        return observed
          ? `Verification failed: the result is written in ${observed}, not ${target}.`
          : `Verification failed: the result was not written in ${target}.`;
      default:
        return `Verification failed for ${target}.`;
    }
  }

  /** Flat, log-friendly rollup of a batch's verdicts. */
  function summarize(results) {
    const list = Array.isArray(results) ? results : [];
    const rejected = list.filter((entry) => entry?.verdict === "reject");
    const reasons = [...new Set(rejected.map((entry) => entry.reason))]
      .filter(Boolean)
      .join(" | ");

    return {
      status: "checked",
      checked: list.length,
      accepted: list.length - rejected.length,
      rejected: rejected.length,
      reason: reasons,
    };
  }

  globalThis.LSTTranslationGuard = Object.freeze({
    LIMITS: Object.freeze({ MIN_LETTERS_FOR_JUDGEMENT }),
    describeRejection,
    scriptsForLanguage,
    scriptCounts,
    summarize,
    verify,
  });
})();
