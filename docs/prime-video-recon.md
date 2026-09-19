# Prime Video recon

Status: **Phase 0 has not been run against a live player.** This document records
what is known from prior art, what the implementation currently assumes, and what
still has to be answered. Everything marked **unverified** below is an assumption
that the adapter reports rather than hides.

The plan that this document belongs to is `PRIME_VIDEO_PLAN.md` at the repository
root. Phase 1 of that plan ships the adapter, identity, realtime translation, the
per-service switches, the configurable HUD corner, tests and docs. Phase 0's
answers are the gate for Phase 2 (timed-text capture, precompute, transcript
sidebar) and were expected to correct the adapter sketch.

## What is verified

From a production extension that documents the player
(`MatteoLucerni/sublens-extension`, its `CLAUDE.md` and `platforms.js`):

| Fact | Where it is used |
| --- | --- |
| The only stable, non-hashed class in the caption ancestor chain is `.atvwebplayersdk-player-container` | `playback-site.js` (Prime caption scope) |
| Each rendered caption line is a `span.atvwebplayersdk-captions-text`; multi-row lines use `<br>` | `renderedSubtitleLines` |
| The caption span is **reused** and its text rewritten in place | cue boundaries via the stable-text window |
| The caption span's inline `style` is rewritten periodically | hiding native captions is a stylesheet rule with `!important` |
| Prime renders multiple `<video>` elements (main, ad, preview) | `activeVideo()` picks the largest by area |
| The caption container also holds control SVGs and player UI text | only the per-line spans are read |
| Captions on/off state is exposed through `localStorage` key `atvwebplayersdk_html5_previous_captions` | not used by LST |
| On `primevideo.com` the page path does **not** change between episodes | `video-id-unstable` risk, see below |
| Fullscreen uses the standard Fullscreen API | LST's existing reparenting applies unchanged |
| Prime exposes no caption-track language through a player API | LST has no source-language setting, so nothing is needed |
| Some titles use image-based (bitmap) subtitles and produce no caption spans | detected and reported (Phase 2 item 4) |
| Timed text is DFXP/TTML/TTML2, from `atv-ps.amazon.com/cdp/catalog/GetPlaybackResources` (`GetVodPlaybackResources`), served from `*.aiv-cdn.net`, `*.aiv-delivery.net`, `*.pv-cdn.net` | `timedText.urlPatterns`, `timedText.contentTypes` |
| The playback-resources response names the title's subtitle tracks, under `timedTextUrls.result.subtitleUrls` (and `forcedNarrativeUrls`), with `timedtexttracks[].ttDownloadables` as the delivery document's spelling | `playbackResources`, `timedText.capture: "playback-resources"` |

## What the implementation assumes (unverified)

Each of these is a place where the adapter will report a reason instead of a
wrong answer if the assumption fails.

0. **The player gate.** `playerPresence()` requires Prime Video's ATV player
   container to be mounted *and* an active video to have started (metadata
   loaded, time moving, or a known duration). This is what keeps LST off a
   storefront, a product page, or a detail page that has not begun playing. It is
   the same class of assumption as U2 below: whether Prime mounts that container
   for its autoplaying detail-page trailer is unverified, and the answer is
   reported as a reason (`prime-player-container-absent`,
   `prime-player-not-in-use:<video reason>`) rather than silently changing
   behaviour. One adapter method is all that has to change.

1. **U2 — the Japan detail page runs the same player.** The adapter treats
   `/gp/video/detail/<id>` (and the `/-/en/` locale form) and `primevideo.com`'s
   `/detail/<id>` as the same player with the same `atvwebplayersdk-` class
   names. If the Japan page renders captions differently, the fix belongs in
   `playback-site.js`'s Prime adapter and nowhere else.
2. **U3 — which `<video>` element wins.** `activeVideo()` takes the largest by
   bounding area, falling back to intrinsic size when layout is unavailable, and
   reports `largest-video-element`, `only-video-element`, or `video-size-unknown`.
3. **U5 — which ids appear in practice.** Both the ASIN (`B0B6GZ954Y`) and the
   GTI form (`amzn1.dv.gti.…`) are accepted as known id shapes;
   `episode-identity.js` treats anything else as an unrecognized id and will not
   key a cache on it.
4. **U6 — Amazon's own document title.** `cleanPageTitle` strips the
   `Amazon.<tld>: ` prefix, the `| Prime Video` / `- Prime Video` suffix, and the
   Japanese `…を視聴` suffix. The exact `.co.jp` wording in both the `/-/en/` and
   Japanese locales has not been captured, so a title that does not match those
   shapes is left alone rather than mangled — and the naming falls back to
   `Prime Video episode <id>`.
5. **Prime player title hooks.** The adapter lists
   `[data-automation-id='title']`, `.atvwebplayersdk-title-text`, and
   `.atvwebplayersdk-content-title` as best-effort containers. None is verified,
   so naming leans on the document title first and reports
   `no-title-elements` when nothing matches.

## The mini-player

**Not handled.** Prime Video plays a small player in the corner while the viewer
browses. It is genuinely playing, so the player gate does not keep LST idle for
it, and its video may or may not carry the same path as the full-page player.
Whether identity needs to distinguish the two is unresolved; it belongs with U4,
because both are the question "which episode is this player showing?".

## U1 — is Prime timed text reachable at all?

**Answered, and implemented.** The text is reachable, but not the way Netflix's
is: the player is handed a *listing* rather than a document.

The player asks for a title's playback resources before it plays anything, and
the answer names every timed-text track the title carries. LST therefore reads
that listing, chooses the track the adapter names, fetches that one document in
the page world, and hands it to the same adoption path a Netflix document takes.
The adapter declares `timedText.capture: "playback-resources"` with the reason
`prime-playback-resources-listing`, and `describeSupport()` reports the same
string to the options page and the setup guide, so the interface says "full-track
capture available" because that is what happens.

What this consists of:

- `playback-site.js` owns the listing: its URL shapes
  (`PRIME_PLAYBACK_RESOURCES_URL`), how a track is read out of it
  (`timedTextTracksFromPlaybackResources`, covering both the
  `timedTextUrls.result.subtitleUrls` envelope and `timedtexttracks[]`), and
  which track is the episode's source (`chooseTimedTextTrack`).
- `page-hook.js` reads the listing off both `fetch` and XHR, fetches the chosen
  document **in the page world**, and publishes it through the same
  `SUBTITLE_DOCUMENT` message a Netflix document arrives in. The request carries
  the page's own origin and cookies, which is why no CDN host permission and no
  background fetch is involved. The document is read immediately and the URL is
  not retained, because these URLs are signed and expire; the same track is
  fetched once per page world even if the listing arrives again.
- Everything after the capture — parsing, precompute, the transcript sidebar,
  `translation-context.js`, the cache reconcile path — is unchanged, because
  those work on cues and timelines rather than on Netflix. That was the payoff
  the earlier refactors promised, and `scripts/test-page-hook.mjs` and
  `scripts/test-playback-site.mjs` now hold it.

Still unverified, and reported per episode rather than assumed: that every title
carries a readable track, and that every marketplace serves the listing in one of
the two shapes above. A listing that names nothing usable writes
`capture-playback-resources-no-track` (with the adapter's reason) to the event
log, and a track that cannot be fetched writes
`capture-playback-resources-track-unreadable`; both leave the rendered-caption
fallback running.

## U4 — does the ASIN change when Prime auto-advances?

**Unanswered.** On `primevideo.com` the path does not change between episodes;
only the video's `currentSrc` does. If the same is true of the Japan detail page,
then a cache written for episode 1 would be reached again on episode 2 — the
same class of bug the Netflix `videoId` never had.

Until U4 is answered:

- LST does not use a media-change signal, so it does not *claim* to detect the
  change. It reports `episode-changed` when the URL's id changes, and nothing
  when it does not.
- Phase 2 item 3 hardens this: identity falls back to `currentSrc`, and when it
  cannot establish an id it reports `video-id-unstable` and refuses to write a
  cache keyed on a guess.

## Permission finding (the plan's §4 exit criterion)

`PRIME_VIDEO_PLAN.md` §9 expected `host_permissions` to stay exactly as it was and
left "does anything genuinely need host permissions?" to Phase 0. Reasoned here
rather than measured:

- Capture and caption reading need no host permission. `content_scripts.matches`
  is what grants them, and `page-hook.js` runs in the page world so the extension
  never fetches a subtitle asset itself.
- `ext.tabs.query({ url: … })` **would** need host permission for those URLs, and
  so would reading `tab.url`. Both were avoided instead:
  - `popup.js` asks the active tab's content script for `GET_PAGE_STATUS` and
    reads the `siteId` the page itself reports.
  - `options.js` and `setup.js` push `RELOAD_SETTINGS` to every open tab and
    ignore the tabs that have no LST content script.
- Conclusion: **no Amazon host permission and no `tabs` permission are added.**
  `host_permissions` is unchanged.

That is a deliberate trade: two messages instead of one filtered query, in
exchange for not widening the store listing's site access beyond the pages the
extension declares it runs on.

## Capability, stated plainly

Prime Video captures the whole track from the playback-resources listing, so it
has **precompute, the transcript sidebar and a full-track timeline** — the same
ones Netflix has, because they run on cues and timelines rather than on a
service.

Where the listing yields no track, or the document it names cannot be fetched,
Prime Video is still **realtime, one cue at a time**, plus look-ahead over what
has already been rendered — the same fallback path `AGENTS.md` requires not to be
a second-class citizen. Full-track capture is never a requirement for basic
translation.
