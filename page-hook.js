(() => {
  if (window.__lstLocalSubtitleTranslateHooked) return;
  window.__lstLocalSubtitleTranslateHooked = true;

  const SOURCE = "lst-local-subtitle-translate";

  function isLikelySubtitleText(text) {
    if (!text || text.length < 20 || text.length > 5_000_000) return false;
    const head = text.slice(0, 4000);
    return (
      /\bWEBVTT\b/i.test(head) ||
      /<tt[\s>]/i.test(head) ||
      /<p\b[^>]*(?:begin|end)=/i.test(head)
    );
  }

  function publish(url, text) {
    if (!isLikelySubtitleText(text)) return;
    window.postMessage(
      {
        source: SOURCE,
        type: "SUBTITLE_DOCUMENT",
        payload: { url: String(url || ""), text }
      },
      "*"
    );
  }

  async function inspectResponse(response) {
    try {
      const url = response.url || "";
      const type = (response.headers.get("content-type") || "").toLowerCase();
      const length = Number(response.headers.get("content-length") || 0);

      const subtitleType =
        type.includes("ttml") ||
        type.includes("vtt") ||
        type.includes("xml") ||
        type.includes("text/plain");

      const subtitleUrl =
        /(?:subtitle|timedtext|caption|dfxp|webvtt|\.vtt(?:\?|$)|\.xml(?:\?|$)|\?o=)/i.test(url);

      if (!subtitleType && !subtitleUrl) return;
      if (length && length > 5_000_000) return;

      const text = await response.clone().text();
      publish(url, text);
    } catch {
      // Never let diagnostics interfere with Netflix playback.
    }
  }

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    inspectResponse(response);
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__notSubtitleUrl = String(url || "");
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      try {
        const url = this.responseURL || this.__notSubtitleUrl || "";
        const type = (this.getResponseHeader("content-type") || "").toLowerCase();

        const subtitleType =
          type.includes("ttml") ||
          type.includes("vtt") ||
          type.includes("xml") ||
          type.includes("text/plain");

        const subtitleUrl =
          /(?:subtitle|timedtext|caption|dfxp|webvtt|\.vtt(?:\?|$)|\.xml(?:\?|$)|\?o=)/i.test(url);

        if (!subtitleType && !subtitleUrl) return;
        if (this.responseType && this.responseType !== "" && this.responseType !== "text") return;

        publish(url, this.responseText);
      } catch {
        // Ignore capture failures.
      }
    });

    return originalSend.apply(this, args);
  };
})();
