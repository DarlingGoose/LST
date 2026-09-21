# Player Reliability and Refactor TODO

This checklist tracks implementation of
[`player-reliability-plan.md`](./player-reliability-plan.md).

Status legend:

- `[x]` implemented and covered by automated checks
- `[~]` started or partially implemented
- `[ ]` not started
- `[!]` requires real-browser or real-service verification

## Milestone 0 — Baseline and reproduction

- [ ] Preserve the current stabilization work as a reviewable snapshot.
- [ ] Identify the last release confirmed reliable by the maintainer.
- [ ] Create isolated clean and migrated browser profiles.
- [ ] Record effective settings from the affected profile.
- [ ] Confirm whether `showQuickPills` is persistently `false`.
- [ ] Run the Netflix startup matrix without opening the popup.
- [ ] Run the Prime Video startup matrix without opening the popup.
- [ ] Compare clean-profile and migrated-profile behavior.
- [ ] Compare current and known-good builds using separate extension directories.
- [!] Capture a failing real Netflix lifecycle trace.
- [!] Capture a failing real Prime Video lifecycle trace.

## Milestone 1 — Recovery and explicit playback policy

- [x] Add a pure paused-cache eligibility policy.
- [x] Give disabled pause-time caching a stable reason.
- [x] Explain that DOM realtime cannot build a full episode cache.
- [x] Explain that explicit translation pause also pauses background caching.
- [x] Explain missing-model, same-language, precompute, and complete-cache states.
- [x] Stop paused caching when a provider returns no translations or failures.
- [x] Add a popup action to restore persistently hidden player controls.
- [x] Include paused-cache blockers in player/popup status.
- [x] Add policy unit tests.
- [x] Add DOM-only paused-playback integration coverage.
- [x] Add captured-track paused-playback integration coverage.
- [x] Add translation-paused integration coverage.
- [x] Add no-progress provider regression coverage.
- [!] Verify the restore action in Firefox with the affected profile.
- [!] Verify the restore action in Chromium with the affected profile.
- [!] Verify real Prime paused caching after full-track capture.
- [!] Verify real Netflix paused caching after full-track capture.

## Capture bridge stabilization already in progress

- [x] Add an isolated receiver before `content.js`.
- [x] Add ready/replay/ack event IDs.
- [x] Retain early Netflix and Prime documents until acknowledgement.
- [x] Add early-capture replay tests for Netflix.
- [x] Add early-capture replay tests for Prime Video.
- [x] Package the bridge before `content.js` on Firefox and Chromium.
- [~] Replace the temporary event-count bound with count and byte limits.
- [~] Replace capture age as the primary ownership rule with episode identity.
- [ ] Extract protocol constants and validation into `capture-protocol.js`.
- [ ] Add protocol-version negotiation.
- [ ] Add receiver-restart replay coverage.
- [ ] Add wrong-episode replay rejection coverage.
- [!] Verify capture-before-player startup on real Netflix.
- [!] Verify capture-before-player startup on real Prime Video.

## Milestone 2 — Settings schema and migration

- [x] Create `settings-schema.js`.
- [x] Move every setting default into the schema.
- [x] Add `settingsSchemaVersion`.
- [x] Move renamed-key migration into the schema.
- [x] Define global setting names.
- [x] Define per-show override names.
- [x] Add type/range normalization.
- [x] Return effective values with `default`, `global`, or `show` source.
- [x] Remove duplicate defaults from `background.js`.
- [x] Remove duplicate defaults from `content.js`.
- [x] Remove duplicate migration logic from options/setup/popup pages.
- [x] Add a reset-interface action that preserves caches and imported tracks.
- [x] Show when player controls are hidden globally.
- [x] Show when a per-show override changes an effective setting.
- [x] Add historical settings fixtures for v0.5.x.
- [x] Add historical settings fixtures for v0.6.x.
- [x] Test undefined `showQuickPills` defaults to on.
- [x] Test explicit `showQuickPills: false` remains recoverable.

## Milestone 3 — Serialized player session

- [ ] Create `player-session.js` with explicit states.
- [ ] Make route checks non-overlapping.
- [ ] Replace `playbackActive` with session state.
- [ ] Consolidate player-presence grace handling.
- [ ] Own all timers and observers in the session.
- [ ] Cancel owned work at one teardown boundary.
- [ ] Attach a session generation to async work.
- [ ] Attach an episode generation to episode-owned work.
- [ ] Ignore stale async results centrally.
- [ ] Add player mount/unmount/remount tests.
- [ ] Add rapid SPA navigation tests.
- [ ] Add next-episode-without-URL-change tests.
- [ ] Add background-worker-suspended startup tests.

## Milestone 4 — Durable capture protocol

- [ ] Create `capture-protocol.js`.
- [ ] Validate incoming page-world payloads.
- [ ] Bound retained capture count.
- [ ] Bound retained subtitle bytes.
- [ ] Preserve identity-before-document ordering.
- [ ] Associate Prime documents with listing identity.
- [ ] Associate Netflix documents with route episode identity when available.
- [ ] Acknowledge only after isolated retention.
- [ ] Deduplicate live and replayed events.
- [ ] Reject wrong-service documents.
- [ ] Reject proven wrong-episode documents.
- [ ] Retain valid pre-player captures without a short arbitrary timeout.
- [ ] Record privacy-safe buffered/replayed/acknowledged transitions.

## Milestone 5 — Track controller

- [ ] Create `track-controller.js`.
- [ ] Move captured-track adoption out of `content.js`.
- [ ] Move imported-track adoption out of `content.js`.
- [ ] Move track replacement/union decisions behind the controller.
- [ ] Move language/translation-need decisions behind the controller.
- [ ] Represent track type explicitly.
- [ ] Represent synchronization explicitly.
- [ ] Represent translation need explicitly.
- [ ] Remove program logic based on `playbackMode.includes(...)`.
- [ ] Preserve DOM fallback when no full track exists.
- [ ] Preserve imported-track precedence.
- [ ] Preserve same-language native-caption behavior.
- [ ] Cover seek, gap, repeated-line, and track-switch scenarios.

## Milestone 6 — Cache scheduler

- [ ] Create `cache-scheduler.js`.
- [ ] Move realtime cue requests into the scheduler.
- [ ] Move look-ahead into the scheduler.
- [ ] Move paused caching into the scheduler.
- [ ] Move precompute into the scheduler.
- [ ] Define task priorities.
- [ ] Deduplicate cue work across modes.
- [ ] Define retry limits.
- [ ] Define no-progress behavior.
- [ ] Cancel work on episode changes.
- [ ] Cancel work on model changes.
- [ ] Cancel work on target-language changes.
- [ ] Surface scheduler state and blocker reason.
- [ ] Decide and document whether translation pause stops all provider work.
- [ ] Add provider success/failure/timeout/malformed-response tests.

## Milestone 7 — Rendering and HUD extraction

- [ ] Create `subtitle-renderer.js`.
- [ ] Create `player-hud.js`.
- [ ] Create `transcript-view.js`.
- [ ] Render each from state snapshots.
- [ ] Separate HUD visibility from operational state.
- [ ] Separate compact state from persistent visibility.
- [ ] Remove permanent hide actions from inside the player.
- [ ] Ensure the compact pill always has a visible clickable target.
- [ ] Preserve warnings and errors under compact mode.
- [ ] Keep subtitle/native/transcript visibility independent.
- [ ] Add reduced-motion coverage.
- [ ] Add fullscreen host transition coverage.

## Milestone 8 — Background decomposition

- [ ] Create `settings-store.js`.
- [ ] Create `cache-store.js`.
- [ ] Create `provider-service.js`.
- [ ] Create `import-service.js`.
- [ ] Create `diagnostic-store.js`.
- [ ] Create `background-router.js`.
- [ ] Reduce `background.js` to initialization/import/routing.
- [ ] Validate message request fields.
- [ ] Validate response shapes.
- [ ] Add bounded request timeouts.
- [ ] Preserve provider credential privacy.
- [ ] Preserve Firefox background-script packaging.
- [ ] Preserve Chromium service-worker packaging.

## Milestone 9 — Diagnostics and end-to-end verification

- [x] Add a redacted troubleshooting snapshot.
- [ ] Include extension/browser/service versions.
- [x] Include effective non-secret setting sources.
- [x] Include player-session transitions.
- [x] Include capture counts and reasons without subtitle text.
- [x] Include track/sync/translation-need state.
- [x] Include cache eligibility and scheduler state.
- [x] Include HUD visibility/compact state.
- [ ] Build a combined page-world/isolated-world harness.
- [ ] Build a local fake Netflix player.
- [ ] Build a local fake Prime Video player.
- [ ] Add controlled fetch/XHR ordering.
- [ ] Add generated-package smoke tests.
- [ ] Run the complete Firefox acceptance matrix.
- [ ] Run the complete Chromium acceptance matrix.
- [!] Run real Netflix playback acceptance.
- [!] Run real Prime Video playback acceptance.

## Completion gate

- [ ] Pill appears on first playback when enabled.
- [ ] Hidden pill is recoverable from the toolbar popup.
- [ ] Popup opening causes no initialization side effect.
- [ ] Netflix initial subtitle capture is reliable.
- [ ] Prime initial subtitle capture is reliable.
- [ ] Episode transitions do not require reopening an episode.
- [ ] Video pause builds the cache when eligible.
- [ ] DOM-only mode clearly explains why it cannot build the full cache.
- [ ] Translation pause has explicit cache behavior.
- [ ] Same-language tracks make no provider requests.
- [ ] Clean and migrated profiles behave predictably.
- [ ] Firefox and Chromium packages pass all checks.
- [ ] Real-service acceptance passes before release tagging.
