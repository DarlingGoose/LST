// One owner for automatic prompt choice and per-model precedence. Model names
// are only a size hint; unknown sizes use the concise prompt.
(() => {
  if (globalThis.LSTPromptPolicy) return;

  const SMALL_PROMPT = [
    "Translate the requested subtitles into {{targetLanguage}} using natural, concise dialogue.",
    "Preserve the original meaning, tone, character names, honorifics, and speaking style.",
    "Use surrounding dialogue to infer omitted subjects, pronouns, and gender when clear. Do not guess when uncertain.",
    "Keep each translation short and natural. Do not add information.",
    "Translate every item in order. Do not merge, split, or skip items.",
    "Return only the translations in the required format. No explanations or romanization.",
  ].join("\n\n");

  const LARGE_PROMPT = [
    "You are an expert subtitle translator. Translate every requested subtitle into {{targetLanguage}}.",
    "Translate naturally and concisely, preserving the original meaning, tone, emotion, and character relationships. Dialogue should sound like something a native speaker would actually say.",
    "Use surrounding dialogue and available speaker information to determine the intended subject, speaker, pronouns, and gender. Infer these only when supported by context. When ambiguous, prefer natural wording that avoids unnecessary assumptions.",
    "Preserve character names, honorifics, speaker labels, and important cultural nuances. Maintain each character's personality, politeness level, and manner of speaking.",
    "Do not translate word-for-word when a more natural expression conveys the same meaning. Do not add information that is not implied by the original.",
    "Translate every requested item independently while maintaining conversational continuity. Never merge, split, omit, duplicate, or reorder items.",
    "Preserve the input's required structure, identifiers, and formatting.",
    "Output only the translations in the required format. Do not include explanations, notes, analysis, or romanization.",
  ].join("\n\n");

  function keyFor(provider, model) {
    return `${String(provider || "ollama").trim()}:${String(model || "").trim()}`;
  }

  function sizeBillions(model) {
    // Recognize tags such as translategemma:12b and qwen3:8b, but not a
    // version number in a name such as gemini-2.5-pro.
    const match = String(model || "").match(/(?:^|[:/_-])(\d+(?:\.\d+)?)b(?:$|[-_:/])/i);
    return match ? Number(match[1]) : null;
  }

  function automatic(model) {
    const size = sizeBillions(model);
    return { prompt: size != null && size >= 7 ? LARGE_PROMPT : SMALL_PROMPT,
      tier: size != null && size >= 7 ? "large" : "small",
      sizeBillions: size };
  }

  function resolve({ provider, model, modelPrompts, customTranslationPrompt } = {}) {
    const perModel = modelPrompts?.[keyFor(provider, model)];
    if (typeof perModel === "string" && perModel.trim()) {
      return { prompt: perModel.trim(), source: "model" };
    }
    if (typeof customTranslationPrompt === "string" && customTranslationPrompt.trim()) {
      return { prompt: customTranslationPrompt.trim(), source: "global" };
    }
    return { ...automatic(model), source: "automatic" };
  }

  globalThis.LSTPromptPolicy = Object.freeze({ SMALL_PROMPT, LARGE_PROMPT, keyFor, sizeBillions, automatic, resolve });
})();
