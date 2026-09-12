# AGENTS.md

Guidance for AI coding agents and automated contributors working on **LST — Local Subtitle Translate**.

## Project overview

LST is a privacy-first browser extension that translates Netflix subtitles locally using Ollama.

Core goals:

- Keep subtitle translation local by default.
- Support Firefox and Chromium from the same source tree.
- Translate subtitles in realtime or precompute/cache an episode.
- Keep the UI lightweight and unobtrusive.
- Avoid telemetry, tracking, advertising, and developer-operated backends.
- Avoid remote executable code.

The project is intentionally small and uses plain JavaScript, HTML, and CSS.

## Repository structure

Important files:

- `manifest.json`
  - Shared source manifest for Firefox and Chromium.
  - Contains both Firefox and Chromium-specific fields.
  - Do not remove browser-specific fields from the shared source unless the release pipeline is updated accordingly.

- `background.js`
  - Ollama API communication.
  - Model discovery.
  - Translation requests.
  - Cache/storage coordination.

- `content.js`
  - Netflix subtitle parsing and playback synchronization.
  - Subtitle overlay rendering.
  - Realtime translation behavior.
  - Look-ahead buffering.
  - Precompute behavior.
  - In-player controls and diagnostics.

- `page-hook.js`
  - Runs in the page context.
  - Observes Netflix fetch/XHR traffic for subtitle/timed-text responses.
  - Keep this file minimal because it runs alongside Netflix page code.

- `options.html` / `options.js`
  - Extension settings UI.

- `popup.html` / `popup.js`
  - Toolbar popup and current episode/precompute status.

- `styles.css`
  - Netflix overlay, subtitle, HUD, and debug styling.

- `icons/`
  - Extension icons.

- `scripts/prepare-firefox.mjs`
  - Generates `.firefox-build`.
  - Removes Chromium-only manifest fields before AMO packaging.

- `scripts/prepare-chrome.mjs`
  - Generates `.chrome-build` when present.
  - Removes Firefox-only manifest fields before Chrome Web Store packaging.

- `.github/workflows/`
  - CI and browser-store release workflows.

## Development commands

Install dependencies:

```bash
npm ci
```

Run the full project checks:

```bash
npm run check
```

At minimum, run syntax checks after JavaScript changes:

```bash
npm run check:syntax
```

Build the Firefox package:

```bash
npm run package
```

If Chrome packaging scripts are present:

```bash
npm run package:chrome
```

Do not manually edit generated build directories such as:

```text
.firefox-build/
.chrome-build/
web-ext-artifacts/
```

Change source files or preparation scripts instead.

## Browser compatibility

LST supports both Firefox and Chromium.

The shared `manifest.json` intentionally contains browser-specific fields.

Firefox uses:

```json
"background": {
  "scripts": ["background.js"]
}
```

Chromium uses:

```json
"background": {
  "service_worker": "background.js"
}
```

Release preparation scripts strip the fields not supported by the target browser.

When changing the manifest, permissions, background configuration, content scripts, or extension APIs:

1. Check Firefox behavior.
2. Check Chromium behavior.
3. Check the generated target-specific manifest.
4. Run the relevant packaging command.

Prefer:

```js
const ext = globalThis.browser || globalThis.chrome;
```

when code must run on both browser families.

## Privacy and security requirements

Privacy is part of LST's core product behavior.

Do not add any of the following without explicit maintainer approval:

- telemetry
- analytics
- tracking
- advertising
- developer-operated API servers
- cloud translation by default
- remote JavaScript
- remote WebAssembly
- `eval()` or equivalent execution of network-provided strings
- unnecessary browser permissions
- unnecessary host permissions

Subtitle text may be sent to the user-configured translation endpoint. The default is the user's local Ollama server:

```text
http://localhost:11434
```

Treat Ollama responses strictly as data.

Do not log:

- Netflix cookies
- authentication tokens
- account identifiers
- API keys
- sensitive browser storage values

If new network access is required, explain why it is necessary for LST's subtitle-translation purpose.

## Permissions

Current permissions should remain as narrow as practical.

Host permissions are expected to cover:

- Netflix playback pages.
- User-local Ollama endpoints.

Do not add broad patterns such as:

```text
<all_urls>
https://*/*
http://*/*
```

unless there is a strong, reviewed reason.

If adding support for another streaming service, prefer adding only that service's specific host patterns.

## Netflix integration

Netflix is a private web application and can change without notice.

Prefer robust behavior over depending on one DOM selector.

Current strategy should remain layered:

1. Capture full TTML/WebVTT timed-text responses where possible.
2. Parse and synchronize cues against video playback time.
3. Fall back to observing the subtitle text Netflix visibly renders.
4. Keep realtime translation usable even when full-track capture fails.

Do not make full-track capture a hard requirement for basic translation.

When changing subtitle parsing or playback synchronization, test:

- normal playback
- pause/resume
- seeking forward
- seeking backward
- subtitle gaps
- episode changes
- switching subtitle tracks when possible

## Translation behavior

Translations are performed through Ollama.

LST may translate:

- a currently visible cue
- a look-ahead window
- a batch during episode precompute

Translation code should be resilient to model output inconsistencies.

Do not assume every model perfectly follows structured-output instructions.

When possible:

- validate returned data
- preserve input order
- recover positionally when safe
- fall back to smaller batches
- fall back to single-cue translation
- surface useful diagnostics instead of silently failing

Avoid prompts that encourage lengthy reasoning for realtime translation.

Latency matters during playback.

## Caching

Translations can be cached locally per episode/model/language combination.

When changing cache structure:

- preserve existing caches when practical
- consider migration/backward compatibility
- avoid silently deleting user data
- keep storage usage visible to the user
- ensure users can clear individual caches or all cached translations

Do not store data remotely.

## UI guidelines

LST should feel lightweight and stay out of the way of playback.

Prefer:

- compact controls
- clear status states
- readable subtitles
- high contrast
- minimal overlays
- settings that update without unnecessary page reloads

Avoid:

- covering Netflix playback controls
- large persistent dialogs
- excessive notifications
- debug UI enabled by default for normal users

Debug output should be optional and useful for troubleshooting.

## Subtitle visibility

LST supports combinations of:

- Netflix subtitles
- LST original subtitle text
- LST translated subtitle text

Keep these controls independent.

Do not disable Netflix's subtitle track at the player level merely to hide it visually, because LST may still need Netflix to load the source subtitle data.

Prefer visual hiding of Netflix subtitles while leaving the source track active.

## Testing expectations

For changes affecting translation or playback behavior, test the relevant paths:

- realtime translation
- look-ahead translation
- full-episode precompute
- cached playback
- subtitle synchronization
- timing offset controls
- subtitle styling
- hiding/showing subtitle layers
- seeking
- model switching
- settings persistence

For Ollama-related changes, test at least one lightweight translation model when possible.

Current commonly tested models include:

```text
translategemma:4b
qwen3.5
```

Do not hard-code the available model list. LST should discover models from Ollama dynamically.

## Pull request scope

Keep pull requests focused.

Avoid combining:

- unrelated refactors
- cosmetic formatting changes
- feature additions
- release workflow rewrites

unless they are directly connected.

For visible UI changes, include screenshots or recordings when practical.

For behavior changes, describe:

- what changed
- why
- how it was tested
- any browser-specific impact
- any new permissions or network access

## Release/versioning

The extension version should stay consistent across release metadata.

When preparing a release, ensure the tag matches the manifest/package version.

Example:

```text
manifest.json: 0.5.3
package.json:  0.5.3
git tag:       v0.5.3
```

Do not modify release workflows casually. Store publishing credentials, IDs, and secrets must remain outside the repository.

Never commit:

- AMO secrets
- Chrome Web Store service-account JSON
- API tokens
- signing keys
- authentication backups

## Documentation

If behavior changes in a way users need to know about, update the relevant documentation.

Useful places include:

- `README.md`
- `PRIVACY.md`
- `CONTRIBUTING.md`
- release notes

Keep documentation consistent with actual behavior.

## Contribution philosophy

LST started as a practical tool for watching content in Japan where English subtitles are often unavailable.

Prefer changes that make the extension:

- easier to use
- more reliable
- more private
- faster
- more compatible with local models
- more useful across languages and media platforms

If a proposed change makes LST substantially more complex, increases permissions, or weakens privacy for a marginal benefit, stop and discuss it before implementing.
