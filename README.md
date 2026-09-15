# LST — Local Subtitle Translate

A small cross-browser Manifest V3 extension for Firefox and Chromium browsers that translates Netflix subtitles using local Ollama by default, with optional DeepSeek and Gemini providers.

[Privacy policy](PRIVACY.md) · [Browser release guide](FIREFOX_RELEASE.md)

## Features

- Local Ollama by default; DeepSeek and Gemini are opt-in
- Discovers installed Ollama models with `/api/tags`
- Downloads Ollama models by name from Settings
- Select model and target language in the browser
- Uses `translategemma:4b` as the default model for new and previously unconfigured installs
- Realtime subtitle translation
- Time-based look-ahead translation with an enforced 30-second minimum
- Dual subtitle overlay
- Custom subtitle height, alignment, line width, font sizes, and background strength
- Collapsible in-player subtitle editor that remembers its panel state
- Independent visibility controls for Netflix subtitles, LST original text, and LST translations
- Adjustable ±2-second subtitle timing offset in Settings and the in-player pill
- Captures Netflix TTML/WebVTT subtitle documents when available
- Precomputes an entire captured episode subtitle track
- Caches translations locally per Netflix watch ID + provider/model + target language
- Show-grouped translation history with timestamped preview, TSV export, size, and removal controls
- Separate Netflix show and episode names for newly cached or refreshed entries
- Structured JSON output from the selected provider to keep batch translations aligned

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
ollama pull translategemma:4b
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

## Optional DeepSeek and Gemini setup

Open **Settings → General**, select **DeepSeek** or **Gemini**, enter your provider API key, and click **Save key**. Refresh models, choose a model, then click **Save changes**. The key is stored in browser extension storage on your device and can be removed from the same screen. Selecting a remote provider sends requested subtitle cues, and surrounding cues if context is enabled, to that provider's API. Requests may use your quota or incur charges. Switching back to Ollama restores your saved local model selection; existing Ollama caches remain usable.

LST connects directly to `api.deepseek.com` or `generativelanguage.googleapis.com` only when that provider is selected. It has no developer-operated translation server. DeepSeek and Gemini model names are discovered from their APIs, so available models are not hard-coded.

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

The extension sends small batches of subtitle strings to the selected provider and requires a structured response shaped like:

```json
{
  "translations": [
    { "id": "cue-id", "text": "translated subtitle" }
  ]
}
```

If a model breaks the batch contract, the extension recursively splits the batch and retries smaller groups.

## Good model choices

For Japanese → English, `translategemma:4b` is the initial default and a good lightweight starting point. LST still discovers every installed Ollama model dynamically, so you can choose a larger or different model whenever you prefer.

## Development notes

There is no build step. Reload the unpacked extension after editing files.

Release packaging generates `.firefox-build` and `.chrome-build` from the shared Chromium/Firefox source manifest. Run `npm run package:all` to validate and build both store-ready archives. The preparation step removes fields unsupported by each target browser without changing unpacked development.

Useful files:

- `page-hook.js`: Netflix timed-text capture
- `content.js`: parser, sync, overlay, realtime/precompute behavior
- `background.js`: Ollama, DeepSeek, and Gemini clients + cache (uses the standard `browser` API when available, with a `chrome` fallback)
- `options.*`: provider/model settings
- `popup.*`: episode status + precompute control

## Next improvements

- Detect and select among multiple captured Netflix subtitle tracks/languages.
- Add subtitle context windows to improve pronoun/name translation.
- Store caches in IndexedDB with per-show metadata and LRU cleanup.
- Precompute starting near the current playback position before translating the rest.
- Add import and VTT/SRT export formats.
- Expand automated browser compatibility tests.
- Add a side panel showing the episode transcript and translation progress.
- Add model-specific translation prompt presets.

## v0.5.2 episode metadata

Cached translations record and display the Netflix show name and episode name separately. LST checks several player-title structures, recognizes episode markers such as `E50`, `Episode 50`, and `S1:E50`, and falls back to the current title's Netflix metadata page when the player hides its title UI. That fallback is a same-origin Netflix request and does not send subtitle text anywhere. Existing caches remain usable and gain richer names the next time their episode is revisited.

## Subtitle synchronization

LST checks that an asynchronously translated cue is still active before rendering it, preventing a slow response from replacing a newer subtitle. Cached translations are kept in the content-script session so a new cue can render synchronously, while Netflix's rendered-text fallback must remain stable briefly before it can replace the timed track. Captured cues and Netflix-rendered text are also compared with a unique formatting-tolerant match, and Netflix may retain the previous cue during the timed track's gap before the next cue without invalidating synchronization. This prevents punctuation or casing differences and normal cue handoffs from causing false mismatches or subtitle flashes. LST still clears lingering lines during real subtitle gaps after a short grace period.

The Subtitles tab provides a −2000 ms to +2000 ms timing offset in 50 ms steps. Negative values show LST subtitles earlier and positive values delay them. The persistent Netflix pill offers quick −100 ms, reset, and +100 ms adjustments.

## Navigation and in-player controls

Settings is organized into General, Subtitles, Storage, and Advanced tabs so model setup, appearance, cached episodes, and diagnostics no longer compete in one long page.

The Advanced tab also includes a bounded local subtitle event log. It records cue lifecycle, synchronization, cache, and translation events so brief subtitle clears can be diagnosed after playback. Mismatch events include DOM selector/node counts, anonymous page-session text IDs, text lengths, simplified/combined-line match results, nearby cue timing, offsets, rendered state, and resolution outcomes. The log stays in extension storage, omits subtitle text and complete request URLs, and can be filtered, copied, exported, or cleared independently from translation caches.

An optional in-player transcript sidebar shows the complete captured subtitle track with locally cached translations as they become available. The current cue is highlighted and automatically scrolled into view; the sidebar can be toggled from Subtitle settings, the extension popup, or the compact Netflix player controls. The popup also exposes whether the compact in-player controls are visible, with direct shortcuts beside All settings.

Surrounding subtitle context is also opt-in. When enabled, LST sends up to two nearby source cues before and after each new translation to the selected provider. These lines are marked as reference-only so the model can resolve names, pronouns, and sentence continuity without returning extra translations. Context can use more tokens and add latency, and enabling it does not replace translations that are already cached.

An optional persistent LST pill sits in a coordinated top-left HUD. It shows Waiting, Ready, Realtime, Buffering, Cached, Precomputing, or Error status and opens a compact menu for toggling the LST translation, LST original text, and Netflix subtitles. Informational notices stack below the pill rather than overlapping it.

## Subtitle customization, buffering, and cache management

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

When Netflix enters browser fullscreen, LST moves its subtitle overlay and optional player controls into the active fullscreen container. They return to the page root when fullscreen closes, preserving the same subtitle state and appearance in both modes.

The Translated episodes section in Settings groups locally cached episodes under their Netflix show, then lists each model/language combination with its translated cue count, estimated storage use, and last update time. Each episode can be previewed as timestamp, original text, and translated text, or exported as a UTF-8 TSV file. When a timed track becomes available, LST promotes uniquely matched DOM-fallback translations onto their timestamped cues and removes the redundant fallback records. Repeated or unmatched fallback text is preserved for playback recovery but omitted from previews and exports whenever timestamped cues exist. Individual caches or the entire local translation library can be removed there. Older caches remain readable and are migrated when their episode is revisited.

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
