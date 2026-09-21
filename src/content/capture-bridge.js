// Reliable hand-off between the page-world network hook and the isolated
// content script. The two worlds start independently, so a plain postMessage
// can arrive before content.js has installed its much larger player runtime.
// This tiny script listens first, queues by event id, and acknowledges an event
// only after content.js has subscribed and accepted its payload.
(() => {
  if (globalThis.LSTCaptureBridge) return;

  const SOURCE = "lst-local-subtitle-translate";
  const PAGE_CHANNEL = "page-capture";
  const CONTENT_CHANNEL = "content-capture";
  const queued = new Map();
  const delivered = new Set();
  let subscriber = null;
  let pageReady = false;
  let readyTimer = null;
  let receivedCount = 0;
  let replayCount = 0;
  let acknowledgedCount = 0;
  let deliveryFailureCount = 0;

  function post(type, extra = {}) {
    window.postMessage(
      { source: SOURCE, channel: CONTENT_CHANNEL, type, ...extra },
      "*",
    );
  }

  function acknowledge(eventId) {
    if (!eventId) return;
    acknowledgedCount += 1;
    post("CAPTURE_EVENT_ACK", { eventId });
  }

  function deliver(message) {
    const eventId = String(message?.eventId || "");
    if (!eventId || delivered.has(eventId)) {
      if (eventId) acknowledge(eventId);
      return;
    }
    if (!subscriber) {
      queued.set(eventId, message);
      return;
    }
    try {
      subscriber(message);
      delivered.add(eventId);
      queued.delete(eventId);
      acknowledge(eventId);
    } catch {
      // Keep the event queued. A later subscription/ready exchange can retry it.
      deliveryFailureCount += 1;
      queued.set(eventId, message);
    }
  }

  function announceReady() {
    post("CAPTURE_CONSUMER_READY");
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== SOURCE) return;
    if (event.data?.channel !== PAGE_CHANNEL) return;
    if (event.data.type === "CAPTURE_BRIDGE_READY") {
      pageReady = true;
      if (readyTimer !== null) clearInterval(readyTimer);
      readyTimer = null;
      return;
    }
    if (["SUBTITLE_DOCUMENT", "SUBTITLE_CAPTURE", "EPISODE_IDENTITY"].includes(event.data.type)) {
      receivedCount += 1;
      if (event.data.delivery === "replay") replayCount += 1;
      deliver(event.data);
    }
  });

  globalThis.LSTCaptureBridge = Object.freeze({
    subscribe(handler) {
      if (typeof handler !== "function") return () => {};
      subscriber = handler;
      for (const message of [...queued.values()]) deliver(message);
      announceReady();
      return () => {
        if (subscriber === handler) subscriber = null;
      };
    },
    // Counts only: never expose a captured payload, subtitle text, or URL to a
    // diagnostic page. This makes startup ordering failures visible without
    // making a troubleshooting report contain viewing data.
    snapshot() {
      return {
        pageReady,
        subscriberReady: Boolean(subscriber),
        receivedCount,
        replayCount,
        queuedCount: queued.size,
        deliveredCount: delivered.size,
        acknowledgedCount,
        deliveryFailureCount,
      };
    },
  });

  // Either world may be scheduled first. Repeat the handshake until the page
  // hook confirms it is listening; afterward there is no polling.
  announceReady();
  readyTimer = setInterval(() => {
    if (!pageReady) announceReady();
  }, 250);
})();
