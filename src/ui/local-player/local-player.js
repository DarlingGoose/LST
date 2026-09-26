(() => {
  "use strict";

  const ext = globalThis.browser || globalThis.chrome;
  const $ = (id) => document.getElementById(id);
  const importApi = globalThis.LSTSubtitleImport;
  const identityApi = globalThis.LSTEpisodeIdentity;
  const localApi = globalThis.LSTLocalVideo;
  const settingsApi = globalThis.LSTSettingsSchema;

  const state = {
    videoFile: null,
    subtitleFile: null,
    subtitleText: "",
    videoUrl: "",
    mediaId: "",
    cues: [],
    translations: {},
    settings: settingsApi.defaults(),
    run: 0,
    translating: false,
    frame: 0,
  };

  async function message(payload) {
    const response = await ext.runtime.sendMessage(payload);
    if (!response?.ok) throw new Error(response?.error || "Request failed.");
    return response;
  }

  function selectedProvider() {
    return state.settings.provider || "ollama";
  }

  function selectedModel() {
    return $("model").value.trim();
  }

  function selectedLanguage() {
    return $("targetLanguage").value.trim() || "English";
  }

  function currentCacheId() {
    if (!state.mediaId) return "";
    return identityApi.encodeCacheId({
      videoId: state.mediaId,
      siteId: "local",
      provider: selectedProvider(),
      model: selectedModel(),
      targetLanguage: selectedLanguage(),
    });
  }

  function cueKey(cue) {
    return localApi.cueKey(cue);
  }

  function metadata() {
    const videoName = state.videoFile?.name || "Local video";
    return {
      siteId: "local",
      videoId: state.mediaId,
      showName: "Local Video",
      episodeName: videoName,
      title: videoName,
      sourceCueCount: state.cues.length,
    };
  }

  function updateProgress(note = "") {
    const translated = state.cues.reduce(
      (count, cue) => count + (state.translations[cueKey(cue)] ? 1 : 0),
      0,
    );
    const total = state.cues.length;
    $("progress").max = Math.max(1, total);
    $("progress").value = translated;
    $("progressText").textContent = total
      ? `${translated} / ${total} subtitles translated`
      : "Attach an SRT file to translate it.";
    $("statusText").textContent = note;
    $("translate").disabled = !readyToTranslate() || state.translating;
    $("stop").disabled = !state.translating;
  }

  function setError(error) {
    updateProgress(`Could not continue: ${error?.message || error}`);
  }

  function readyToTranslate() {
    return Boolean(state.videoFile && state.subtitleFile && state.cues.length && selectedModel());
  }

  function isVideoFile(file) {
    return Boolean(file) && (
      String(file.type || "").startsWith("video/") ||
      /\.(?:mp4|m4v|webm|mkv|mov|ogv|avi)$/i.test(String(file.name || ""))
    );
  }

  function renderSubtitles() {
    const active = localApi.activeCuesAt(state.cues, $("video").currentTime);
    const originals = active.map((cue) => cue.text).join("\n");
    const translated = active
      .map((cue) => state.translations[cueKey(cue)] || "")
      .filter(Boolean)
      .join("\n");
    const mode = $("displayMode").value;
    $("translatedLine").textContent = mode === "original" ? "" : translated;
    $("originalLine").textContent = mode === "translated" ? "" : originals;
  }

  function playbackFrame() {
    renderSubtitles();
    if (!$("video").paused && !$("video").ended) {
      state.frame = requestAnimationFrame(playbackFrame);
    }
  }

  function startPlaybackFrames() {
    cancelAnimationFrame(state.frame);
    playbackFrame();
  }

  async function loadCache(note = "") {
    state.translations = {};
    const cacheId = currentCacheId();
    if (!cacheId || !state.cues.length) {
      updateProgress(note);
      renderSubtitles();
      return;
    }
    const response = await message({
      type: "CACHE_GET",
      cacheId,
      keys: state.cues.map(cueKey),
    });
    // A model/language change may finish its newer cache read first. A late
    // response from the previous selection must not replace it on screen.
    if (cacheId !== currentCacheId()) return;
    state.translations = response.entries || {};
    updateProgress(note || (Object.keys(state.translations).length ? "Loaded cached translations." : "Ready to translate."));
    renderSubtitles();
  }

  async function rebuildIdentity() {
    if (!state.videoFile || !state.subtitleFile || !state.subtitleText) return;
    state.mediaId = localApi.mediaIdentity(
      state.videoFile,
      state.subtitleFile,
      state.subtitleText,
    );
    await loadCache();
    if (readyToTranslate()) translateMissing();
  }

  function setVideo(file, rebuild = true) {
    if (!isVideoFile(file)) {
      throw new Error("Choose a video file.");
    }
    if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
    state.videoFile = file;
    state.videoUrl = URL.createObjectURL(file);
    $("video").src = state.videoUrl;
    $("emptyPlayer").hidden = true;
    $("videoName").textContent = file.name;
    state.run += 1;
    state.mediaId = "";
    if (!rebuild) {
      state.subtitleFile = null;
      state.subtitleText = "";
      state.cues = [];
      state.translations = {};
      $("subtitleName").textContent = "No subtitles selected";
      updateProgress("Reading the new subtitle file…");
      renderSubtitles();
    }
    if (rebuild) rebuildIdentity().catch(setError);
  }

  async function setSubtitles(file) {
    if (!file || !/\.srt$/i.test(file.name)) {
      throw new Error("Choose a SubRip (.srt) subtitle file.");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const decoded = importApi.decodeSubtitleBytes(bytes);
    if (!decoded.text) throw new Error("The subtitle file could not be decoded.");
    const cues = importApi.parseSrt(decoded.text);
    if (!cues.length) throw new Error("The SRT file has no readable timed subtitles.");
    state.subtitleFile = file;
    state.subtitleText = decoded.text;
    state.cues = cues;
    state.run += 1;
    state.mediaId = "";
    state.translations = {};
    $("subtitleName").textContent = `${file.name} · ${cues.length} cues · ${decoded.encoding}`;
    updateProgress("Subtitle timestamps loaded.");
    renderSubtitles();
    await rebuildIdentity();
  }

  async function acceptFiles(files) {
    const list = [...files];
    const video = list.find(isVideoFile);
    const subtitle = list.find((file) => /\.srt$/i.test(file.name));
    try {
      // When both arrive in one drop, wait for the new subtitle before deriving
      // identity. Otherwise a replacement video can briefly pair with the old
      // subtitle and start work the viewer did not ask for.
      if (video) setVideo(video, !subtitle);
      if (subtitle) await setSubtitles(subtitle);
      if (!video && !subtitle) throw new Error("Drop a video or .srt file.");
    } catch (error) {
      setError(error);
    }
  }

  function contextFor(batch) {
    if (!state.settings.useTranslationContext || !batch.length) return [];
    const first = state.cues.indexOf(batch[0]);
    const last = state.cues.indexOf(batch[batch.length - 1]);
    return state.cues
      .slice(Math.max(0, first - 2), Math.min(state.cues.length, last + 3))
      .filter((cue) => !batch.includes(cue))
      .map((cue) => ({ id: cueKey(cue), text: cue.text, start: cue.start, end: cue.end }));
  }

  async function translateMissing() {
    if (!readyToTranslate() || state.translating) return;
    const run = ++state.run;
    const requestedCacheId = currentCacheId();
    const requestedMetadata = metadata();
    const provider = selectedProvider();
    const model = selectedModel();
    const targetLanguage = selectedLanguage();
    state.translating = true;
    updateProgress("Checking the local cache…");
    try {
      await loadCache();
      const batchSize = Math.max(1, Number(state.settings.batchSize) || 8);
      const missing = state.cues.filter((cue) => !state.translations[cueKey(cue)]);
      if (!missing.length) {
        updateProgress("All subtitles are already cached.");
        return;
      }

      for (let offset = 0; offset < missing.length; offset += batchSize) {
        if (run !== state.run) {
          updateProgress("Translation stopped. Cached work is preserved.");
          return;
        }
        const batch = missing.slice(offset, offset + batchSize);
        updateProgress(`Translating in the background · batch ${Math.floor(offset / batchSize) + 1} of ${Math.ceil(missing.length / batchSize)}`);
        const response = await message({
          type: "TRANSLATE_BATCH",
          provider,
          model,
          targetLanguage,
          requestTimeoutSeconds: state.settings.requestTimeoutSeconds,
          contextLevel: state.settings.contextLevel,
          contextItems: contextFor(batch),
          items: batch.map((cue) => ({ id: cueKey(cue), text: cue.text })),
        });
        if (run !== state.run) return;
        const entries = {};
        for (const item of response.translations || []) {
          if (item?.id && item?.text) entries[item.id] = item.text;
        }
        Object.assign(state.translations, entries);
        if (Object.keys(entries).length) {
          await message({
            type: "CACHE_SET",
            cacheId: requestedCacheId,
            entries,
            metadata: requestedMetadata,
          });
        }
        renderSubtitles();
      }
      const remaining = state.cues.filter((cue) => !state.translations[cueKey(cue)]).length;
      updateProgress(remaining
        ? `${remaining} subtitles could not be translated. Use Translate / resume to retry.`
        : "Translation complete. The cache is stored locally.");
    } catch (error) {
      if (run === state.run) setError(error);
    } finally {
      if (run === state.run) {
        state.translating = false;
        updateProgress($("statusText").textContent);
      }
    }
  }

  async function loadSettings() {
    const response = await message({ type: "GET_SETTINGS" });
    state.settings = { ...settingsApi.defaults(), ...(response.settings || {}) };
    $("targetLanguage").value = state.settings.targetLanguage || "English";
    $("displayMode").value = state.settings.showOriginal
      ? (state.settings.showTranslated === false ? "original" : "both")
      : "translated";
    const select = $("model");
    try {
      const models = await message({
        type: "GET_MODELS",
        provider: selectedProvider(),
        ollamaUrl: state.settings.ollamaUrl,
      });
      select.replaceChildren();
      for (const model of models.models || []) {
        select.add(new Option(model.name, model.name));
      }
    } catch (error) {
      select.replaceChildren();
      $("statusText").textContent = `Models unavailable: ${error.message}`;
    }
    if (state.settings.model && ![...select.options].some((option) => option.value === state.settings.model)) {
      select.add(new Option(state.settings.model, state.settings.model));
    }
    select.value = state.settings.model || select.options[0]?.value || "";
    updateProgress();
    if (state.videoFile && state.subtitleFile) rebuildIdentity().catch(setError);
  }

  $("videoInput").addEventListener("change", (event) => acceptFiles(event.target.files));
  $("subtitleInput").addEventListener("change", (event) => acceptFiles(event.target.files));
  for (const type of ["dragenter", "dragover"]) {
    $("dropZone").addEventListener(type, (event) => {
      event.preventDefault();
      $("dropZone").classList.add("dragging");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    $("dropZone").addEventListener(type, (event) => {
      event.preventDefault();
      $("dropZone").classList.remove("dragging");
    });
  }
  $("dropZone").addEventListener("drop", (event) => acceptFiles(event.dataTransfer.files));
  $("video").addEventListener("play", startPlaybackFrames);
  $("video").addEventListener("pause", renderSubtitles);
  $("video").addEventListener("seeked", renderSubtitles);
  $("video").addEventListener("timeupdate", renderSubtitles);
  $("displayMode").addEventListener("change", renderSubtitles);
  $("playbackRate").addEventListener("change", () => {
    $("video").playbackRate = Number($("playbackRate").value) || 1;
  });
  $("fullscreen").addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await $("playerShell").requestFullscreen();
    } catch (error) {
      setError(new Error(`Fullscreen is unavailable: ${error.message}`));
    }
  });
  function translationOwnerChanged(note) {
    state.run += 1;
    state.translating = false;
    loadCache(note).catch(setError);
  }
  $("model").addEventListener("change", () =>
    translationOwnerChanged("Model changed. This model has its own cache."));
  $("targetLanguage").addEventListener("change", () =>
    translationOwnerChanged("Language changed. This language has its own cache."));
  $("translate").addEventListener("click", translateMissing);
  $("stop").addEventListener("click", () => {
    state.run += 1;
    state.translating = false;
    updateProgress("Translation stopped. Cached work is preserved.");
  });
  addEventListener("beforeunload", () => {
    state.run += 1;
    if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
  });

  loadSettings().catch(setError);
})();
