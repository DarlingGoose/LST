# Notes for Mozilla Add-ons reviewers

LST translates Netflix subtitle text using an Ollama instance operated by the user by default. DeepSeek and Gemini are optional providers selected in Settings.

## Test setup

1. Install Ollama from <https://ollama.com/>.
2. Start Ollama at `http://localhost:11434`.
3. Configure `OLLAMA_ORIGINS` to allow the Firefox extension origin.
4. Install the default model with `ollama pull translategemma:4b`, or use the model download field in LST Settings.
5. Open a Netflix watch page using a test account and enable a subtitle track.
6. Open LST Settings, refresh the model list, select the installed model, and save.

Netflix requires an account and may not expose the same timed-text format for every title or region. If a full timed-text track is unavailable, LST falls back to observing Netflix's currently rendered subtitle text.

## Implementation details

- `page-hook.js` runs in the page's main world to observe Netflix `fetch` and `XMLHttpRequest` responses that contain TTML or WebVTT timed text.
- `content.js` parses and displays subtitle cues and sends translation requests to `background.js`.
- `background.js` sends subtitle text to the selected provider: the user-configured Ollama endpoint, `https://api.deepseek.com`, or `https://generativelanguage.googleapis.com`. The default is local Ollama at `http://localhost:11434`; remote providers require the user to add an API key and select them.
- The two remote host permissions are limited to these provider API hosts. No provider SDK or remote code is loaded.
- `storage` and `unlimitedStorage` hold user settings and episode translation caches locally.
- The extension contains no telemetry, analytics, advertising, tracking, remote executable code, or developer-operated backend.
- The extension is readable vanilla JavaScript, HTML, and CSS. It has no bundling, transpilation, minification, generated application code, or runtime third-party libraries.

The `websiteContent` data transmission declaration covers subtitle text sent to the selected provider. See `PRIVACY.md` for the user-facing policy.
