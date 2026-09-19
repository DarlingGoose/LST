# Prime Video support — implementation plan

Target: `https://www.amazon.co.jp/-/en/gp/video/detail/B0B6GZ954Y` (Japan Prime Video,
English locale path), without regressing Netflix.

This document is a plan, not a spec of finished behaviour. Anything marked
**Unknown** below has to be answered by Phase 0 before the rest is built.

---

## 0. Scope

In scope:

- One site adapter owns every site-specific fact. Netflix keeps working unchanged.
- Prime Video works on `amazon.co.jp` at minimum, plus the other Amazon marketplaces
  and `primevideo.com` as far as the adapter makes them free.
- Prime gets realtime translation first (the DOM-rendered-caption path, which needs
  no capture), then timed-text capture so precompute and the transcript sidebar
  light up.
- Cache identity, show/episode naming, and the translation library stay correct on
  both services.

Decided with the maintainer, 2026-09-18: the settings key migrates to a neutral name
(§3.5); the namespaced cache id is approved (§3.6); v1 ships `amazon.co.jp`,
`amazon.com` and `primevideo.com` with a documented one-place path for more (§3.3);
Prime Video ships with **automatic detection plus a per-site switch** (§3.7); the
show-name fallback is "Prime Video"; and the HUD position becomes user-configurable
because Prime's own title UI occupies the top-left (§3.8).

Out of scope (deliberately):

- All Amazon marketplaces up front. Three host patterns ship; the adapter makes the
  rest a one-line change (§3.3).
- Bitmap/image-based subtitles. Some Prime titles render subtitles as images. LST
  will detect that, report it, and leave native rendering alone. It cannot translate
  what has no text.
- Any new provider, any new permission beyond the Amazon playback hosts, any
  extension-originated request to a subtitle CDN.
- A rename exercise in `content.js` for its own sake. Section 3.4 draws a line
  between names that must change and names that must not.

---

## 1. Where the code is Netflix-only today

Measured, not estimated:

| Coupling | File | Count |
| --- | --- | --- |
| the word "Netflix" | `content.js` | 126 |
| | `episode-identity.js` | 20 |
| | `background.js` | 4 |
| | `popup.js` / `setup.js` / `setup.html` / `options.js` / `options.html` | 23 / 20 / 16 / 12 / 11 |
| | `manifest.json` | 4 |
| | tests | 57 `test-episode-identity`, 20 `test-subtitle-sync`, 7 `test-setup-page`, 6 `test-translation-context` |
| `[data-uia=…]` selectors | `content.js` | 26 |
| `.player-timedtext` selectors | `content.js` | 4 |
| `document.querySelector("video")` | `content.js` | 17 |
| `hideNetflixSubtitles` storage key | 7 files | 13 references |

The real coupling is concentrated in eleven places:

1. **`manifest.json`** — `description`, `host_permissions`, and `matches` on both
   `content_scripts` entries are `https://www.netflix.com/*` only. Nothing runs on
   Amazon at all today.
2. **`page-hook.js`** — `isWatchPage()` is `/^\/watch\/\d+`, and the subtitle-URL
   heuristic is `(?:subtitle|timedtext|caption|dfxp|webvtt|\.vtt|\.xml|\?o=)`. The
   message it posts carries no site, so a document captured on one service could in
   principle be accepted on the other.
3. **`content.js` `getVideoId()`** — `/watch/(\d+)`, else `"unknown"`.
4. **`content.js` `isWatchPage()`** — the same `/watch/<digits>` test, polled every
   750 ms by `syncPlaybackRoute()`.
5. **`content.js` `requestNetflixTitleMetadata()`** — fetches the same-origin
   `/title/<id>` HTML page and scrapes the embedded metadata object.
6. **`content.js` `netflixTitleMetadata()` / `startTitleMetadataObserver()`** — a
   selector list built entirely from `[data-uia="video-title"]`-shaped hooks.
7. **`content.js` `findNetflixRenderedSubtitle()`** — three Netflix containers, read
   with `innerText`, first non-empty wins.
8. **`content.js` `cleanNetflixPageTitle()`** — strips `| Netflix Official Site`.
9. **`styles.css`** — `html.lst-hide-netflix-subtitles <netflix selectors>`.
10. **`episode-identity.js`** — the placeholder vocabulary is Netflix-branded
    (`Netflix`, `Netflix - …`, `Netflix episode <id>`, `Unknown Netflix episode`,
    reasons `netflix-brand-only` / `netflix-title-unavailable`), and
    `inferCacheMetadata()` hard-codes `showName: "Netflix"` and derives
    `fallbackEpisodeName` / `fallbackTitle` from the id.
11. **`background.js`** — `DEFAULTS.hideNetflixSubtitles`, and the same
    `showName: "Netflix"` / `Netflix episode ${videoId}` fallback in its cache
    metadata reconciliation.

Point 10 is not cosmetic. If a Prime cache is written today it would be stored under
the Netflix show name and grouped under Netflix in the translation library.

---

## 2. What Prime Video actually is

### 2.1 Verified, from a production extension that documents it

`MatteoLucerni/sublens-extension` ships a Prime Video adapter and documents the player
in enough detail to plan against. Its `CLAUDE.md` and `platforms.js` establish:

- The only stable, non-hashed class in the caption ancestor chain is
  `.atvwebplayersdk-player-container`. Every wrapper class between it and the caption
  text changes between builds.
- Each rendered caption line is a `span.atvwebplayersdk-captions-text`. Multi-row
  lines are `<br>`-separated.
- **Prime reuses a single caption element and rewrites its text in place** for each
  new cue instead of creating a new element. Cue boundaries must be inferred from a
  text change, not from element creation.
- **Prime rewrites the caption span's inline `style` periodically.** Hiding native
  captions with inline style is wiped; it must be a persistent CSS rule with
  `!important`.
- **Prime renders multiple `<video>` elements** (main plus ad/preview slots). The
  correct one is the largest by area, and it is not necessarily the largest at
  startup. Sublens needs a `selectVideo()` hook for this.
- The caption container also holds control SVGs and player UI text, so reading the
  *container's* text is unsafe. Only the per-line spans may be read.
- The controls bar has no stable class. Prime positions its own captions roughly 21%
  of the video height above the bottom.
- Captions on/off state is exposed through `localStorage` key
  `atvwebplayersdk_html5_previous_captions` (present = on, removed = off). Between
  cues and with captions off, the caption span count is 0.
- On `primevideo.com` **the page path does not change between episodes** — the video
  `currentSrc` does.
- Fullscreen uses the real Fullscreen API (`document.fullscreenElement` is
  `dv-player-fullscreen`), so LST's existing overlay reparenting applies unchanged.
- Some titles use image-based (bitmap) subtitles. Those produce no caption spans at
  all.
- Prime exposes **no caption-track language** through any player API.
- Chrome has a known repaint bug where the caption span's changed text is not
  re-detected.

Prime's delivery standard is DFXP/TTML and TTML2, and the web player's playback
resources come from `atv-ps.amazon.com/cdp/catalog/GetPlaybackResources` (also seen
as `GetVodPlaybackResources`); a `JSON.parse`-hooking extension collects
`timedtexttracks[].ttDownloadables` / `subtitleUrls` from that response. Assets are
served from `*.aiv-cdn.net` / `*.aiv-delivery.net` / `*.pv-cdn.net`.

Two of these are good news for LST: no caption-track language is needed, because LST
has no source-language setting and lets the model infer the source; and fullscreen
already works.

Two are latent bugs in LST as it stands: the 17 `document.querySelector("video")`
call sites may pick an ad or preview element on Prime, and the
`innerText`-of-a-container read in `findNetflixRenderedSubtitle()` would, on Prime,
harvest player title and timer text as if it were a subtitle.

### 2.2 Likely, but to be confirmed in Phase 0

- The `amazon.<tld>/gp/video/detail/<ASIN>` page runs the same `ATVWebPlayerSDK`
  player with the same `atvwebplayersdk-` class names as `primevideo.com`. Prior art
  only covers `primevideo.com`, so this is the single most important thing to check.
- The `/gp/video/detail/` family keeps the id in the path (unlike `primevideo.com`),
  which makes id extraction straightforward for the Japan URL.

### 2.3 Unknown — Phase 0 must answer

- **U1. Is the timed-text document reachable at all?** Is the TTML fetched as a
  document the MAIN-world hook can read (a real URL, a text/`arraybuffer` response),
  or is it produced inside a Worker / a blob / already parsed by the SDK? This decides
  whether Prime can ever support precompute and the transcript sidebar, or is
  permanently realtime-only.
- **U2. Do the caption spans appear on the Japan detail page** with the same class
  names as `primevideo.com`?
- **U3. Which `<video>` element wins** on the Japan page with the ad/preview slots
  present?
- **U4. Does the ASIN in the path change when Prime auto-advances** to the next
  episode? If not, LST's URL-derived identity is insufficient on Prime exactly as it
  is on `primevideo.com`. **Answered, and implemented** — see
  `docs/prime-video-recon.md` §U4: the playback-resources answer names the item being
  played (`catalogMetadata`), so the episode is identified by the service's own
  catalog entry and the path never has to move.
- **U5. Which ids appear in practice** — ASIN (`B0B6GZ954Y`), GTI
  (`amzn1.dv.gti.<uuid>`), or both? The dedupe/precompute key depends on it.
- **U6. What does Amazon's own document title look like** on `.co.jp` in both the
  `/-/en/` and Japanese locales, so `episode-identity.js` can be told which prefixed
  forms are placeholders rather than real names.

---

## 3. Architecture

### 3.1 One owner for site facts

A new module, `playback-site.js`, extends the pattern the refactor program has used
everywhere else: one owner per decision, every decision carries a reason, and anything
the module cannot decide is reported rather than guessed.

It owns exactly one question — **which service is this page, and what are that
service's facts** — and answers it for the rest of the extension. It is pure: it
takes a `location`, a `document`, and a `url` as arguments and returns records. No
network, no storage, no timers. It is loadable in the background (`background.scripts`
+ `importScripts`) and as a content script before `content.js`, exactly like
`episode-identity.js` and `translation-context.js`, and it is testable in the existing
`vm` harness with a stub DOM.

### 3.2 The adapter surface

Eight questions, each returning a value or a reason:

```js
{
  id: "netflix",
  label: "Netflix",
  matchPatterns: ["https://www.netflix.com/*"],

  // 1. Is this a page where a player can be running?
  isPlaybackPage({ pathname, search, host }) -> { ok, reason },
  // 2. Which video is the user watching?
  videoIdFrom({ pathname, host })  -> { videoId, kind, reason },
  // 3. Which <video> element is playing?
  activeVideo(document)            -> element | null, with { reason } on null,
  // 4. What subtitle text is on screen right now?
  renderedSubtitleLines(document)  -> { lines, source, reason },
  // 5. Where is the title shown in the player?
  titleElements(document)          -> [element, …],
  // 6. What does this site's own page title look like, and what is boilerplate?
  cleanPageTitle(value)            -> string,
  // 7. What CSS hides this site's native captions?
  nativeSubtitleSelector           -> "…",
  // 8. Can this site's timed text be captured, and how?
  timedText: { capture: "url-heuristic" | "playback-resources" | "unknown" },
}
```

`playback-site.js` exports `LSTPlaybackSite` with `SITES`, `SITE_IDS`, `detect(location)`,
`current()`, and `describeSupport()` (for the HUD and the options page, so the interface
cannot describe behaviour the module does not implement — the same trick
`translation-context.js` uses with `describeLimits()`).

`isPlaybackPage` is deliberately not the same question as "is this a watch URL". A
Prime *detail* page is a browse page until the player appears in it. If LST keyed off
the URL alone it would paint its HUD and overlay over Prime's browse page and announce
"Waiting for … subtitles" while nothing is playing. That behaviour is already a
Netflix guarantee ("Home and Search remain idle"), and it must hold on Prime too.

### 3.3 Prime adapter sketch

```js
{
  id: "primevideo",
  label: "Prime Video",
  matchPatterns: [
    "https://www.amazon.co.jp/*", "https://www.amazon.com/*",
    "https://www.primevideo.com/*",
    // More marketplaces are one entry here plus one manifest pattern — see below.
  ],
  // /-/en/gp/video/detail/B0B6GZ954Y   and   /detail/<id>
  isPlaybackPage: ({ pathname }) =>
    /^\/(?:-\/[a-z]{2}(?:-[A-Z]{2})?\/)?gp\/video\/(?:detail|watch)\//.test(pathname) ||
    /^\/detail\//.test(pathname),
  videoIdFrom: ({ pathname }) => ASIN or amzn1.dv.gti… , else { reason: "video-id-unrecognized" },
  activeVideo: (doc) => largest `doc.querySelectorAll("video")` by bounding area,
  renderedSubtitleLines: (doc) => [...doc.querySelectorAll(".atvwebplayersdk-captions-text")]
    .map((span) => span.innerText || span.textContent || ""),
  titleElements: (doc) => [ /* player title hooks, verified in Phase 0 */ ],
  cleanPageTitle: strips "Amazon.co.jp: ", "Watch ", "| Prime Video", "を視聴",
  nativeSubtitleSelector: "html.lst-hide-native-subtitles .atvwebplayersdk-captions-text",
  timedText: { capture: UNKNOWN_UNTIL_U1 },
}
```

Notes that follow from §2.1 and shape the implementation:

- Caption text is collected **per span and joined with `\n`**, never read from a
  container. This keeps player title and timer text out of the subtitle stream, and
  the `<br>` / newline shape is already handled by the existing folded comparison in
  `subtitle-sync.js`.
- Because Prime reuses one element and rewrites its text, the existing
  `NETFLIX_SUBTITLE_STABILITY_MS` stable-text debounce still produces correct cue
  boundaries (a text change resets the window), and the zero-span state between cues is
  the same "no line" state LST already handles. This needs no new mechanism — it needs
  to be tested with a Prime-shaped DOM.
- Native captions are hidden with a CSS rule carrying `!important`, never inline style,
  because Prime rewrites inline style on that element.
- LST's overlay currently sits in a coordinated **top-left** HUD, and Prime shows its
  own title in the top-left of the player. The Phase 1 browser pass must confirm the
  two do not collide, and if they do, move the LST HUD — see §3.8.

### 3.3.1 Adding a marketplace later

`manifest.json` cannot import JavaScript, so the host list exists twice: once as the
adapter's `matchPatterns`, once in the two `content_scripts` `matches` arrays. Adding
`amazon.de` must therefore be two edits, and the test suite will make that mechanical:

- the adapter's `SITES` entry gains the host,
- `manifest.json` gains it in both `matches` arrays,

and a drift guard in `scripts/test-playback-site.mjs` asserts that every pattern in
every adapter's `matchPatterns` appears in every `content_scripts` `matches`, and that
every `matches` pattern is claimed by some adapter. A forgotten manifest edit fails
`npm run check` with a message naming the missing pattern; a stray pattern that no
adapter claims fails too. That is the "easy to add more" guarantee — not a comment
promising it, but a test that catches the half-done job.

Note also what does *not* need editing to add a marketplace: no `host_permissions`
entry (§9), and no adapter logic, as long as the new marketplace uses the same
player and the same URL family.

### 3.4 Renaming policy

Three tiers, so the rename cannot silently break the F1–F6 work or users' data:

- **Tier A — must change (user-visible or stored correctness).** All UI strings and
  labels ("Waiting for Netflix subtitles…", "Turn on a Netflix subtitle track…",
  "Open a Netflix watch page first."), the `showName` fallback, the placeholder
  vocabulary, the cache id's service namespace, the CSS class, `manifest.description`,
  and every doc.
- **Tier B — should change (mechanical, low risk).** `findNetflixRenderedSubtitle` →
  `findRenderedSubtitle`, `observeNetflixRenderedSubtitle`, `netflixTitleMetadata`,
  `cleanNetflixPageTitle` → `cleanSitePageTitle`, `requestNetflixTitleMetadata` →
  `requestSiteTitleMetadata`, `validateTimedTrackAgainstNetflix` →
  `validateTimedTrackAgainstRendering`, and the module-level `netflixSubtitleCandidate`
  / `lastNetflixSyncText` / `netflixSubtitleDomDiagnostics` locals. These become
  site-neutral because the concept is site-neutral. A final `grep -ri netflix` gate
  should return only genuinely-Netflix things.
- **Tier C — changes once, behind a migration.** The **`hideNetflixSubtitles`
  storage key** (13 references across 7 files, persisted in every existing install)
  is renamed to `hideNativeSubtitles` with a fallback read (§3.5). The **cache id
  format for existing Netflix caches** is frozen and never rewritten (§3.6) — the
  namespaced scheme deliberately leaves Netflix keys byte-identical, so there is
  nothing to migrate.

### 3.5 The settings key — migrated to a neutral name

`hideNetflixSubtitles` becomes `hideNativeSubtitles`. The stored preference must
survive on every existing install, so the migration is a read-through, not a rename:

- **Read**: `settings.hideNativeSubtitles ?? settings.hideNetflixSubtitles ?? DEFAULTS.hideNativeSubtitles`.
  The `??` chain and not `||` matters: `false` is a legitimate stored value (the user
  turned the setting off) and `||` would discard it.
- **Write**: the new key only. The old key is never written again.
- **Cleanup**: after a successful write the old key is removed. Cleanup is best-effort
  — a failed removal must never fail the save, because the value has already been
  persisted under the new name and the fallback read keeps working regardless.
- **Ordering**: the fallback read must exist and be tested *before* the new key is
  introduced anywhere, so there is no window in which a saved preference reads as
  `undefined`.

13 references across 7 files: `content.js`, `background.js`, `options.js`,
`options.html`, `popup.js`, `setup.js`, `setup.html`. The settings page, the popup and
the setup page all display it as "Hide the service's own subtitles" or similar
site-neutral wording, and `background.js` `DEFAULTS` becomes the single declaration
the others agree with.

This is the one user-data migration in the whole plan, and it is small on purpose:
one key, read-through, tested in `test-setup-page.mjs` and a new settings-migration
case asserting that a legacy `{hideNetflixSubtitles: false}` install still reads back
`false` and that a subsequent save writes `hideNativeSubtitles`.

### 3.6 Cache identity, with no migration

This is the one place where Prime support changes stored data, so it needs to be
explicit.

Today's id is `<videoId>:<encoded owner>:<encoded language>`, and
`episode-identity.js` `decodeCacheId()` treats the first `:`-delimited segment as the
video id, with `isKnownVideoId()` gating it. Netflix ids are numeric.

Proposal: namespace only the non-Netflix services, using `~` as the separator, since
`~` is unreserved and `encodeURIComponent` never produces it:

- Netflix (existing and future): `12345678:qwen3.5:English` — **byte-identical to
  today**, so every existing cache keeps resolving and nothing is orphaned.
- Prime Video (new keys by construction): `primevideo~B0B6GZ954Y:qwen3.5:English`

`decodeCacheId()` gains a leading `<siteId>~` check and reports
`reason: "legacy-cache-id"` for un-namespaced keys so they resolve to Netflix
explicitly rather than by fallback. `isKnownVideoId()` gains ASIN and
`amzn1.dv.gti.*` shapes. `inferCacheMetadata()` derives `showName` from the service
rather than hard-coding `"Netflix"`.

Because a new service's ids are new ids, **no migration exists to perform** — which is
the whole reason to prefer a prefix that Netflix keys never carry over one that
rewrites every key.

### 3.7 Per-site enable switches, with automatic detection

Detection stays automatic — the adapter picks the site from the host, so no user
choice is needed to make either service work. On top of that, each site gets its own
switch, so someone who wants LST on Netflix only never runs it on Amazon, and a user
bitten by a site change can turn one service off without losing the other.

- **Shape**: one stored map keyed by adapter id, e.g.
  `enabledSites: { netflix: true, primevideo: true }`. Keyed by id rather than by
  boolean-per-site so that adding a marketplace (§3.3.1) needs no new setting, and
  adding a *service* needs no settings-schema change.
- **Defaults**: both enabled. A site absent from the map is enabled — an unknown key
  is not a reason to disable something the user never touched. The global `enabled`
  switch keeps its current meaning and still gates everything.
- **Unknown/unsupported host**: LST stays idle and reports
  `site-unsupported`, rather than falling back to whichever adapter happens to be
  first. This is the "never guess" rule applied to site detection.
- **Effect**: turning a site off tears down exactly like the global switch does today
  — remove the overlay, HUD, panels, the `html` class, and stop the fallback and title
  observers, leaving native subtitles untouched. No page reload.
- **UI**: a compact per-service section in the Subtitles (or General) settings tab
  listing detected services with a switch each, plus the setup page. Adding a service
  adds a row, not a new layout.
- **Reporting**: `site-disabled` and `site-unsupported` are logged as reasons so a user
  who wonders why LST is quiet on a page can see it in the event log rather than
  nothing at all — the same posture as an unexplained empty translation context that
  F5 removed.

### 3.8 HUD placement, user-configurable

LST's HUD and quick-pill currently occupy a coordinated top-left position, and Prime
shows its own title in the top-left of the player. Rather than special-case Prime with
a hard-coded offset, the position becomes a setting:

- `hudPosition`, one of four corners, default `top-left` (today's behaviour, so
  Netflix is unchanged).
- **Per-site default**: because Amazon's own title sits top-left, the Prime adapter
  carries a preferred default of `top-right` for users who never touch the setting,
  with any explicit user choice always winning. The user's choice is stored once and
  applies to every site — a user who picks `bottom-right` is not surprised by a
  different corner on Prime — so the adapter's preference is consulted only for a user
  who has never chosen.
- This replaces the "Phase 1 browser pass must confirm" hand-wave with something
  deterministic: whatever Amazon does, the user can move LST out of the way, and the
  default is chosen to avoid the known collision rather than discovered by accident.
- The debug panel already positions itself independently, and the transcript sidebar
  is a separate element; neither is part of this setting. Only the HUD/pill moves.
- Shares the existing "saved appearance changes are pushed to open tabs immediately"
  path, so moving the HUD applies live.

---

## 4. Phase 0 — recon (no product code)

A throwaway probe plus one manual DevTools session on the Japan URL, answering U1–U6
from §2.3. Deliverable: `docs/prime-video-recon.md`, with the real caption DOM shape,
the real request list for a subtitle fetch, and a yes/no on U1.

Exit criteria:

- U1 answered. Either a URL/response shape that carries timed text is identified, or
  Prime ships realtime-only and Phase 2 is dropped.
- U2, U3, U4, U5, U6 answered from the Japan page, and the adapter sketch in §3.3
  corrected against reality.
- Confirmed whether anything at all needs `host_permissions`, versus
  `content_scripts.matches` alone (see §6).

Deliberate constraint: the probe lives in `/tmp`, is never committed, and is deleted
when the phase closes — the same discipline the F5 falsification probes used.

---

## 5. Phase 1 — adapter, identity, and Prime realtime

Ships a usable Japan Prime Video experience.

1. **`playback-site.js`** — the adapter, Netflix first (behaviour-identical), then
   Prime. Pure, no DOM ownership: every DOM read passes the document in.
2. **`content.js` delegations** — `getVideoId()`, `isWatchPage()`,
   `findRenderedSubtitle()`, `activeVideo()` (replacing all 17
   `document.querySelector("video")` sites), title elements, page-title cleanup, and
   the status strings, all via the adapter.
3. **A "player is present" gate** in `syncPlaybackRoute()` so a Prime browse page stays
   idle.
4. **`page-hook.js`** — site-aware `isPlaybackPage`, subtitle-URL heuristics drawn from
   the adapter, and a `site` field on the posted message. `content.js` refuses a
   document whose `site` is not the current page's, reporting
   `subtitle-document-other-site`.
5. **`styles.css`** — one hide rule per site under a shared
   `html.lst-hide-native-subtitles` class, with `!important`.
6. **`episode-identity.js`** — service-namespaced cache ids and id shapes (§3.6),
   service-aware placeholder vocabulary and `showName`, and Prime added to the
   "where did this name come from" reasons.
7. **`background.js`** — the metadata defaults follow the cache id's service instead of
   assuming Netflix.
8. **Title and naming for Prime.** Netflix's `/title/<id>` HTML page does not exist on
   Amazon. Phase 1 uses the player's own title elements plus the site's document title
   (cleaned per site), and when neither yields a real name it falls back to
   `Prime Video episode <id>` — a recognizable placeholder with a reason, exactly as
   `episode-identity.js` already does for Netflix. Reading title metadata out of the
   playback-resources JSON is a Phase 2 option, not a Phase 1 dependency.
9. **UI, setup and docs** — `options.html`, `popup.js`, `setup.js`/`setup.html`,
   `README.md`, `AGENTS.md`, `PRIVACY.md`, `AMO_REVIEWER_NOTES.md`, `amo-metadata.json`,
   `manifest.description`.
10. **`hideNativeSubtitles`** — the read-through migration of §3.5, done before any
    other settings edit so there is never a build that loses a stored preference.
11. **Per-site switches and `hudPosition`** — §3.7 and §3.8. Both are Phase 1, not
    polish: the Prime default HUD corner is what keeps LST off Amazon's own title UI
    on day one, and the per-site switch is what lets a user contain Prime if its
    player changes.

Phase 1 capability on Prime, stated honestly: **realtime, one cue at a time, plus
look-ahead limited by what has already been rendered.** No precompute, no transcript
sidebar, no full-track timeline — because those need a captured track. This is exactly
the Netflix fallback path, which AGENTS.md already requires not to be a second-class
citizen.

*(Phase 2 item 1 later answered U1 and shipped the capture — see §6. The paragraph
above describes Phase 1 as it shipped, and the fallback it names is still what runs
when a listing yields no readable track.)*

Exit criteria:

- The Japan URL plays a real episode with LST translations rendering above Prime's own
  captions, native captions hidden, fullscreen correct.
- Prime browse pages and the mini-player stay idle.
- A Prime cache row in the translation library is grouped under Prime Video with a
  recognizable episode name, and existing Netflix caches are untouched.
- `npm run check` green, including the new suite; web-ext lint 0/0/0.
- `npm run package:all` green with a new module in both 33+-entry archives.
- A Netflix playback pass: realtime, look-ahead, precompute, cached playback, seeking,
  episode change, track switch.

---

## 6. Phase 2 — Prime timed-text capture, then parity

**Status: item 1 shipped.** U1 was answered by the shape of Prime's own player: it
is handed a *listing* of a title's assets rather than a document, so the listing is
what LST reads.

1. **`page-hook.js`** — reads the Prime playback-resources response, takes the track
   the adapter names, fetches that one document in the page world and publishes it
   with the site tag, exactly as a Netflix document is published. The capture stays
   in the page world so **no CDN host permission is ever needed**; the extension
   never fetches a subtitle URL itself, and the resolved URL is not retained because
   it is signed and short-lived. The adapter facts — the listing's URL shapes, how a
   track is read out of it, and which track is the episode's source — live in
   `playback-site.js` as `playbackResources`.
2. **Track adoption** — `subtitle-sync.js` and the F6 captured-document decisions
   already work on cues and timelines, not on Netflix. If the TTML parses, precompute,
   the transcript sidebar, `translation-context.js` (F5) and the cache reconcile path
   all light up with no site-specific work. That is the payoff of the earlier
   refactors, and it should be verified rather than assumed.
3. **Episode identity hardening — done.** U4 was answered by the listing rather than
   by a media-change signal: `GetVodPlaybackResources` names the item being played, so
   `playback-site.js` reads `catalogMetadata` (`playbackResources.identity`),
   `page-hook.js` publishes it as `EPISODE_IDENTITY`, and `content.js` keys the
   episode, its names and its change of episode on it. A listing that states nothing
   usable answers `no-catalog-metadata` and LST behaves exactly as it did before, so
   nothing is keyed on a guess. F5's rule applies: every decision says why.
4. **Bitmap detection** — when captions are on, a player exists, and no caption span
   ever appears, report `native-bitmap-subtitles` and surface one clear line in the
   HUD instead of appearing broken.

Exit criteria: a Prime episode precomputed and replayed from cache; the transcript
sidebar populated; the cache grouped and previewable; the event log carrying
Prime capture reasons.

---

## 7. Phase 3 — release surface

- Store copy and screenshots; `amo-metadata.json` gains Prime Video and the
  "not affiliated with Amazon" line alongside the existing Netflix disclaimer;
  `AMO_REVIEWER_NOTES.md` gains the Prime capture explanation and the permission
  rationale for the Amazon hosts.
- `CONTRIBUTING.md` / `AGENTS.md` gain the adapter rule: new platform branches go in
  `playback-site.js`, never scattered.
- Version bump and tag together (`check:release` already enforces this).
- Optional: nothing outstanding for Prime. Per-site switches and the HUD position
  ship in Phase 1 (§5 items 10–11); this phase is copy, notes and release only.

---

## 8. Testing

Following the existing shape, one new suite plus extensions:

- **`scripts/test-playback-site.mjs`** (new) — the adapter as a table:
  - host detection, including the Japan URL `/-/en/gp/video/detail/B0B6GZ954Y`, the
    Japanese locale form, `ref=` path segments and query strings, ASIN and GTI ids,
    `primevideo.com/detail/<id>`, and refusal (with reasons) for Netflix-on-Amazon,
    Amazon browse pages, and unknown hosts;
  - `activeVideo` picking the largest element in a fake DOM containing an ad player;
  - `renderedSubtitleLines` returning per-span lines joined with `\n`, and returning
    nothing rather than the container's text when no spans exist;
  - a Prime-shaped DOM where one span is rewritten in place across cues, to prove the
    stability window still yields correct cue boundaries;
  - `cleanPageTitle` for `.co.jp` titles in both locales;
  - no-text-in-report: the adapter's reasons never contain subtitle text or titles.
- **`test-page-hook.mjs`** — becomes a table over both sites: the Netflix `?o=`
  heuristic still fires, a Prime playback-resources response and a Prime TTML URL are
  recognized, and a document captured for the other site is refused.
- **`test-episode-identity.mjs`** — namespaced cache ids round-trip; a legacy Netflix
  key still decodes with `reason: "legacy-cache-id"`; a Prime key reports Prime Video
  as `showName`; a Prime placeholder is recognized as a placeholder.
- **`test-cache.mjs` / `test-subtitle-sync.mjs`** — the Prime-shaped cue path through
  the real background and the real content.js harness.
- **Drift guards** (in the new suite): both `content_scripts` `matches` arrays contain
  the Amazon and Netflix patterns; `prepare-browser.mjs` `sourceFiles` and
  `verify-package.mjs` `required` list both include `playback-site.js`; the manifest
  load order puts it before `background.js` and before `content.js`; the README and
  options copy mention both services; the HUD label comes from
  `describeSupport()`. Plus the §3.3.1 manifest↔adapter host guard, in both
  directions.
- **Settings migration** (new cases in `test-setup-page.mjs` and the cache suite): a
  legacy `{hideNetflixSubtitles: false}` install reads back `false` after the rename
  (the `??` chain, not `||`); a save writes `hideNativeSubtitles`; an
  `enabledSites` map missing a site leaves that site enabled; an
  `enabledSites: {primevideo: false}` install renders no Prime overlay while Netflix
  is unaffected; `hudPosition` persists and an explicit choice beats the adapter's
  per-site default.
- **Fix the drift guards for the renamed settings key**: no suite may still assert
  `hideNetflixSubtitles` as a *written* key, so the guard cannot accidentally pin the
  old name in place.
- **Manual checklist** for the maintainer: Japan locale (Japanese UI, `/-/en/`),
  Japanese→English, Japanese→Japanese-same-language sanity, mini-player, fullscreen,
  episode auto-advance, ad/preview player present, a bitmap-subtitle title, seeking,
  and a Netflix regression pass.

---

## 9. Privacy, permissions, AMO

- **Permission widening is the Amazon playback hosts added to both
  `content_scripts` `matches` arrays** — plus whatever U1/§4 proves is genuinely
  required. No `*://*.amazon.*`, no `<all_urls>`, no CDN hosts: capture happens in the
  page world, so the extension never needs permission to fetch subtitle assets.
  `host_permissions` is expected to stay exactly as it is; Phase 0 confirms that
  nothing requires otherwise (§4).
- **No new data leaves the device.** Subtitle text goes to the same user-chosen
  provider under the same `websiteContent` declaration. `PRIVACY.md` changes from
  "supported Netflix pages" to naming both services; nothing else about it changes.
- **No remote code.** The Prime adapter is static, declarative data, not fetched
  behaviour.
- **Store listings will show the added site access.** That is unavoidable and should be
  stated plainly in the release notes and reviewer notes rather than glossed.
- The AMO reviewer notes must explain the Prime capture path in the same terms as the
  Netflix one, and the added host rationale.

---

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| U1 is no — no capturable timed text on Prime | Prime ships realtime-only; Phase 2 and precompute are dropped rather than faked. The DOM path is the product, not a stopgap. |
| The Japan `/gp/video/` page is a different player than `primevideo.com` | Phase 0 U2 answers it before Phase 1 commits to selectors. If it differs, the adapter absorbs it — that is what the adapter is for. |
| Bitmap subtitles on some titles | Detected and reported (`native-bitmap-subtitles`); never silently broken. |
| Prime's class names change between builds | Only `.atvwebplayersdk-player-container` and `.atvwebplayersdk-captions-text` are relied on, both documented as the stable ones; every failure path reports a reason instead of guessing. |
| `document.querySelector("video")` picks an ad/preview element | Replaced by the adapter's `activeVideo()` at all 17 sites — a robustness fix that also benefits Netflix. |
| LST's HUD collides with Prime's own top-left title UI | Checked in the Phase 1 browser pass; the HUD moves if it does. |
| Prime's multiple player instances (mini-player) confuse identity | Identity is a site fact; Phase 0 U4 decides whether a media-change signal is required. |
| Renaming collides with the just-verified F1–F6 work | §3.4 tiers; Tier C keys are frozen; `npm run check` and the cache suite gate every step. |
| Existing Netflix caches or settings are damaged | Netflix cache ids stay byte-identical; the one settings rename is a read-through migration sequenced first in Phase 1, with a `??` chain so a stored `false` survives, tested before the new key is written anywhere. |

## 11. Decisions (resolved 2026-09-18)

| # | Question | Decision |
| --- | --- | --- |
| 1 | Settings key | **Migrate** to `hideNativeSubtitles`, read-through fallback, old key cleaned up (§3.5) |
| 2 | Cache id | **Approved** — `primevideo~<id>:<owner>:<language>`, Netflix keys byte-identical, no migration (§3.6) |
| 3 | Marketplace breadth | **v1 = `amazon.co.jp`, `amazon.com`, `primevideo.com`**, with a two-edit, test-enforced path for more (§3.3.1) |
| 4 | Per-site toggle | **Ship it** — automatic detection plus a per-site switch, unknown hosts report `site-unsupported` (§3.7) |
| 5 | Show-name fallback | **"Prime Video"** |
| 6 | HUD collision | **Make the HUD position user-configurable**; Prime defaults to a non-top-left corner (§3.8) |

Consequences carried into the phases: the settings migration is sequenced first in
Phase 1 (§5 item 10) so no build loses a stored preference; the per-site switch and
the HUD position are Phase 1 deliverables rather than polish; and the host-list drift
guard of §3.3.1 is what makes decision 3 safe rather than merely narrow.

## 12. Sequencing and effort

| Phase | Content | Rough effort |
| --- | --- | --- |
| 0 | Recon probe + DevTools pass on the Japan URL, U1–U6 | 0.5 day |
| 1 | Settings migration, adapter, identity, Prime realtime, per-site switches, `hudPosition`, tests, docs | 2–2.5 days |
| 2 | Timed-text capture, parity, identity hardening | 1–2 days (U1-dependent) |
| 3 | Store copy, reviewer notes, release | 0.5 day |

Phase 1 is independently shippable and is where the Japan Prime Video request is
actually satisfied. Phase 2 is upside, not a promise.

**Rollback:** Prime support is additive. Deleting the Amazon patterns from the two
`content_scripts` `matches` arrays removes Prime entirely; Netflix behaviour and cache
ids are unchanged by construction, so a rollback cannot strand user data.
