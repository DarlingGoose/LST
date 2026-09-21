# Site adapters

All streaming-service-specific behavior belongs under `src/sites/`. Player,
background, and page-world code consume `globalThis.LSTPlaybackSite`; they must
not branch on a hostname or service-specific selector themselves.

## Adapter contract

An adapter is registered with `LSTPlaybackSite.registerSite(adapter)`. The
registry validates its id, label, host patterns, timed-text declaration, and the
required functions before exposing it to consumers.

Required behavior includes:

- playback-page recognition
- player presence and active-video selection
- episode/video id extraction
- rendered subtitle reading
- title element and document-title handling
- native caption selectors
- timed-text URL and content-type shapes
- playback-resource parsing when the service provides a listing

Answers should carry reason codes. Unknown pages, missing markup, and unreadable
documents must be reported instead of guessed.

## Adding a service

1. Add its adapter under `src/sites/` and register it before page/background
   consumers load.
2. Add only its narrow host patterns to both `content_scripts.matches` arrays in
   `src/manifest.json`.
3. Add required host permission only when the extension itself contacts that
   host. Prefer optional permission for user-initiated access.
4. Add adapter fixtures and table cases to `tests/test-playback-site.mjs`.
5. Add page-hook and player integration cases for its capture strategy.
6. Document unsupported subtitle forms or platform limitations.
7. Run `npm run check` and package both browsers.

The manifest change remains explicit because admitting a host is a security and
privacy decision. A new service should not require service branches in
`src/content/index.js`, `src/page/page-hook.js`, or `src/background/index.js`.
