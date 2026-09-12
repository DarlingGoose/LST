# LST — Local Subtitle Translate

A small cross-browser Manifest V3 extension for Firefox and Chromium browsers that translates Netflix subtitles using a local Ollama model.

[Privacy policy](PRIVACY.md) · [Firefox release guide](FIREFOX_RELEASE.md)

## Features

- Local Ollama only by default
- Discovers installed Ollama models with `/api/tags`
- Downloads Ollama models by name from Settings
- Select model and target language in the browser
- Realtime subtitle translation
- Time-based look-ahead translation with an enforced 30-second minimum
- Dual subtitle overlay
- Custom subtitle height, alignment, line width, font sizes, and background strength
- Independent visibility controls for Netflix subtitles, LST original text, and LST translations
- Captures Netflix TTML/WebVTT subtitle documents when available
- Precomputes an entire captured episode subtitle track
- Caches translations locally per Netflix watch ID + model + target language
- Browsable translated-episode storage with per-cache size and removal controls
- Structured JSON output from Ollama to keep batch translations aligned

## Important limitation

Netflix is a private, frequently changing web application. The robust path is:

1. Load a Netflix watch page.
2. Enable the **source subtitle language** you want translated.
3. The extension attempts to capture the TTML/WebVTT timed-text response Netflix loads for that track.
4. Once captured, use the extension popup → **Precompute episode subtitles**.

If Netflix changes its subtitle delivery or the timed-text response cannot be captured, the extension falls back to observing the rendered subtitle DOM and translating one cue at a time. That fallback cannot precompute unseen cues.

## Ollama setup

Check Ollama is running:

```bash
curl http://localhost:11434/api/tags
```

Pull a translation-capable model if needed, for example:

```bash
ollama pull qwen3:8b
```

Ollama requires browser extension origins to be allowed. For a manually launched Ollama server:

```bash
OLLAMA_ORIGINS=chrome-extension://*,moz-extension://* ollama serve
```

If Ollama is already running as a service on Linux, configure the environment variable on the service rather than launching another `ollama serve`.

A systemd override commonly looks like:

```ini
[Service]
Environment="OLLAMA_ORIGINS=chrome-extension://*,moz-extension://*"
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

You can narrow the origin later to this extension's specific `chrome-extension://<extension-id>` origin.

## Install in Firefox

For development/testing:

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Choose this extension's `manifest.json`.
4. Open the extension settings/options.
5. Click **Refresh models** and choose an installed Ollama model.
6. Open a Netflix watch page and enable the source subtitle track.
7. Open the extension popup.
8. Once it says the full subtitle track is captured, click **Precompute episode subtitles**.

A temporary Firefox add-on is removed when Firefox exits. For permanent personal installation, package/sign it through Mozilla's normal add-on workflow.

## Install in Chrome / Chromium / Brave

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder.
5. Open the extension's **Details → Extension options**.
6. Click **Refresh models**.
7. Select an installed Ollama model and target language.
8. Open Netflix and start an episode.
9. Enable the source subtitle track.
10. Open the extension popup.
11. If the popup says the full track was captured, click **Precompute episode subtitles**.

## How it works

```text
Netflix
  ├─ page-hook.js
  │    └─ observes fetch/XHR responses for TTML / WebVTT
  │
  └─ content.js
       ├─ parses timed cues
       ├─ syncs cue selection to <video>.currentTime
       ├─ renders the overlay
       └─ falls back to Netflix's rendered subtitle DOM
              │
              ▼
        background.js
          ├─ GET /api/tags
          ├─ POST /api/generate
          └─ chrome.storage.local cache
              │
              ▼
           Ollama
```

## Translation behavior

The extension sends small batches of subtitle strings to Ollama and requires a structured response shaped like:

```json
{
  "translations": [
    { "id": "cue-id", "text": "translated subtitle" }
  ]
}
```

If a model breaks the batch contract, the extension recursively splits the batch and retries smaller groups.

## Good model choices

For Japanese → English, start with a multilingual instruction model that fits comfortably in VRAM. Smaller models reduce subtitle latency; larger models generally improve nuance. The extension deliberately does not hard-code model names because it reads your installed list directly from Ollama.

## Development notes

There is no build step. Reload the unpacked extension after editing files.

Useful files:

- `page-hook.js`: Netflix timed-text capture
- `content.js`: parser, sync, overlay, realtime/precompute behavior
- `background.js`: Ollama client + cache (uses the standard `browser` API when available, with a `chrome` fallback)
- `options.*`: Ollama/model settings
- `popup.*`: episode status + precompute control

## Next improvements

- Detect and select among multiple captured Netflix subtitle tracks/languages.
- Add subtitle context windows to improve pronoun/name translation.
- Store caches in IndexedDB with per-show metadata and LRU cleanup.
- Precompute starting near the current playback position before translating the rest.
- Add export/import for translated VTT/SRT.
- Add Firefox packaging.
- Add a side panel showing the episode transcript and translation progress.
- Add model-specific translation prompt presets.

## v0.4.4 subtitle customization, buffering, and cache management

Settings now includes a live preview and controls for:

- subtitle height from the bottom of the video
- left, center, or right alignment
- maximum line width
- separate original and translated font sizes
- subtitle background strength
- an optional in-player controls overlay for live adjustments
- independent switches to hide Netflix subtitles, show LST's original text, and show the translation
- optional top-left informational messages for capture, fallback, precompute, and errors

Saved appearance changes are pushed to open Netflix tabs immediately. The optional in-player controls overlay saves adjustments as you make them and shares the top-right area with the debug panel without covering it. Settings can also pull an Ollama model by name and show its download progress. The detailed debug panel is off by default for new installs.

The Translated episodes section in Settings lists each locally cached episode/model/language combination, its translated cue count, estimated storage use, and last update time. Individual caches or the entire local translation library can be removed there. Older caches remain readable and are labeled with their Netflix video ID until they are updated with richer episode metadata.

When look-ahead is enabled, LST prepares every subtitle within the configured time window and the first cue after that boundary. The window cannot be set below 30 seconds. Optional top-left notices report when the buffer is being prepared, when it is ready, or when an upcoming cue could not be translated.


## v0.2 progress / reliability changes

- Precompute is now detached from the extension popup. Closing the popup does **not** stop the job.
- Popup shows:
  - exact cached cue count
  - percentage
  - current batch / total batches
  - current subtitle text being processed
  - elapsed time
  - failed cue count
  - last translation / last error
- Ollama requests now have a configurable timeout (default 75 seconds).
- Failed batches are recursively split. A single bad cue is recorded and skipped instead of freezing the whole episode.
- LST requests `think: false` from Ollama for lower subtitle latency.
- The visible Netflix subtitle DOM remains an active fallback even after a full timed-text track has been captured. This fixes cases where a captured track translates successfully but its timestamps do not line up with the current Netflix playback track.
- A Stop button stops precompute after the currently-running Ollama request completes.

### If progress repeatedly stalls on a batch

Try a smaller **Precompute batch size** such as `8` or `4`, especially with smaller/translation-focused local models. The default request timeout is `75` seconds and can be changed in Settings.


## v0.3.0 diagnostics and Qwen ID recovery

v0.3.0 addresses the confusing error:

```text
Expected 1 translations, received 1
```

That could happen when a model returned the correct number of translations but rewrote LST's opaque subtitle cue IDs. LST now:

1. uses exact returned IDs when they match;
2. recovers positionally when the number/order of translations is correct;
3. falls back to a plain single-subtitle translation request if structured output still fails.

### Pinned debug panel

Settings now includes:

- **Show detailed LST debug panel on Netflix**
- **Keep debug panel pinned in the top-right corner**

The panel displays model, cache progress, precompute batch, request time, translated/failed count, structured-vs-fallback mode, playback mode, video/cue timing, in-flight request count, timed-text source, current subtitle, last translation, returned IDs, raw Ollama response, and the latest error.

The panel is a separate `position: fixed` element with page-level maximum z-index so Netflix subtitle-container transforms do not move it.
