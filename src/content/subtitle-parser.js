// Timed-text document parsing for the isolated player runtime.
//
// This module is deliberately state-free: subtitle text and an optional SubRip
// parser go in, normalized cue records come out. TTML uses the DOMParser already
// available in a content-script world; no network, storage, or timers belong
// here.
(() => {
  function normalizeText(value) {
    return String(value ?? "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();
  }

  function parseClock(value, tickRate = 10_000_000) {
    if (!value) return NaN;
    value = String(value).trim();
    if (/^\d+(?:\.\d+)?t$/.test(value)) {
      return Number(value.slice(0, -1)) / tickRate;
    }
    if (/^\d+(?:\.\d+)?ms$/.test(value)) {
      return Number(value.slice(0, -2)) / 1000;
    }
    if (/^\d+(?:\.\d+)?s$/.test(value)) return Number(value.slice(0, -1));
    if (/^\d+(?:\.\d+)?m$/.test(value)) return Number(value.slice(0, -1)) * 60;
    if (/^\d+(?:\.\d+)?h$/.test(value)) return Number(value.slice(0, -1)) * 3600;

    const match = value.match(/^(\d+):(\d{2}):(\d{2})(?:[.,](\d+))?$/);
    if (match) {
      const [, hours, minutes, seconds, fraction = "0"] = match;
      return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) +
        Number(`0.${fraction}`);
    }
    return Number(value);
  }

  function extractNodeText(node) {
    if (!node) return "";
    const clone = node.cloneNode(true);
    for (const br of clone.querySelectorAll("br")) br.replaceWith("\n");
    return normalizeText(clone.textContent || "");
  }

  function parseTtml(text, DOMParserClass = globalThis.DOMParser) {
    if (typeof DOMParserClass !== "function") return [];
    const doc = new DOMParserClass().parseFromString(text, "application/xml");
    if (doc.querySelector("parsererror")) return [];
    const tt = doc.documentElement;
    const tickRate = Number(
      tt.getAttribute("ttp:tickRate") || tt.getAttribute("tickRate") || 10_000_000,
    );
    return [...doc.getElementsByTagNameNS("*", "p")]
      .map((node, index) => {
        const start = parseClock(node.getAttribute("begin"), tickRate);
        let end = parseClock(node.getAttribute("end"), tickRate);
        const duration = parseClock(node.getAttribute("dur"), tickRate);
        if (!Number.isFinite(end) && Number.isFinite(start) && Number.isFinite(duration)) {
          end = start + duration;
        }
        return {
          id: node.getAttribute("xml:id") || node.getAttribute("id") || String(index),
          start,
          end,
          text: extractNodeText(node),
        };
      })
      .filter((cue) =>
        Number.isFinite(cue.start) && Number.isFinite(cue.end) &&
        cue.end > cue.start && cue.text);
  }

  function parseVttTimestamp(value) {
    const parts = String(value || "").trim().split(":").map(Number);
    if (parts.some(Number.isNaN)) return NaN;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return NaN;
  }

  function parseVtt(text) {
    const lines = String(text || "").replace(/\r/g, "").split("\n");
    const result = [];
    let index = 0;
    while (index < lines.length) {
      let line = lines[index].trim();
      if (!line || line === "WEBVTT" || line.startsWith("NOTE")) {
        index++;
        continue;
      }
      let id = "";
      if (!line.includes("-->") && index + 1 < lines.length && lines[index + 1].includes("-->")) {
        id = line;
        line = lines[++index].trim();
      }
      const match = line.match(/^(\S+)\s+-->\s+(\S+)/);
      if (!match) {
        index++;
        continue;
      }
      const start = parseVttTimestamp(match[1].replace(",", "."));
      const end = parseVttTimestamp(match[2].replace(",", "."));
      index++;
      const payload = [];
      while (index < lines.length && lines[index].trim() !== "") {
        payload.push(lines[index++]);
      }
      const cueText = normalizeText(payload.join("\n").replace(/<[^>]+>/g, ""));
      if (Number.isFinite(start) && Number.isFinite(end) && cueText) {
        result.push({ id: id || String(result.length), start, end, text: cueText });
      }
    }
    return result;
  }

  function parseSubtitleDocument(text, options = {}) {
    const trimmed = String(text || "").trim();
    if (/^WEBVTT\b/i.test(trimmed)) return parseVtt(trimmed);
    if (/<tt[\s>]/i.test(trimmed)) {
      return parseTtml(trimmed, options.DOMParserClass || globalThis.DOMParser);
    }
    if (typeof options.parseSrt === "function" && /-->/.test(trimmed)) {
      return options.parseSrt(trimmed);
    }
    return [];
  }

  const api = Object.freeze({
    parseClock,
    parseTtml,
    parseVttTimestamp,
    parseVtt,
    parseSubtitleDocument,
  });
  globalThis.LSTSubtitleParser = api;
  if (typeof module !== "undefined" && module?.exports) module.exports = api;
})();
