// Pure playback policy. This module answers whether paused caching may run and
// why, without touching the DOM, storage, timers, or the translation provider.
// Keeping this decision out of content.js makes the scheduler, HUD, popup and
// tests describe the same state instead of each inferring it independently.
(() => {
  const PAUSED_CACHE_REASON = Object.freeze({
    ready: "ready",
    videoPlaying: "video-playing",
    settingDisabled: "cache-while-paused-disabled",
    translationPaused: "translation-paused",
    noModel: "no-model",
    noFullTrack: "no-full-track",
    translationUnnecessary: "translation-unnecessary",
    precomputing: "precomputing",
    complete: "cache-complete",
  });

  function pausedCacheDecision(input = {}) {
    if (!input.videoPaused) {
      return { allowed: false, reason: PAUSED_CACHE_REASON.videoPlaying };
    }
    if (input.cacheWhilePaused === false) {
      return { allowed: false, reason: PAUSED_CACHE_REASON.settingDisabled };
    }
    if (input.translationPaused) {
      return { allowed: false, reason: PAUSED_CACHE_REASON.translationPaused };
    }
    if (!input.model) {
      return { allowed: false, reason: PAUSED_CACHE_REASON.noModel };
    }
    if (!(Number(input.cueCount) > 0)) {
      return { allowed: false, reason: PAUSED_CACHE_REASON.noFullTrack };
    }
    if (input.needsTranslation === false) {
      return { allowed: false, reason: PAUSED_CACHE_REASON.translationUnnecessary };
    }
    if (input.precomputing) {
      return { allowed: false, reason: PAUSED_CACHE_REASON.precomputing };
    }
    if (input.complete) {
      return { allowed: false, reason: PAUSED_CACHE_REASON.complete };
    }
    return { allowed: true, reason: PAUSED_CACHE_REASON.ready };
  }

  function describePausedCacheDecision(decision) {
    switch (decision?.reason) {
      case PAUSED_CACHE_REASON.ready:
        return "Paused caching can run.";
      case PAUSED_CACHE_REASON.videoPlaying:
        return "Pause the video to build more of the episode cache.";
      case PAUSED_CACHE_REASON.settingDisabled:
        return "Caching while the video is paused is turned off.";
      case PAUSED_CACHE_REASON.translationPaused:
        return "Translation is paused, so background caching is paused too.";
      case PAUSED_CACHE_REASON.noModel:
        return "Choose a translation model before building the cache.";
      case PAUSED_CACHE_REASON.noFullTrack:
        return "A full subtitle track has not been captured; DOM realtime mode cannot build the episode cache.";
      case PAUSED_CACHE_REASON.translationUnnecessary:
        return "These subtitles already match the target language, so no translation cache is needed.";
      case PAUSED_CACHE_REASON.precomputing:
        return "Full-episode precompute is already running.";
      case PAUSED_CACHE_REASON.complete:
        return "The remaining episode subtitles are already cached.";
      default:
        return "Paused caching is unavailable for an unknown reason.";
    }
  }

  globalThis.LSTPlaybackPolicy = Object.freeze({
    PAUSED_CACHE_REASON,
    pausedCacheDecision,
    describePausedCacheDecision,
  });
})();
