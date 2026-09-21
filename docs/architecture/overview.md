# Architecture overview

LST is a Manifest V3 browser extension built from plain JavaScript, HTML, and
CSS. Source lives under `src/`; browser preparation copies that tree into
`.firefox-build` or `.chrome-build` and adjusts only the browser-specific
manifest fields.

## Runtime areas

- `src/background/` owns provider requests, storage, caches, and runtime message
  handling.
- `src/content/` owns the isolated-world player session, subtitle overlay, and
  translation scheduling. Its state-free timed-text parser and playback
  lifecycle state machine load before the orchestration entry point.
- `src/page/` owns the small main-world bridge that observes player network
  traffic.
- `src/sites/` owns every streaming-service-specific fact.
- `src/shared/` owns policies and pure helpers used in more than one runtime.
- `src/ui/` owns extension pages.

The extension intentionally has no bundler. Classic scripts publish small
namespaces on `globalThis`, and the manifest or page HTML specifies their load
order. This is why moving a shared module requires updating manifest, worker,
page, test, and packaging contracts together.

## Repository areas

- `tests/` contains behavior tests and drift guards.
- `scripts/` contains build, release, syntax, and package verification tooling.
- `docs/` contains architecture, plans, research, and release instructions.

Generated browser directories and release archives are outputs. Change `src/`
or the preparation scripts instead of editing generated files.
