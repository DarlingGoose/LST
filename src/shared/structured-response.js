/**
 * LST structured response handling.
 *
 * A batch translation asks the model for JSON. Local models are inconsistent
 * about that JSON: they wrap it in prose or a code fence, they truncate it when
 * they run out of tokens, they decorate the ids they were given, and they
 * occasionally drop a line. This file turns whatever came back into a map from
 * requested id to translated text.
 *
 * Two rules keep it honest:
 *
 * 1. Identity belongs to code. Callers hand out short ordinals, so the model is
 *    only ever asked to answer "translate line n". LST's real cue key is
 *    "<startMs>:<endMs>:<source text>", which models routinely shorten or
 *    translate; mapping back never depends on reproducing that string.
 * 2. Nothing is guessed silently. A line that cannot be aligned is reported as
 *    missing so the caller can re-ask for exactly that line. Positional
 *    recovery exists but only fires when the response carries no recognizable
 *    id at all, because guessing the remainder of a partially-matched batch is
 *    how a translation lands on the wrong cue.
 *
 * No network access, no storage, and no extension APIs.
 */
(() => {
  "use strict";

  // Property names that have been seen wrapping the array of translations.
  const ROW_KEYS = [
    "translations",
    "translation",
    "items",
    "subtitles",
    "results",
    "lines",
    "cues",
    "output",
    "data"
  ];

  // A model that wraps its JSON in text usually also fences it.
  const FENCE = /```(?:json|JSON)?\s*([\s\S]*?)```/;

  // Every structure that could be the container, in document order, capped so a
  // long response cannot turn this into a scan of its own.
  const MAX_CANDIDATE_STARTS = 24;

  function tryParse(text) {
    try {
      const value = JSON.parse(text);
      return value && typeof value === "object" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  function candidateStarts(text) {
    const starts = [];
    for (let index = 0; index < text.length; index += 1) {
      if (starts.length >= MAX_CANDIDATE_STARTS) break;
      const character = text[index];
      if (character === "{" || character === "[") starts.push(index);
    }
    return starts;
  }

  /**
   * Walk from the first brace/bracket, respecting strings and escapes, and
   * report where the structure ends. An unbalanced tail means the model was cut
   * off, so the end of the last complete array element is reported too.
   */
  function scanBalanced(text, start) {
    const opensObject = text[start] === "{";
    const elementDepth = opensObject ? 2 : 1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let lastElementEnd = -1;

    for (let index = start; index < text.length; index += 1) {
      const character = text[index];

      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }

      if (character === '"') {
        inString = true;
      } else if (character === "{" || character === "[") {
        depth += 1;
      } else if (character === "}" || character === "]") {
        depth -= 1;
        if (depth === 0) {
          return { end: index + 1, lastElementEnd, balanced: true };
        }
        if (depth === elementDepth) lastElementEnd = index + 1;
      }
    }

    return { end: text.length, lastElementEnd, balanced: false };
  }

  /**
   * Recover the JSON object from a raw model response.
   *
   * Returns `{ value, strategy }` where strategy names the recovery that
   * worked: "direct", "fenced", "scanned", or "repaired". `value` is undefined
   * when nothing usable was found, and the caller must treat that as a failure
   * rather than as an empty batch.
   */
  function extractJson(raw) {
    const text = String(raw ?? "");
    const trimmed = text.trim();

    const direct = tryParse(trimmed);
    if (direct !== undefined) return { value: direct, strategy: "direct", truncated: false };

    const fenced = FENCE.exec(text);
    if (fenced) {
      const inner = fenced[1].trim();
      const parsed = tryParse(inner);
      if (parsed !== undefined) return { value: parsed, strategy: "fenced", truncated: false };
    }

    // A model that adds a preamble or a closing remark still emits one JSON
    // value, and the container is the candidate that spans the most text. A
    // stray bracket in the preamble, or an echoed "[1]", spans almost nothing.
    let best = null;
    for (const start of candidateStarts(text)) {
      const scan = scanBalanced(text, start);
      // An unbalanced scan only counts for the elements it completed, so a
      // truncated fragment cannot out-reach the container it belongs to.
      const reach = scan.balanced ? scan.end : scan.lastElementEnd;
      if (!best || reach > best.reach) best = { start, scan, reach };
    }
    if (!best || best.reach < 0) {
      return { value: undefined, strategy: "none", truncated: text.length > 0 };
    }

    const opensObject = text[best.start] === "{";
    const { scan } = best;

    if (scan.balanced) {
      const parsed = tryParse(text.slice(best.start, scan.end));
      if (parsed !== undefined) return { value: parsed, strategy: "scanned", truncated: false };
    }

    // Truncated response: keep the elements that did arrive and close the
    // structure by hand. Losing the tail is fine; losing the whole batch is not.
    if (scan.lastElementEnd > best.start) {
      const repaired =
        text.slice(best.start, scan.lastElementEnd) + (opensObject ? "]}" : "]");
      const parsed = tryParse(repaired);
      if (parsed !== undefined) {
        return { value: parsed, strategy: "repaired", truncated: true };
      }
    }

    return { value: undefined, strategy: "none", truncated: !scan.balanced };
  }

  function asRow(row) {
    if (typeof row === "string") return { id: "", text: row.trim() };
    if (Array.isArray(row)) {
      return { id: String(row[0] ?? ""), text: String(row[1] ?? "").trim() };
    }
    if (!row || typeof row !== "object") return { id: "", text: "" };

    const id = row.id ?? row.index ?? row.i ?? row.cue ?? row.key ?? "";
    const text = row.text ?? row.translation ?? row.target ?? row.output ?? row.value ?? "";
    return { id: id === "" || id == null ? "" : String(id), text: String(text ?? "").trim() };
  }

  /**
   * Find the array of translations inside whatever the model returned. Handles
   * a bare array, a wrapped array, an id-keyed object, and a single bare row.
   */
  function readRows(value) {
    if (Array.isArray(value)) return { rows: value.map(asRow), shape: "array" };
    if (!value || typeof value !== "object") return { rows: [], shape: "none" };

    for (const [key, candidate] of Object.entries(value)) {
      if (!ROW_KEYS.includes(key.toLowerCase())) continue;
      if (Array.isArray(candidate)) return { rows: candidate.map(asRow), shape: key };
    }

    // {"translations": {"1": "text", "2": "text"}}
    for (const [key, candidate] of Object.entries(value)) {
      if (!ROW_KEYS.includes(key.toLowerCase())) continue;
      if (!candidate || typeof candidate !== "object") continue;
      const pairs = Object.entries(candidate).filter(([, text]) => typeof text === "string");
      if (pairs.length) {
        return {
          rows: pairs.map(([id, text]) => ({ id, text: text.trim() })),
          shape: `${key}-map`
        };
      }
    }

    const isRow = (object) =>
      object && typeof object === "object" &&
      (object.text != null || object.translation != null || object.target != null);
    if (isRow(value)) return { rows: [asRow(value)], shape: "row" };

    return { rows: [], shape: "none" };
  }

  /**
   * Models decorate an id they were handed: quotes, a leading hash, a trailing
   * dot, stray whitespace. Only that decoration is removed. Anything else stays
   * untouched, because an unrecognized id must fall through to "missing".
   */
  function normalizeId(value) {
    return String(value ?? "")
      .trim()
      .replace(/^["'`#\s]+/, "")
      .replace(/["'`\s]+$/, "")
      .replace(/\.$/, "")
      .trim();
  }

  /**
   * Map returned rows onto the ids that were requested.
   *
   * `inputIds` are the ids the model was asked about (normally ordinals). The
   * result is always in input order, so a model that answers out of order still
   * produces a deterministic translation list.
   */
  function alignRows(inputIds, rows) {
    const wanted = new Map();
    for (const id of inputIds) wanted.set(normalizeId(id), id);

    const texts = new Map();
    const unexpected = [];
    const duplicates = [];

    for (const row of rows || []) {
      const key = normalizeId(row?.id);
      const inputId = key ? wanted.get(key) : undefined;
      // A blank row is not an answer: the line stays outstanding and is
      // re-asked, rather than being cached as empty text.
      const text = String(row?.text ?? "").trim();

      if (inputId === undefined) {
        if (key) unexpected.push(key);
        continue;
      }
      if (!text) continue;
      if (texts.has(inputId)) {
        duplicates.push(key);
        continue;
      }
      texts.set(inputId, text);
    }

    const translations = inputIds
      .filter((id) => texts.has(id))
      .map((id) => ({ id, text: texts.get(id) }));
    const missing = inputIds.filter((id) => !texts.has(id));

    // Last resort, and deliberately narrow: positional recovery only runs when
    // not one returned id was recognized, so nothing in the response suggests a
    // reordering. Guessing the rest of a partially-matched batch is how a
    // translation ends up attached to the wrong cue.
    if (
      !translations.length &&
      inputIds.length > 0 &&
      rows.length === inputIds.length &&
      rows.every((row) => String(row?.text ?? "").trim())
    ) {
      return {
        translations: inputIds.map((id, index) => ({
          id,
          text: String(rows[index].text).trim()
        })),
        idRecovery: "positional",
        missing: [],
        unexpected,
        duplicates
      };
    }

    return {
      translations,
      idRecovery: !translations.length ? "none" : missing.length ? "partial" : "exact",
      missing,
      unexpected,
      duplicates
    };
  }

  /**
   * Replace caller ids with short ordinals for the request, keeping the mapping
   * back. "1", "2", "3" survive a round trip through a model; a cue key such as
   * "1500:3000:こんにちは" does not.
   */
  function toOrdinals(inputIds) {
    const byOrdinal = new Map();
    const ids = inputIds.map((id, index) => {
      const ordinal = String(index + 1);
      byOrdinal.set(ordinal, id);
      return ordinal;
    });
    return { ids, byOrdinal };
  }

  globalThis.LSTStructuredResponse = Object.freeze({
    alignRows,
    extractJson,
    normalizeId,
    readRows,
    toOrdinals
  });
})();
