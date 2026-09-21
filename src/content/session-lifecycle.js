// Playback-session lifecycle state.
//
// The player runtime owns effects such as DOM cleanup and message sending. This
// module owns the smaller state machine those effects follow: whether a session
// is active, which async generation is current, and the bounded transition
// history exposed in troubleshooting diagnostics.
(() => {
  function createSessionLifecycle({ transitionLimit = 12 } = {}) {
    let active = false;
    let playbackGeneration = 0;
    let cacheGeneration = 0;
    const transitions = [];

    return Object.freeze({
      get active() {
        return active;
      },
      get playbackGeneration() {
        return playbackGeneration;
      },
      get cacheGeneration() {
        return cacheGeneration;
      },
      start() {
        active = true;
        playbackGeneration += 1;
        return playbackGeneration;
      },
      stop() {
        active = false;
        playbackGeneration += 1;
        return playbackGeneration;
      },
      deactivate(generation = playbackGeneration) {
        if (generation !== playbackGeneration) return false;
        active = false;
        return true;
      },
      bumpCacheGeneration() {
        cacheGeneration += 1;
        return cacheGeneration;
      },
      playbackIsCurrent(generation) {
        return active && generation === playbackGeneration;
      },
      cacheIsCurrent(generation) {
        return generation === cacheGeneration;
      },
      recordTransition(transition) {
        transitions.push(Object.freeze({ ...transition }));
        while (transitions.length > transitionLimit) transitions.shift();
      },
      transitions() {
        return transitions.map((transition) => ({ ...transition }));
      },
      snapshot() {
        return {
          active,
          playbackGeneration,
          cacheGeneration,
          transitions: transitions.map((transition) => ({ ...transition })),
        };
      },
    });
  }

  const api = Object.freeze({ createSessionLifecycle });
  globalThis.LSTSessionLifecycle = api;
  if (typeof module !== "undefined" && module?.exports) module.exports = api;
})();
