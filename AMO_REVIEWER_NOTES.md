# Notes for Mozilla Add-ons reviewers

LST translates Netflix subtitle text using an Ollama instance operated by the user.

## Test setup

1. Install Ollama from <https://ollama.com/>.
2. Start Ollama at `http://localhost:11434`.
3. Configure `OLLAMA_ORIGINS` to allow the Firefox extension origin.
4. Install a translation-capable model, for example with `ollama pull qwen3:8b`, or use the model download field in LST Settings.
5. Open a Netflix watch page using a test account and enable a subtitle track.
6. Open LST Settings, refresh the model list, select the installed model, and save.

Netflix requires an account and may not expose the same timed-text format for every title or region. If a full timed-text track is unavailable, LST falls back to observing Netflix's currently rendered subtitle text.

## Implementation details

- `page-hook.js` runs in the page's main world to observe Netflix `fetch` and `XMLHttpRequest` responses that contain TTML or WebVTT timed text.
- `content.js` parses and displays subtitle cues and sends translation requests to `background.js`.
- `background.js` sends subtitle text only to the Ollama endpoint configured by the user. The default and declared host is `http://localhost:11434`.
- `storage` and `unlimitedStorage` hold user settings and episode translation caches locally.
- The extension contains no telemetry, analytics, advertising, tracking, remote executable code, or developer-operated backend.
- The extension is readable vanilla JavaScript, HTML, and CSS. It has no bundling, transpilation, minification, generated application code, or runtime third-party libraries.

The `websiteContent` data transmission declaration covers subtitle text sent to the user-operated Ollama endpoint. See `PRIVACY.md` for the user-facing policy.
