# Extension execution contexts

LST runs in four environments with different capabilities.

## Background worker

`src/background/index.js` talks to translation providers and browser storage.
Firefox loads its dependencies through `background.scripts`; Chromium starts a
single service worker which imports the same dependencies.

## Isolated content world

`src/content/index.js` can use extension APIs and interact with the page DOM,
but it cannot directly replace the page's `fetch` or XHR implementations.
State-only helpers under `src/content/`, such as the session, captured-track,
and timed-track lifecycle modules, are loaded first and leave DOM and extension
API effects to the entry point.

## Page main world

`src/page/page-hook.js` observes requests made by the streaming player. It is
kept small and passes validated data to the isolated world through the capture
bridge.

## Extension pages

The popup, options, and setup pages live under `src/ui/`. They load shared
classic scripts explicitly before their page script.

Because content scripts are not loaded as ES modules by the manifest, converting
one area to `import` syntax does not solve dependency loading consistently for
all four contexts. Any future bundler or module migration should be a separate
architecture decision.
