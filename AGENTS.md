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

- `playback-site.js`
  - Decides which service a page belongs to — Netflix or Prime Video — and every
    site-specific fact about it: which paths can play, which `<video>` element
    the viewer is watching, how a subtitle line is rendered, where the title is
    shown, how the service words its own document title, which CSS hides its
    native captions, and which URL and content-type shapes carry timed text.
  - Pure: it takes a `location`, a `document`, and a `url` as arguments and
    returns records. No network, no storage, no timers. Loaded in the background,
    in the page-world hook, as a content script before `content.js`, and in the
    popup, options and setup pages.
  - **The adapter rule:** every new platform branch goes here, never scattered
    through `content.js` or `page-hook.js`. Adding a marketplace is one entry in
    an adapter's `matchPatterns` plus the same entry in both
    `content_scripts.matches` arrays; `scripts/test-playback-site.mjs` fails
    until both halves are done, and fails again if a `matches` pattern no adapter
    claims.

- `episode-identity.js`
  - Decides which names a service actually gave us and which are the
    placeholders it renders when it has nothing better, where an episode marker
    sits inside a title, what the title block embedded in a Netflix episode page
    says, and how a cache id is written and read back.
  - Loaded in the background, as a content script before `content.js`, and in the
    popup, options and setup pages, so all of them answer those questions the
    same way.
  - Owns the one placeholder vocabulary, the known video-id shapes (Netflix
    numeric ids, Prime Video ASINs and `amzn1.dv.gti.*`), the service namespace
    in cache ids, the show key (`encodeShowKey`, which names a show rather than an
    episode of it), and the name-merge rules; every decision carries the reason it
    was made, and the subtitle event log records kinds and reasons rather than
    the names themselves.

- `translation-context.js`
  - Decides which surrounding subtitle lines are sent to the provider as
    reference, and why, and validates the lines that arrive at the background in
    a message.
  - Loaded in the background, as a content script before `content.js`, and in the
    options page, which builds the amount control and its sentence from it.
  - Judged on the cue timeline rather than on cue indexes: a candidate is
    measured by the silence between it and the nearest requested line, so a
    silence longer than the declared gap (a scene break) ends the context.
  - Owns how much context a request carries, as one table of levels — Minimal,
    Standard, Wide — under `CONTEXT_LEVELS`, with `resolveBudget()` the only way
    a stored setting becomes a budget: an unknown value falls back to the default
    level rather than to no context, and anything shaped like a budget is clamped
    to `CONTEXT_LEVEL_CEILING` rather than trusted. `maxItems` is the sum of the
    three sides, never a number typed alongside them.
  - Renders every amount for the interface through `describeLimits()`,
    `describeLevelLabel()`, `describeLevelSummary()` and `contextLevelOptions()`,
    so the options page, the HUD and the README cannot describe a rule the module
    does not implement — and the options page builds its select from
    `contextLevelOptions()` rather than typing a level's numbers, which a test
    fails if it stops doing.
  - Every admission and every refusal carries a reason; a line with no position,
    a line with no timeline, or a request whose cues are not in the track is
    reported rather than guessed at. The event log records kinds, reasons and
    counts, never the subtitle text.

- `background.js`
  - Ollama API communication.
  - Model discovery.
  - Translation requests.
  - Cache/storage coordination.

- `translation-guard.js`
  - Decides whether a returned translation is plausibly written in the target language.
  - Loaded before `background.js` through the manifest's background scripts.

- `structured-response.js`
  - Recovers the batch JSON from a model response.
  - Aligns returned rows back to the requested cues, and reports anything it could not align instead of guessing.

- `subtitle-sync.js`
  - Decides which captured cue the line Netflix is rendering belongs to.
  - Folds encoding/layout differences, falls back to punctuation- and case-insensitive
    matching, and only uses playback time to separate repeated lines when the track
    timeline is already trusted.
  - Decides whether a newly captured timed-text document is the track in use, a part
    of it, or a different track, from cue membership and time coverage rather than
    cue-count or duration ratios, and always reports the reason.

- `subtitle-import.js`
  - Decides where a subtitle comes from when it did not come from the player:
    the two hosts an import uses, what a search result and a file listing say,
    which file belongs to which episode and why, what a SubRip file contains,
    what encoding its bytes are in, what language a file is in, and whether that
    language is the one the viewer asked for.
  - It also decides what the query is: a season or episode marker that the
    service put in the show's own name is trimmed — in Latin, Japanese or
    Chinese — because Jimaku files the entry under the bare name and a query
    that keeps the marker finds nothing. `queryFromShowName()` is the one owner
    of that, and both callers use it.
  - Pure: it takes strings and bytes and returns records. No network, no storage,
    no timers. Loaded in the background, as a content script before `content.js`,
    and in the popup and options pages.
  - **The host list has one owner.** `HOST_ORIGINS` is the only place that names
    `jimaku.cc` and `www.subtitlebot.com`; the manifest's
    `optional_host_permissions`, the options page's permission request, and
    `scripts/test-subtitle-import.mjs` all read it, and a test fails if the
    manifest and the module disagree or if either host becomes a required
    permission.
  - A file URL that leaves the origin the listing came from is refused
    (`file-url-off-origin`) rather than fetched, so a listing cannot send the
    extension somewhere it has no permission to go.
  - **One owner for text becoming a track.** `describeTextTrack()` answers "is
    this usable as an episode's track, and what will LST do with it" for a file
    fetched from Jimaku and for a file the viewer already had, so the two paths
    cannot decide the language, or whether to translate, differently. Every
    refusal carries a reason, the background turns each reason into one sentence,
    and a test fails if a reason ever arrives without a sentence.
  - **Files reach LST two ways.** Fetched from `jimaku.cc`, or read from the
    viewer's own disk by the options page's file picker. The second path makes no
    request, needs no host permission and no API key, and must stay that way: a
    test asserts its body calls neither `fetch` nor the Jimaku key, and the
    background test asserts the request count does not change.
  - **Every decision carries its reason**: which pattern found the episode
    number, which token stated the language, and why a track does or does not
    need translating. A file already written in the viewer's target language is
    displayed without any provider being contacted, which is the point of the
    feature.
  - **It also owns where a file's timeline sits on the video's clock.** A file
    made for another release of the same episode states its lines seconds or
    minutes away from the copy being watched, and LST renders an imported file
    from its own timeline, so the distance has to be expressible: the correction
    is stored with the file, for the episode it was imported for, and not in one
    setting. `FILE_TIMING_LIMIT_MS` (ten minutes either way),
    `FILE_TIMING_STEPS_MS`, `normalizeFileTiming()`,
    `timingLookupOffsetSeconds()`, `timingTargetFor()` and
    `describeFileTiming()` are its owners: the player and the popup ask
    `timingTargetFor()` which clock their buttons move, the module adds the
    file's correction to the global setting (both "positive is later") in one
    place, and one sentence describes the number. A press writes through
    `SET_IMPORTED_TRACK_TIMING`, which refuses a correction for an episode with
    no imported file, and the player applies it in place rather than re-reading
    the file the viewer is watching. It cannot rescue a file for a re-cut
    episode, where the distance changes partway through — no single number can,
    and the module says so at the limit rather than pretending.
  - **It also owns what LST remembers about a show.** A *finding* is what Jimaku
    held when the viewer last asked, stored under one key and keyed by show key —
    a note about the show, not about the episode that was playing. `FINDING_REASON`
    is its vocabulary, `normalizeJimakuFinding()` refuses a note that names no
    show or says no time, `findingFromSearch()` / `findingForFiles()` are the only
    ways one is written, and `describeJimakuFinding()` is the only place that says
    what one means — so the player, the popup and the options card cannot describe
    the same note three ways, and a page that formatted one itself fails a test.
    The module has no clock: the caller states `checkedAt` and the `now` a
    sentence is phrased against, and a note without a time is refused rather than
    stamped with a guess.

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

Optional permissions are preferred to required ones when a host is only
contacted because the user asked for something. Subtitle import works that way:
`optional_host_permissions` lists `https://jimaku.cc/*` and
`https://www.subtitlebot.com/*`, nothing is granted at install or on upgrade,
and `permissions.request()` is called from the click that asked for the import.
An optional host must not be added to `host_permissions` as a convenience.

## Supported services

Two services ship today, and both are declared in `playback-site.js`:

| Service | Hosts | Realtime | Full-track capture |
| --- | --- | --- | --- |
| Netflix | `www.netflix.com` | Yes | Yes |
| Prime Video | `www.amazon.co.jp`, `www.amazon.com`, `www.primevideo.com` | Yes | Yes |

Each service has its own switch (`enabledSites`), stored as a map keyed by
adapter id and defaulting to enabled. Automatic detection plus the switch means a
user bitten by a change on one service can contain it without losing the other.
An unknown host stays idle and reports `site-unsupported` rather than falling
back to whichever adapter happens to be first.

## Imported subtitles

A viewer can attach a subtitle file to an episode instead of translating the
service's own track, and a file already written in their target language is
displayed without translating anything. Rules:

- One file belongs to one episode, keyed by **episode key**
  (`episode-identity.js`: `8123`, `primevideo~B0B6GZ954Y`), never by cache id —
  the cache id also names the model and the target language, and changing either
  must not lose the file.
- An imported track replaces a captured one. Captured documents are refused while
  it is in use, and the DOM fallback stops reading the service's captions, so the
  service's line cannot appear next to the imported one.
- An imported file carries its own timeline, so it is rendered from the clock and
  is never validated against what the player draws. That is what makes a title
  the service does not subtitle work at all.
- **The distance between that timeline and the video belongs to the file.** A
  file made for another release of the same episode can be seconds or minutes
  away, so the player's timing controls move *that file's* correction while it is
  in use, and the global setting otherwise (`timingTargetFor()`), in steps coarse
  enough to reach another release (30 s, 5 s, 1 s, 0.1 s) and within ten minutes
  either way. The correction is stored with the file (`timingOffsetMs`, through
  `SET_IMPORTED_TRACK_TIMING`) rather than in one setting, because two files for
  two episodes are two distances; a newly imported file starts in step, because
  the correction belonged to the file the viewer replaced. The global setting
  still applies on top, and the panel says so. Applying one is local and
  immediate — the line under the viewer's eyes moves — and never re-reads the
  file. A file for a *re-cut* episode cannot be fixed this way, and the interface
  says that at the limit instead of pretending.
- The translation decision is made when the file is imported and stored with it,
  with its reason. A decision the viewer made (`viewer-choice`) stands forever; a
  decision LST made is made again when the target language changes.
- Nothing is asked of a provider for a track that needs no translation: no
  realtime request, no look-ahead, no paused caching, and no cache entry.
- Every part of the import is user-initiated. No import request is sent at
  startup, in the background, or on a page the viewer did not act on.
- **A file the viewer already has is a first-class source.** The options page
  reads it with a file picker or a drop and sends the text; that path makes no
  request, needs no host permission, and needs no Jimaku key. Do not make it
  depend on either, and do not add "upload" or "fetch by URL" behaviour to it.
- `source` on a stored track records where it came from (`jimaku-download` or
  `local-file`). A record without one was downloaded from Jimaku.
- A file whose name states an episode other than the one playing is imported with
  a note (`episode-mismatch`), never refused: the viewer chose the file, and a
  release may number its episodes differently from the service.
- **The player says where its subtitles come from.** An imported track is marked
  in the LST controls (the `Imported` chip and the line naming the file), because
  an imported file is not the service's captions and the viewer must not have to
  open a settings page to tell which one is on screen. The file in use always takes
  precedence over anything LST remembers about Jimaku.
- **A fact about a show is a finding, keyed by show key and never fetched on
  arrival.** `episode-identity.js` owns the show key; `subtitle-import.js` owns
  what a finding says (`describeJimakuFinding`) and how long it may be believed
  (`JIMAKU_FINDING_MAX_AGE_MS`). The player reads one with a local message when an
  episode starts or its title resolves; **opening a page must never contact
  Jimaku**, and a test fails if the player sends a search from anywhere but the
  viewer's own click. This is the rule that makes the notice free: a finding is
  only ever as fresh as the last search the viewer ran, and it says so.
- **The query is the show, not the episode.** A service states the season inside
  the show's own name (`機動戦士ガンダム 水星の魔女 シーズン1`, `Show - Season 2`),
  and Jimaku files the entry under the bare name, so a query that keeps the
  season finds nothing at all. `queryFromShowName()` in `subtitle-import.js` is
  the one owner of that trimming, in Latin, Japanese and Chinese; every caller
  (the player's **Check Jimaku**, the import card's search box) goes through it,
  and a test fails if either stops. A pattern may never empty the query, so a
  show actually called `第2期` is still searched for as `第2期`.
- **The notice outlives the status line.** Every other message goes to the status
  line and is replaced by the next one — often within a second of arriving, which
  is what makes a notice there useless. The Jimaku sentence has its own element
  and its own dismiss button, is kept per show rather than per episode, is never
  drawn while an imported file is in use, and follows the "Show info messages"
  setting.
- **The declaration that counts is the one in the manifest the copy was loaded
  with.** A browser grants an optional host only if the manifest it parsed at load
  time declared it, and Firefox keeps that manifest for the life of the load, so a
  copy loaded before LST declared the two hosts is refused in the browser's own
  words. The options page reads the manifest it is actually running under
  (`runtime.getManifest()`, accepting hosts under either key), and answers with
  one sentence that names the host from the module and says to reload the
  extension — never the browser's message, which names neither cause nor fix.
- `permissions.request` requires a user input handler (Firefox marks the API
  `requireUserInput`), and an `await` before the call ends the handler's turn, so
  `ensureImportAccess()` stays the first await of every click that can ask. A test
  fails if a handler starts doing something else first.

## Platform integration

Every service is a private web application and can change without notice.

Prefer robust behavior over depending on one DOM selector.

Current strategy should remain layered:

1. Capture full TTML/WebVTT timed-text responses where possible.
2. Parse and synchronize cues against video playback time.
3. Fall back to observing the subtitle text the service visibly renders.
4. Keep realtime translation usable even when full-track capture fails.

Do not make full-track capture a hard requirement for basic translation.

Site-specific facts — playback paths, the active `<video>`, how a caption line is
rendered, title hooks, page-title boilerplate, native-caption selectors,
timed-text URL/content-type shapes, and the asset listing a service names its
subtitle tracks in — belong to `playback-site.js`. Nothing in `content.js` or
`page-hook.js` may test a hostname or a service's markup directly.

### Prime Video specifics

- Prime Video renders each caption line as a `span.atvwebplayersdk-captions-text`
  and **reuses the element, rewriting its text**. A cue boundary is a text
  change, never a new element; the existing stable-text window produces it.
- Read the caption **spans**, never the caption container: the container also
  holds control SVGs and player chrome, and reading it would harvest a title or a
  timer as if it were a subtitle.
- Hide native captions with a stylesheet rule carrying `!important`, never an
  inline style: Prime Video rewrites that element's inline style periodically.
- Prime Video renders several `<video>` elements (main playback plus ad and
  preview slots). Use the adapter's `activeVideo()`, never a bare
  `document.querySelector("video")`.
- A playback *path* is not the same question as "something is playing". Each
  adapter answers `playerPresence()`, and LST draws nothing until a player is in
  use. On Netflix the watch page is the player; on Prime Video the player
  container must be mounted and its video started, so a storefront, a product
  page, or a detail page that has not begun playing is left untouched.
- Some titles use image-based (bitmap) subtitles and produce no caption spans
  at all. That has to be detected and reported as `native-bitmap-subtitles`
  rather than appearing broken, and never by reading pixels; the detection is
  tracked in `PRIME_VIDEO_PLAN.md` §6. Until it ships, such a title simply
  shows LST waiting.
- **The full track comes from the playback-resources listing, not from the
  captions.** Prime's player asks for a title's assets before it plays anything
  (`GetPlaybackResources` / `GetVodPlaybackResources`), and the answer names every
  timed-text track the title carries. `playback-site.js` owns that listing's URL
  shapes and how a track is chosen from it (`playbackResources`), and
  `page-hook.js` reads the listing, fetches the chosen document **in the page
  world** and publishes it through the same message a Netflix document arrives
  in. Fetching it there is the point: the request carries the page's own origin
  and cookies, so no CDN host permission is ever added and the extension never
  asks anything else to fetch a subtitle URL. The document is read immediately
  because these URLs are signed and expire, so a URL is never retained.
- A **forced-narrative** track translates on-screen text rather than dialogue, so
  it is never what LST captures: a listing holding nothing else is reported as
  having no track rather than shown as the episode's subtitles. Among the rest,
  the adapter's declared language preference decides (`ja` first), then the first
  subtitle track listed, and the reason travels with the track.
- Prime Video's font is not Netflix Sans; keep overlay styling service-neutral.
- **A captured document is held, not dropped, when it may belong to the episode
  being switched to.** A service asks for the next episode's assets while the URL
  is often still the previous episode's, so the document can arrive before
  `content.js` has noticed the change and be judged against a track that is still
  loaded — and the request that carried it is never repeated, so it is the only
  copy LST will get. The newest document is kept in `heldCapturedDocument` and
  re-offered to an emptied track: after a route change, when playback starts, or
  when the player draws a line the held document holds and the current track does
  not (the one piece of evidence that names the episode when the URL never
  moves). It is never trusted on its own — `resolveTrackDocument()` decides, as it
  does for an arriving document — it is adopted once, and only while it is fresh
  enough to be this episode's capture (`HELD_DOCUMENT_FRESH_MS`). The event log
  records `held-document-adopted` with the reason, or `held-document-stale`.

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

### In-player controls

- **The pill says how much of the episode is loaded.** One figure — of the cues
  LST holds for the episode, the ones translated and cached — drawn as a
  percentage beside the status and as a bar along the trigger's bottom edge, and
  spelled out in cues in the panel. It is worked out in one place
  (`loadProgress()` and `updatePillProgress()` in `content.js`) so the number, the
  bar and the sentence cannot disagree.
- **It is the episode's share, not the share left from the viewer's position.**
  The two part ways as soon as an episode is watched from anywhere but its start;
  how far ahead the cache reaches is answered separately, in seconds beside the
  percentage, and the debug panel reports the remaining share as a percentage of
  its own.
- **A track that needs no translation has nothing loading**, so the readout is
  hidden rather than shown at zero — a file already in the viewer's language is
  all there, and 0% would read as a failure.

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
