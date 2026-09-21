# Repository and runtime modularization

Status: active

## Goal

Organize extension source under `src/`, documentation under `docs/`, tests under
`tests/`, and tooling under `scripts/`; establish a validated site-adapter
boundary; then reduce the large player and background entry points without
changing behavior, permissions, cache formats, or privacy guarantees.

## Completed foundation

- [x] Consolidate plans, research, release notes, and development notes under
  `docs/`.
- [x] Move extension-owned files under `src/` by runtime responsibility.
- [x] Move test programs out of `scripts/` and into `tests/`.
- [x] Copy the `src/` tree into target build directories while keeping the
  packaged manifest at archive root.
- [x] Discover extension JavaScript for syntax checks instead of maintaining a
  filename chain in `package.json`.
- [x] Validate site adapter registration and manifest/adapter host drift.
- [x] Document execution contexts and the service-adapter contract.
- [x] Extract state-free TTML/WebVTT document parsing from the content runtime.
- [x] Extract playback activity, async generation counters, and bounded session
  transition history into a tested lifecycle state module.
- [x] Extract the captured-track handoff slot and its stale/ownership/adoption
  decisions into a tested lifecycle state module.
- [x] Extract timed-track verification, mismatch, anchoring, and subtitle-gap
  state into a tested lifecycle module.

## Remaining runtime extraction

- [x] Move built-in Netflix and Prime Video adapter definitions into separate
  files registered through the common site registry.
- [ ] Introduce an explicit player-session object for mutable content state.
- [ ] Extract content translation, imported track, rendering, controls, and
  diagnostics one area at a time.
- [ ] Extract background providers, cache repository, import service,
  diagnostics, and message routing.
- [ ] Split the options page by card/responsibility and share page utilities
  only where two pages use them.

## Rules

- Keep structural moves separate from behavior changes.
- Preserve reason codes and privacy-safe diagnostics.
- Do not broaden host permissions as a convenience.
- Do not introduce a framework, TypeScript, or a bundler in this refactor.
- Run the full test suite after each extraction and package both browsers after
  manifest or preparation changes.

## Definition of done

- Repository root contains project metadata rather than runtime implementation.
- Adding a service is localized to an adapter, narrow manifest declarations,
  fixtures, and documentation.
- No consumer outside `src/sites/` tests a service hostname or selector.
- Content and background entry points mainly assemble smaller modules.
- Firefox and Chromium packages pass verification from the same `src/` tree.
