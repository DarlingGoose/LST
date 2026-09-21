# Player Reliability and Architecture Refactor Plan

## Purpose

Stabilize LST's Netflix and Prime Video playback behavior before adding more
features, then refactor the player runtime so startup, capture, translation,
caching, and UI behavior have clear owners and can be tested independently.

The immediate failures this plan addresses are:

- The in-player control pill sometimes does not appear until the toolbar popup
  is opened.
- A persisted `showQuickPills: false` value follows the user across older tag
  builds, making version rollback look broken too.
- Netflix or Prime subtitle documents can arrive before the isolated content
  runtime is ready to receive them.
- Prime may not request the same signed subtitle resource again until the
  episode is closed and reopened.
- Playback can remain in `DOM realtime`, `DOM fallback`, or `Waiting` without
  explaining why full-track caching cannot begin.
- Cache-while-video-paused previously had silent refusal paths and could retry a
  no-progress provider response indefinitely.
- `content.js` owns too many unrelated responsibilities and mutable state
  variables, making lifecycle races hard to see and easy to reintroduce.

## Reliability invariants

Every implementation milestone must preserve these rules:

1. Subtitle capture starts independently of the HUD, toolbar popup, background
   worker, translation provider, and settings pages.
2. A captured document is acknowledged only after the isolated runtime has
   safely retained it.
3. The toolbar popup is read-only unless the viewer explicitly changes a
   setting or starts an action.
4. Opening the toolbar popup must never be required to initialize playback.
5. There is exactly one active player session per tab.
6. Async results from an old episode or session cannot mutate the current one.
7. The control pill's visibility is independent from its compact/expanded
   presentation and from subtitle-processing state.
8. Every refusal to cache carries a stable reason and a user-facing sentence.
9. DOM realtime remains usable when a full track cannot be captured, but never
   pretends that full-episode caching is available.
10. A track already in the target language never contacts a translation
    provider and never creates a translation cache.
11. No diagnostic record contains subtitle text, signed subtitle URLs, account
    data, cookies, credentials, or provider keys.
12. Firefox and Chromium packages must load shared modules in the same required
    order.

## Current evidence

### Persistent player-control visibility

`showQuickPills` is stored in extension-local storage and has existed in older
versions. Checking out an older tag does not reset browser storage. The player
stylesheet initially declares the pill as hidden, and JavaScript shows it only
after applying effective settings. A stored `false` can therefore make current
and historical builds appear to share the same startup regression.

### Lost early capture

The page-world network hook and isolated content runtime start independently.
A one-shot `window.postMessage` can be sent before the isolated listener exists.
This is especially damaging on Prime because playback-resource URLs are signed,
deduplicated, and may not be requested again during the same player session.

### Paused caching and DOM mode

Paused caching requires a captured cue array. DOM-only playback has no complete
cue array, so it cannot precompute the rest of the episode. Previously this was
a silent early return, leaving the UI on a generic realtime or fallback label.

### Structural risk

`content.js` currently combines session lifecycle, capture adoption, subtitle
synchronization, translation scheduling, cache coverage, rendering, transcript,
HUD controls, settings, imports, and diagnostics. Its string-valued
`playbackMode` is used as both program state and user-facing text. This makes
orthogonal states difficult to represent and encourages scattered conditionals.

## Target architecture

The project remains plain JavaScript with no remote code and no mandatory build
framework. Modules expose frozen APIs through `globalThis`, following the
existing repository style.

### `settings-schema.js`

Owns:

- Defaults and setting types.
- Schema version.
- Renamed-key migrations.
- Global versus per-show setting names.
- Validation and normalization.
- Effective-setting resolution with source metadata.

No other file should define a second full defaults table.

### `capture-protocol.js`

Owns:

- Page/isolated channel names.
- Protocol version.
- Message and acknowledgement shapes.
- Event IDs.
- Queue count and byte limits.
- Payload validation.

### `capture-bridge.js`

Loaded first in the isolated world. It queues early page-world events, performs
the ready/replay/ack handshake, deduplicates event IDs, and hands retained
events to the player runtime.

### `player-session.js`

The only owner of player startup and teardown. Explicit states:

```text
inactive
waiting-for-player
starting
active
switching-episode
stopping
failed
```

It serializes route checks, assigns session generations, cancels stale work,
and emits structured transitions.

### `track-controller.js`

Owns captured/imported track adoption, episode ownership, language decisions,
replacement/union rules, synchronization state, and DOM fallback selection.

```text
track: none | captured | imported
sync: unavailable | unverified | verified | mismatch
translationNeed: unknown | required | unnecessary
```

### `cache-scheduler.js`

Owns realtime translation, look-ahead, pause-time caching, precompute priority,
deduplication, cancellation, retry limits, and no-progress detection.

It exposes a pure eligibility decision with stable reasons rather than silent
returns.

### `subtitle-renderer.js`

Owns subtitle overlay DOM, stack retention, appearance, and native-caption
visibility. It receives state and renders; it does not initiate translation.

### `player-hud.js`

Owns pill/menu DOM and compact/expanded interaction. It renders a snapshot and
never decides track, capture, or caching behavior.

Visibility and operational state remain separate:

```text
visibility: disabled | hidden-by-user | expanded | compact
operation: waiting | dom-realtime | track-ready | caching | cached |
           same-language | translation-paused | error
```

### Background modules

Split `background.js` into:

- `settings-store.js`
- `cache-store.js`
- `provider-service.js`
- `import-service.js`
- `diagnostic-store.js`
- `background-router.js`

Keep `background.js` as the small Firefox/Chromium entry point.

## Milestones

### Milestone 0 — Baseline and reproduction

- Preserve the current working tree without destructive reset.
- Test a clean browser profile and a copy of the affected profile.
- Record effective settings before playback.
- Build tagged versions into separate generated directories rather than sharing
  one loaded extension directory.
- Run the same Netflix and Prime startup matrix against each profile/build.
- Capture privacy-safe lifecycle transitions for a failing and successful run.

Exit condition: each reported failure has a reproducible sequence or is clearly
classified as persistent-profile state.

### Milestone 1 — Recovery and explicit policy

- Provide toolbar recovery when player controls are persistently hidden.
- Make paused-cache eligibility a pure shared policy.
- Display a reason whenever pause-time caching cannot run.
- Stop no-progress paused-cache loops.
- Cover DOM-only, full-track, translation-paused, and malformed-provider cases.

Exit condition: the viewer can restore controls without the player controls,
and pause-time caching never silently refuses or spins indefinitely.

### Milestone 2 — Settings schema

- Introduce `settings-schema.js` and schema migrations.
- Remove duplicate defaults and legacy-key logic from callers.
- Resolve global defaults and per-show overrides in one place.
- Show effective value and source in diagnostics.
- Add a reset-interface action that does not touch caches or imported files.
- Add migration fixtures for settings written by historical releases.

Exit condition: clean and migrated profiles produce the same effective settings
unless the viewer intentionally chose otherwise.

### Milestone 3 — Serialized player session

- Implement `player-session.js`.
- Replace overlapping async interval calls with a serialized route check.
- Move all start/stop/episode-transition mutations behind session events.
- Give every async task a session and episode generation.
- Cancel timers, observers, and requests at one teardown boundary.

Exit condition: one tab cannot have two concurrent startup or teardown paths,
and stale work is ignored deterministically.

### Milestone 4 — Durable capture protocol

- Formalize the bridge protocol in a pure module.
- Bound retained events by count and total bytes.
- Associate Prime documents with listing identity.
- Replay unacknowledged events after receiver restart.
- Reject wrong-service and wrong-episode captures with reasons.
- Remove time as the primary ownership heuristic.

Exit condition: Netflix and Prime captures arriving before content startup are
adopted exactly once without reopening the episode.

### Milestone 5 — Track controller

- Extract track adoption and synchronization from `content.js`.
- Replace string inspection of `playbackMode` with structured state.
- Preserve imported-track precedence and same-language behavior.
- Keep DOM fallback independent from full-track capture.
- Cover seeking, repeated lines, gaps, subtitle switching, and episode changes.

Exit condition: every track transition is represented by one state transition
with a reason.

### Milestone 6 — Cache scheduler

- Extract scheduling and priorities.
- Make realtime, look-ahead, paused caching, and precompute share one queue.
- Prevent duplicate cue work.
- Define retry/no-progress policy.
- Surface scheduler state and blocker reasons.
- Ensure episode/model/language changes cancel owned work.

Exit condition: pause-time caching starts whenever eligible and explains every
ineligible state.

### Milestone 7 — UI extraction

- Extract subtitle rendering, HUD, and transcript modules.
- Render from state snapshots.
- Remove permanent hide actions from the player surface.
- Keep compact controls visibly clickable.
- Ensure warnings/errors survive compact mode.

Exit condition: UI interaction cannot change capture or scheduler state except
through explicit controller actions.

### Milestone 8 — Background decomposition

- Extract storage, provider, import, and diagnostics services.
- Validate message requests and responses.
- Add bounded timeouts and structured errors.
- Preserve Firefox and Chromium background preparation.

Exit condition: the background entry point only initializes modules and routes
messages.

### Milestone 9 — End-to-end reliability suite

- Add a combined page-world/isolated-world harness.
- Add a local fake Netflix/Prime player for controlled fetch/XHR ordering.
- Add persistent-profile migration tests.
- Add generated Firefox and Chromium package smoke tests.
- Run the real-service acceptance matrix before release.

Exit condition: all acceptance scenarios below pass without opening the toolbar
popup as an initialization step.

## Acceptance matrix

Run on Firefox and Chromium for Netflix and Prime Video:

1. Open an episode directly.
2. Start an episode from its detail page.
3. Let the subtitle response arrive before the player UI.
4. Let the player UI arrive before the subtitle response.
5. Pause before full-track capture.
6. Pause after full-track capture.
7. Seek forward and backward.
8. Turn service subtitles off and back on.
9. Select subtitles already in the target language.
10. Advance automatically to the next episode.
11. Change episodes without a URL change on Prime.
12. Remove and recreate the video/player element.
13. Suspend the background worker before playback.
14. Never open the toolbar popup.
15. Open the toolbar popup and verify it causes no initialization transition.
16. Persistently hide controls, reload, then restore them from the popup.
17. Run with provider success, explicit failure, timeout, malformed response,
    and no-progress response.

## Required troubleshooting snapshot

Add a redacted report containing:

- Extension version and browser family.
- Site ID and adapter decision reason.
- Effective non-secret settings and their sources.
- Player-session state and last transitions.
- Capture queue/replay/ack counts.
- Track type, cue count, and synchronization state.
- Translation-need decision and reason.
- Cache scheduler state and eligibility reason.
- HUD visibility and compact state.

Never include subtitle text, raw provider output, signed URLs, cookies,
credentials, API keys, or account identifiers.

## Release strategy

- Complete milestones in order and keep each one independently testable.
- Remove superseded paths when replacements land; do not run legacy and new
  controllers in parallel.
- Run `npm run check` after every milestone.
- Build and inspect both target-specific manifests after manifest/module changes.
- Use a prerelease build with the real-service acceptance matrix before tagging.
- Do not call the stabilization complete based only on unit tests or one service.

