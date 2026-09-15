(() => {
  class TranslationCoordinator {
    constructor({ keyFor, runBatch, onEvent = () => {} }) {
      this.keyFor = keyFor;
      this.runBatch = runBatch;
      this.onEvent = onEvent;
      this.inFlight = new Map();
    }

    has(key) {
      return this.inFlight.has(key);
    }

    async translate(items) {
      const unique = [];
      const seen = new Set();
      for (const item of items || []) {
        const key = this.keyFor(item);
        if (!seen.has(key)) {
          seen.add(key);
          unique.push({ key, item });
        }
      }

      const waiting = [];
      const owned = [];
      for (const entry of unique) {
        const existing = this.inFlight.get(entry.key);
        if (existing) {
          this.onEvent("translation-inflight-joined", { key: entry.key });
          waiting.push(existing);
          continue;
        }

        let resolve;
        let reject;
        const promise = new Promise((resolvePromise, rejectPromise) => {
          resolve = resolvePromise;
          reject = rejectPromise;
        });
        this.inFlight.set(entry.key, promise);
        waiting.push(promise);
        owned.push({ ...entry, promise, resolve, reject });
      }

      if (owned.length) this.startOwnedBatch(owned);

      const settled = await Promise.allSettled(waiting);
      const rejected = settled.find((result) => result.status === "rejected");
      if (rejected) throw rejected.reason;

      const entries = {};
      const failures = [];
      for (const result of settled) {
        const value = result.value;
        if (value.text) entries[value.key] = value.text;
        if (value.failure) failures.push(value.failure);
      }
      return { entries, failures };
    }

    startOwnedBatch(owned) {
      this.onEvent("translation-batch-owned", { count: owned.length });
      Promise.resolve()
        .then(() => this.runBatch(owned.map(({ item }) => item)))
        .then((result) => {
          for (const entry of owned) {
            const failure = (result.failures || []).find(
              (candidate) => String(candidate.id) === entry.key,
            );
            entry.resolve({
              key: entry.key,
              text: result.entries?.[entry.key] || "",
              failure,
            });
          }
        })
        .catch((error) => {
          for (const entry of owned) entry.reject(error);
        })
        .finally(() => {
          for (const entry of owned) {
            if (this.inFlight.get(entry.key) === entry.promise) {
              this.inFlight.delete(entry.key);
            }
          }
        });
    }
  }

  globalThis.LSTTranslationCoordinator = TranslationCoordinator;
})();
