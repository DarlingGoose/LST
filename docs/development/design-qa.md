# Design QA — toolbar popup

- Source visual truth: `/home/n9s/.codex/generated_images/01a09434-307e-7f61-9620-8dda7b6d6c39/exec-b0258733-70af-4386-8047-0821c8939dee.png`
- Implementation screenshots: `/tmp/lst-popup-status-600.png`, `/tmp/lst-popup-controls-600.png`
- Combined comparison: `/tmp/lst-popup-comparison-600.png`
- Viewport: 390 × 600 CSS px, device scale factor 1
- Source pixels: 997 × 1579, normalized and centered in a 390 × 600 comparison frame
- Implementation pixels: 390 × 600
- State: active Netflix episode, precompute working at 33%; Status and Controls tabs

## Full-view comparison evidence

The normalized source and Status implementation were placed side by side in `lst-popup-comparison-600.png`. The implementation preserves the selected concept's hierarchy: compact brand/status header, two-mode navigation, episode identity, translation progress, current activity, precompute actions, quick controls, and full-settings action. The implementation uses natural content height and compact section spacing so all persistent actions fit below the browser popup's 600 px cap without a scrollbar.

## Focused-region evidence

A separate focused crop was unnecessary because all typography, switches, progress values, and button labels are legible at the full 390 × 600 comparison size. The Controls screenshot separately verifies the hidden second tab and its layer, timing, model, and language controls, including clear space below the full-settings action.

## Required fidelity surfaces

- Fonts and typography: Passed. System UI typography matches the source's neutral product style, with comparable weights, hierarchy, line height, wrapping, and small-label treatment.
- Spacing and layout rhythm: Passed. The 390 px popup grid, 10–16 px outer spacing, lightweight panel borders, compact row rhythm, and radii follow the source. Both tab states fit within 600 px without a scrollbar, clipped footer, or compressed bottom edge.
- Colors and visual tokens: Passed. Background, raised surfaces, borders, white/muted text, red selected/primary state, green success, and amber working state align with the LST palette.
- Image quality and asset fidelity: Passed. The source contains no required raster imagery or non-standard icons. No placeholder imagery, handcrafted SVG, emoji, or fake icon glyphs were introduced.
- Copy and content: Passed. Source concepts map to real LST behavior. Real model/language values replace the mock's dashes, and the status copy uses existing precompute terminology.
- Accessibility and interaction: Passed. Tabs use tab semantics and keyboard switching, toggles use native checkboxes, controls have visible focus treatment, state is not conveyed by color alone, and buttons retain disabled states.

## Findings

No actionable P0, P1, or P2 differences remain.

The implementation intentionally removes decorative chevrons and uses complete clickable rows instead. It also combines model and target language into one compact summary row to satisfy the no-scroll requirement.

## Comparison history

1. Initial implementation: Status content exceeded the fixed popup height, and the Controls state hid its header and full-settings action below the viewport. Classified P2.
2. Fix: reduced vertical spacing, combined model/language summaries, arranged model/language fields side by side, set a fixed 600 px content height, and removed overflow scrolling.
3. Post-fix evidence: `/tmp/lst-popup-status.png` and `/tmp/lst-popup-controls.png` show both complete states with the full-settings action visible and no scrollbar.
4. User follow-up: the full-settings action was still visibly clipped at the real 390 × 600 browser viewport, and the Controls state could open with the header shifted above the viewport. Classified P1.
5. Fix: removed the forced body height, tightened only inter-section spacing, added footer breathing room, prevented root scrolling, and replaced section `scrollIntoView` calls with focus that does not scroll the popup.
6. Post-fix evidence: `/tmp/lst-popup-status-600.png` and `/tmp/lst-popup-controls-600.png` show the complete header and full-settings action with comfortable bottom clearance in both states.

## Primary interactions checked

- Status and Controls tab states render correctly.
- Status view exposes translated-subtitle toggle and navigation to timing/model controls.
- Controls view exposes subtitle-layer switches, timing actions, model select, and target-language input.
- Precompute and Stop preserve existing enabled/disabled behavior in the rendered working state.
- No browser console errors were emitted during static preview capture.

## Implementation checklist

- [x] Preserve precompute polling and cancellation behavior.
- [x] Add current show and episode metadata to popup status.
- [x] Save quick subtitle, timing, model, and language changes through existing extension messaging.
- [x] Refresh open Netflix tabs after quick-setting changes.
- [x] Package the new stylesheet for Firefox and Chromium.
- [x] Verify both tab layouts at the browser's 390 × 600 popup limit without scrollbars or clipping.

## Follow-up polish

No blocking follow-up polish remains.

final result: passed
