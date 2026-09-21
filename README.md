# LST — Local Subtitle Translate

A small cross-browser Manifest V3 extension for Firefox and Chromium browsers that translates Netflix and Prime Video subtitles using local Ollama by default, with optional DeepSeek and Gemini providers.

[Privacy policy](PRIVACY.md) · [Browser release guide](docs/releases/firefox.md)

## Features

## Supported services

| Service | Hosts | Realtime | Full-track capture (precompute, transcript) |
| --- | --- | --- | --- |
| Netflix | `www.netflix.com` | Yes | Yes |
| Prime Video | `www.amazon.co.jp`, `www.amazon.com`, `www.primevideo.com` | Yes | Yes |

Both services are detected automatically from the page, and each can be switched
off independently in Settings → Subtitles → Services. Adding another Amazon
marketplace is one entry in the adapter's `matchPatterns` plus the same entry in
both `content_scripts.matches` arrays in `src/manifest.json`; a test fails until both
halves are done.


- Local Ollama by default; DeepSeek and Gemini are opt-in
- Supports Netflix and Prime Video; each service can be switched off independently in Settings
- Playback controls and subtitle work activate only on a watch page; browse pages, storefronts, and pages with nothing playing remain idle
- The LST control button can sit in any corner of the player, so it stays clear of the service's own controls
- Discovers installed Ollama models with `/api/tags`
- Downloads Ollama models by name from Settings
- Select model and target language in the browser
- Uses `translategemma:4b` as the default model for new and previously unconfigured installs
- Realtime subtitle translation
- Time-based look-ahead translation with an enforced 30-second minimum
- Dual subtitle overlay
- Custom subtitle height, alignment, line width, font sizes, and background strength
- Collapsible in-player subtitle editor that remembers its panel state
- Independent visibility controls for the service's own subtitles, LST original text, and LST translations
- Adjustable ±2-second subtitle timing offset in Settings and the in-player pill
- Captures a full subtitle track on both services: Netflix's timed-text documents as the player loads them, and Prime Video's from the playback-resources listing that names the episode's subtitle assets, which LST reads and fetches in the page's own world
- Precomputes an entire captured episode subtitle track
- Caches translations locally per service + video ID + provider/model + target language
- Show-grouped translation history with timestamped preview, TSV export, size, and removal controls, grouped under the service the episode came from
- Separate show and episode names for newly cached or refreshed entries
- Structured JSON output from the selected provider to keep batch translations aligned
- First-run setup page for provider, target language, and subtitle layers
- Import a subtitle file for the episode you are watching — from Jimaku, or one you already downloaded — for a title the service does not subtitle
- A file already written in your target language is displayed as it is, without translating anything

## Importing subtitles

When a service has no track worth translating, attach a subtitle file instead:
**Settings → Subtitles → Import subtitles**. There are two ways in, and the
second one needs nothing but the file you already have.

**A file from Jimaku.** LST searches [Jimaku](https://jimaku.cc) for the show
through the anonymous search service `subtitlebot.com` publishes, lists the
entry's files with your own Jimaku API key (neither is needed to search), and
downloads one file for the episode that is playing. The file is kept on your
device and becomes that episode's track — transcript sidebar, look-ahead, and
precompute included. The search asks for the show rather than the episode: a
season the service wrote into the title is trimmed first, in any of the scripts
the services use, so `機動戦士ガンダム 水星の魔女 シーズン1` searches for
`機動戦士ガンダム 水星の魔女` and finds the entry the season-carrying name misses.

**A file on your device.** Downloaded the file yourself, or made it? Choose it in
the same card (or drag it onto it). LST reads it in the settings page, keeps it
on your device, and files it under the episode that is playing. No search, no
Jimaku key, no host permission, and no network request of any kind. SubRip
(`.srt`), WebVTT, and TTML are read, in UTF-8 or Shift-JIS; archives and ASS/SSA
are not readable yet.

Either way, a file the service never renders is still subtitled, because an
imported file carries its own timeline: the clock decides which line is on screen
rather than what the player draws.

If the file is already written in the language you want to read, LST shows it as
it is and **does not translate anything** — no model call, no cache entry. That
decision is made from the file's own language tag, or from its writing system
when it has none, and you can overrule it per import.

If a downloaded file is out of sync — common when it was cut for a different
release of the episode — the in-player **Timing offset** controls move that file's
own clock while it is in use: 30 s, 5 s, 1 s, and 0.1 s steps, ten minutes either
way, stored with the file and for that episode alone. The service's own track
keeps the global timing setting, which still applies on top of the file's own
correction.

Both hosts are optional permissions. LST asks for access to `jimaku.cc` and
`www.subtitlebot.com` the first time you press Search, never at install, and
never contacts either host unless you ask it to. Nothing about your viewing is
sent anywhere: the search carries a show name, and the download is a plain file
request. A file you choose from your own disk never touches the network at all.
See `docs/subtitle-import.md`.

### Knowing what LST is using, and what Jimaku holds

The player says where its subtitles come from. When an imported file is on
screen the LST controls carry an **Imported** chip, and the controls themselves
say which file it is and whether it is being translated. The same sentence is in
the toolbar popup, and the settings card lists every imported episode.

Searching Jimaku also leaves a **note about the show**, and LST reads it when you
open any episode of that show: the player shows a line saying what Jimaku held —
how many entries, or how many files for the episode you are on — so arriving at a
title tells you whether it is worth importing. The note is written by the search
you ran and read from your own device: **opening a page never contacts Jimaku**.
A note is forgotten after 60 days, and **Forget this** in the import card drops it
sooner.

Inside the LST controls, **Import subtitles…** opens the card for the episode you
are watching, and **Check Jimaku** asks about this show right there — one
anonymous search, on your click. It is the only request LST ever sends about a
show you merely opened: it is sent because you pressed the button, not because a
page loaded.

See `docs/subtitle-import.md`.

## Important limitation

Netflix and Prime Video are private, frequently changing web applications. On Netflix the robust path is:

1. Load a Netflix watch page.
2. Enable the **source subtitle language** you want translated.
3. The extension attempts to capture the TTML/WebVTT timed-text response Netflix loads for that track.
4. Once captured, use the extension popup → **Precompute episode subtitles**.

If Netflix changes its subtitle delivery or the timed-text response cannot be captured, the extension falls back to observing the rendered subtitle DOM and translating one cue at a time. That fallback cannot precompute unseen cues.

Prime Video delivers its timed text differently. Instead of handing the player one
document, the player first asks for the title's *playback resources*, and the
answer to that request lists every subtitle track the title carries. LST reads
that listing in the page's own world, takes the track the adapter names (Japanese
first, then the first subtitle track offered), fetches that one document there,
and parses it — so a Prime Video episode precomputes and replays from cache
exactly as a Netflix one does. The request is the page's own, carrying the page's
origin and cookies, so LST needs no CDN host permission for it and never asks the
background to fetch a subtitle URL.

If Prime's listing cannot be read, or the track it names cannot be fetched, the
same rendered-caption fallback keeps working: realtime translation of the line the
player is drawing, plus look-ahead over what has already been rendered. The reason
a listing produced no track is written to the event log.

**Moving to the next episode needs no reload.** A service asks for the next
episode's assets while the URL is often still the previous episode's, so the
document can arrive before LST has noticed the change and find a track already
loaded. LST holds the newest captured document rather than dropping it — the
request that carried it is made once and never repeated — and offers it to the
track that has just been emptied, to a player that swapped its episode without
moving the URL at all, where the line the player draws is what shows the held
document is the one being watched, or to a player that draws no line at all
(Prime's own captions off), where the clock is what shows it: a document captured
more than a minute into the item and offered while the player is back inside the
item's first minute belongs to the item that started after the capture. The same
rules that judge an arriving document judge a held one, and the event log says
which document was adopted and why (`held-document-adopted`), that it is the
track already on screen and so was dropped (`held-document-dropped`), that it
belongs to the episode LST has left (`held-document-other-episode`), or that it
was too old to be this episode's (`held-document-stale`).

**A track the player contradicts is not trusted again by silence.** LST renders a
captured track from the clock and uses the line the player draws only to confirm
it. A pause between lines is not a line that agrees with the track, so a
contradicted track stays contradicted until the player draws a line it holds —
which is what keeps the previous episode's cues from coming back on screen in the
gaps of the next episode.

**An episode is named the way Prime Video names it.** A Prime Video page can keep
the series in its address while the player advances from episode to episode, so
the address says which page you are on and not which episode you are watching.
The same playback-resources listing that names the subtitle tracks also names the
item being played — its own id, its title, its episode number, its season, and
the series the season belongs to — and LST uses that answer, so:

- each episode is cached, precomputed and counted on its own, and two episodes of
  one series are two entries in the translation library rather than one;
- the show is the show: the season a page appends to its own title
  (`機動戦士ガンダム 水星の魔女 シーズン1`, `Homeland - Season 2`) is what a later
  page calls the same show, not part of its name, so the library groups a show's
  episodes together and what you searched for on Jimaku is found again next
  season;
- the episode has a name of its own (`Episode 1 · The Smile`) instead of the video
  id standing in for one, and moving to the next episode is noticed even though
  the address never changes.

Nothing extra is requested for any of this: the listing is the page's own request,
read as it happens. A listing LST cannot read changes nothing — the address names
the episode again and the library says the service's name for the show — and the
event log records what was read as kinds and reasons, never the names themselves.

## Ollama setup

Check Ollama is running:

```bash
curl http://localhost:11434/api/tags
```

Pull a translation-capable model if needed, for example:

```bash
ollama pull translategemma:4b
```

Ollama requires browser extension origins to be allowed. For a manually launched Ollama server:

```bash
OLLAMA_ORIGINS=chrome-extension://*,moz-extension://* ollama serve
```

If Ollama is already running as a service on Linux, configure the environment variable on the service rather than launching another `ollama serve`.

A systemd override commonly looks like:

```ini
[Service]
Environment="OLLAMA_ORIGINS=chrome-extension://*,moz-extension://*"
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

You can narrow the origin later to this extension's specific `chrome-extension://<extension-id>` origin.

## Optional DeepSeek and Gemini setup

Open **Settings → General**, select **DeepSeek** or **Gemini**, enter your provider API key, and click **Save key**. Refresh models, choose a model, then click **Save changes**. The key is stored in browser extension storage on your device and can be removed from the same screen. Selecting a remote provider sends requested subtitle cues, and surrounding cues if context is enabled, to that provider's API. Requests may use your quota or incur charges. Switching back to Ollama restores your saved local model selection; existing Ollama caches remain usable.

LST connects directly to `api.deepseek.com` or `generativelanguage.googleapis.com` only when that provider is selected. It has no developer-operated translation server. DeepSeek and Gemini model names are discovered from their APIs, so available models are not hard-coded.

Advanced settings include an optional translation prompt editor. The editor shows the built-in prompt and lets you customize it for any provider; use `{{targetLanguage}}` to insert the selected target language. LST still appends the structured-output instruction needed to align batch translations, and **Restore original prompt** returns to the built-in behavior.

## First-run setup

Installing LST opens a **setup page** once. It walks through four steps and saves as you go, so closing it halfway keeps whatever you already chose:

1. **Welcome** — what LST does and what to have ready.
2. **Engine** — provider, Ollama URL or provider key, model list, and a model download field, plus the `OLLAMA_ORIGINS` command if the local connection is refused.
3. **Language** — target language, a live subtitle preview, and the subtitle layer switches (translator, the service's own subtitles, original text, translated text, translation verification, and one switch per supported service).
4. **Ready** — a summary of what will be saved, then **Save and finish**.

Reopen it any time from **Settings → Advanced → Environment → Reopen setup guide**. It opens automatically only on a fresh install; updates and reloads stay silent.

## Install in Firefox

For development/testing:

1. Run `npm run prepare:firefox`.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…**.
4. Choose `.firefox-build/manifest.json`.
5. The setup page opens automatically; if it does not, open the extension settings/options.
6. Confirm the model list and choose an installed Ollama model, then finish setup.
7. Open a watch page on Netflix or Prime Video and enable the source subtitle track.
8. Open the extension popup.
9. Once it says the full subtitle track is captured, click **Precompute episode subtitles**.

A temporary Firefox add-on is removed when Firefox exits. For permanent personal installation, package/sign it through Mozilla's normal add-on workflow.

Firefox keeps the manifest a copy of an add-on was **loaded** with, and only that manifest decides what the copy may ask for. After changing `src/manifest.json` (permissions included), run `npm run prepare:firefox`, then press **Reload** on the extension in `about:debugging`. A copy loaded before LST declared access to Jimaku reports **LST is running from a copy loaded before it declared access to jimaku.cc** when you press Search, and says to reload it.

## Install in Chrome / Chromium / Brave

1. Run `npm run prepare:chrome`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select `.chrome-build`.
6. The setup page opens automatically; if it does not, open the extension's **Details → Extension options**.
7. Confirm the model list, pick a target language, and finish setup.
8. Open the service and start an episode.
9. Enable the source subtitle track.
10. Open the extension popup.
11. If the popup says the full track was captured, click **Precompute episode subtitles**.

## How it works

```text
src/sites/playback-site.js
  └─ which service this page is, and every site-specific fact about it
       │
       ├─▶ src/page/page-hook.js   (page world)
       │     └─ observes fetch/XHR responses for TTML / WebVTT, tagged with the site
       │
       └─▶ src/content/index.js     (isolated world)
             ├─ parses timed cues
             ├─ syncs cue selection to the active <video>.currentTime
             ├─ renders the overlay
             └─ falls back to the service's rendered subtitle DOM
                    │
                    ▼
              src/background/index.js
                ├─ GET /api/tags
                ├─ POST /api/generate
                ├─ Jimaku search / file listing / download (only when asked)
                └─ chrome.storage.local cache
                    │
                    ▼
                   Ollama

subtitle-import.js
  └─ where a subtitle comes from when it did not come from the player:
     the two hosts and their request shapes, what a search result or a file
     listing says, which file belongs to which episode, SubRip and the bytes
     around it, and whether a file needs translating
       │
       └─▶ an imported file becomes the episode's track instead of a captured one
         (fetched from Jimaku, or read from the viewer's own disk — the second
          one makes no request at all)
```

## Translation behavior

The extension sends small batches of subtitle strings to the selected provider and requires a structured response shaped like:

```json
{
  "translations": [
    { "id": "cue-id", "text": "translated subtitle" }
  ]
}
```

If a model breaks the batch contract, the extension recursively splits the batch and retries smaller groups.

## Translation verification

A model can return the input instead of translating it. Rather than write that into the cache, LST checks every result against the selected target language before it is stored. The check compares writing systems, so a Japanese line returned for an English target, a romanized line, or output in an unrelated script is rejected instead of cached. A rejected line is sent once more on its own with the reason attached, and if it is still wrong it is reported as a failed cue rather than saved.

Verification is code, not a model call: it adds no requests, no network access, and no cost beyond one retry per rejected cue (capped at three retries per batch). It cannot judge a wrong language that shares the target's writing system, such as English output for a Spanish target, and it never judges an unrecognized target language or a line too short to compare. **Verify translations before caching** in Translation defaults turns the whole check off.

Entries already in the cache are checked the same way when they are read. A stored result that is not in the target language is skipped, so the cue is translated again and the new result replaces the stale one. Nothing is deleted from storage without your action, and the cache library in the Storage tab still lists what is stored.

## Good model choices

For Japanese → English, `translategemma:4b` is the initial default and a good lightweight starting point. LST still discovers every installed Ollama model dynamically, so you can choose a larger or different model whenever you prefer.

## Development notes

There is no bundler or compilation step. Browser preparation copies `src/` into a target-specific development directory and removes manifest fields unsupported by that browser.

Release packaging generates `.firefox-build` and `.chrome-build` from the shared Chromium/Firefox source manifest. Run `npm run package:all` to validate and build both store-ready archives. The preparation step removes fields unsupported by each target browser without changing unpacked development.

Useful files:

- `src/sites/`: playback-site detection and adapters
- `src/page/`: page-world timed-text capture
- `src/content/`: isolated-world player runtime, overlay, and styles
- `src/shared/`: pure and cross-context policies, parsing, identity, and translation helpers
- `src/background/`: provider communication, caching, storage, and message handling
- `src/ui/`: options, setup, and popup pages
- `tests/`: runtime and architectural contract tests
- `scripts/`: build, release, and package tooling

See [the architecture overview](docs/architecture/overview.md) and [site adapter guide](docs/architecture/site-adapters.md).

## Next improvements

- Detect and select among multiple captured subtitle tracks/languages.
- Store caches in IndexedDB with per-show metadata and LRU cleanup.
- Precompute starting near the current playback position before translating the rest.
- Add VTT/SRT export formats.
- Expand automated browser compatibility tests.
- Add a side panel showing the episode transcript and translation progress.
- Add model-specific translation prompt presets.

## v0.5.2 episode metadata

Cached translations record and display the Netflix show name and episode name separately. LST checks several player-title structures, recognizes episode markers such as `E50`, `Episode 50`, and `S1:E50`, and falls back to the current title's Netflix metadata page when the player hides its title UI. That fallback is a same-origin Netflix request and does not send subtitle text anywhere. Existing caches remain usable and gain richer names the next time their episode is revisited.

### How an episode is named

Names are decided in one place, `episode-identity.js`, so the page, the background, the popup and the cache list all agree. A name is either a real name or one of the placeholders Netflix renders when it has nothing better — `Netflix`, `Netflix - …`, `Netflix episode <id>`, `Episode <id>`, `Video <id>`, `Unknown episode`, `Episode details unavailable` — and the placeholders are recognized by shape, anchored to the whole name, so `Episode 5 · Pilot` is a real name while `Episode 5` alone is only the number with no title.

A real name always beats a placeholder, whichever side it arrives from, so a cache that has already found an episode name cannot lose it to a differently worded placeholder on a later visit. The name written when Netflix never tells us one is derived from the video id and is itself recognizable as a placeholder, so it can never be mistaken for a real title. The cache id remains the source of truth for the video, provider, model, and target language, because it is also the storage key: a cache that disagreed with its own key could not be found again.

The episode marker inside a title is found by ordered, named rules, and the title block embedded in Netflix's episode page is read from the object that holds the video id rather than from a fixed number of characters after it, so field order, whitespace, and distance are Netflix's business. Every decision and the reason for it — which rule matched, which name was kept or replaced, why a refresh was skipped — is written to the subtitle event log as kinds and reasons, never as the names themselves, so the log stays safe to share.

## Subtitle synchronization

LST checks that an asynchronously translated cue is still active before rendering it, preventing a slow response from replacing a newer subtitle. Cached translations are kept in the content-script session so a new cue can render synchronously, while Netflix's rendered-text fallback must remain stable briefly before it can replace the timed track.

Captured cues and Netflix-rendered text are matched by text identity rather than byte equality.
 LST folds the encoding and layout differences Netflix introduces while rendering the same line — typographic quotes, dashes, ellipses, full-width forms, zero-width and soft-hyphen characters, and line wrapping — then falls back to a punctuation- and case-insensitive comparison, and recognizes a line that Netflix renders as two adjacent cues joined into one block. A line that still matches several cues, such as a repeated short phrase, is resolved by playback time only while the timeline is already trusted; otherwise LST reports the ambiguity and keeps the visible-subtitle fallback instead of guessing, so a translation is never attached to the wrong cue. Netflix may also retain the previous cue during the timed track's gap before the next cue without invalidating synchronization. This prevents formatting differences and normal cue handoffs from causing false mismatches or subtitle flashes. LST still clears lingering lines during real subtitle gaps after a short grace period.

The Subtitles tab provides a −2000 ms to +2000 ms timing offset in 50 ms steps. Negative values show LST subtitles earlier and positive values delay them. The persistent Netflix pill offers quick −100 ms, reset, and +100 ms adjustments.

LST may capture several timed-text documents for the same episode, because Netflix can serve the same track again, serve a part of it, or serve a different representation entirely. Each captured document is classified by cue membership and time coverage rather than by cue count or duration. A document whose cues the current track already has is a fragment or a duplicate and never replaces it. A document that contains the whole current track is adopted without losing anything. A document covering a part of the episode the current track does not reach is added to it instead of replacing it. Anything else — a different track, a different representation of the same timeline, or a document that only partly overlaps — is adopted only when the line Netflix is rendering belongs to it, or while the current track has never been confirmed by Netflix's rendering; otherwise LST keeps the track it already has and says why. Adopted documents reuse the current track's own cue objects for the lines both documents already agree on, so cached translations and cache keys stay valid across a re-fetch, and a document that keeps every cue of the current track does not invalidate the synchronization Netflix has already confirmed for it. Every decision, and the reason for it, is written to the subtitle event log.

## Navigation and in-player controls

Settings is organized into General, Subtitles, Storage, and Advanced tabs so model setup, appearance, cached episodes, and diagnostics no longer compete in one long page.

The Advanced tab also includes a bounded local subtitle event log. It records cue lifecycle, synchronization, captured-document, episode-naming, cache, and translation events so brief subtitle clears can be diagnosed after playback. Captured-document events include how the document related to the track in use, which cues the two documents shared, whether the timeline was already confirmed, and whether the line Netflix was rendering belonged to the incoming document or to the current track. Episode-naming events include which marker rule matched, whether the show and episode names were real names or placeholders and why, where a name came from, what the episode-page lookup returned, and why a name refresh was skipped — as kinds and reasons, never as the names themselves, so the log stays free of page titles. Mismatch events include DOM selector/node counts, anonymous page-session text IDs, text lengths, folded/simplified/joined-line match results, how the line was resolved (unique, nearest, or ambiguous), whether the timeline was trusted enough to use playback time, nearby cue timing, offsets, rendered state, and resolution outcomes. Translation-context events include the reason context was chosen or skipped, how many reference lines were sent, where each one sat relative to the nearest requested line, how many were left out and why, and the limits the choice was made under — never the subtitle text. The log stays in extension storage, omits subtitle text and complete request URLs, and can be filtered, copied, exported, or cleared independently from translation caches.

An optional in-player transcript sidebar shows the complete captured subtitle track with locally cached translations as they become available. The current cue is highlighted and automatically scrolled into view; the sidebar can be toggled from Subtitle settings, the extension popup, or the compact Netflix player controls. The popup also exposes whether the compact in-player controls are visible, with direct shortcuts beside All settings.

Surrounding subtitle context is also opt-in, and how much of it travels with a request is the viewer's choice under **Settings → General → Context amount**: *Minimal* sends 1 line each side, at most 3 lines per request; *Standard* (the default) sends 2 lines each side, at most 6 lines per request; *Wide* sends 4 lines each side, at most 10 lines per request. The levels are declared once, in `translation-context.js`, and the options page builds the control and the sentence under it from that module — its names, its numbers, and the cutoff it states — so the page cannot offer an amount the module does not implement, and a stored value from another build resolves to the level LST would actually use. Which lines are sent is decided by the module from the cue timeline rather than from cue order: a candidate is judged by the silence between it and the nearest requested line, so a line that ends before its nearest requested line is labelled `before`, one that starts after it `after`, and one that overlaps it `overlapping`. A reference line is never taken across a silence longer than the level's own cutoff — 5, 8, or 12 seconds — because that is a scene break rather than a pause in the dialogue, and a 1200-character lyric is shortened to 240 characters instead of being sent whole. The per-request ceiling is shared between the requested lines, so a wide batch cannot spend the whole budget on its first cue and starve its last one. These lines are marked as reference-only so the model can resolve names, pronouns, and sentence continuity without returning extra translations. Every decision, and every line left out with the reason it was left out — too far from every requested line, past the per-request budget, or refused at the provider boundary — is written to the subtitle event log. Context can use more tokens and add latency, and enabling it does not replace translations that are already cached.

An optional persistent LST pill sits in a HUD whose corner is the viewer's choice in Settings (automatic by default, with each service supplying a starting corner). It shows Waiting, Ready, Realtime, Buffering, Cached, Precomputing, or Error status, and how much of the episode is loaded: the share of the episode's cues that are translated and cached, as a percentage beside the status and as a bar along the pill's bottom edge, with the same figure spelled out in cues when the panel is open. The share is the episode's own, so it climbs while an episode precomputes and does not reset when playback moves; how far ahead the cache reaches is a different question, and the pill answers that one in seconds next to it. The menu toggles the LST translation, LST original text, and the service's own subtitles. Informational notices stack below the pill rather than overlapping it.

## Subtitle customization, buffering, and cache management

Settings now includes a live preview and controls for:

- subtitle height from the bottom of the video
- left, center, or right alignment
- maximum line width
- separate original and translated font sizes
- subtitle background strength
- an optional in-player controls overlay for live adjustments
- independent switches to hide the service's own subtitles, show LST's original text, and show the translation
- optional top-left informational messages for capture, fallback, precompute, and errors

Saved appearance changes are pushed to open player tabs immediately. The optional in-player controls overlay saves adjustments as you make them and stays clear of the service's own controls. Settings can also pull an Ollama model by name and show its download progress. The detailed debug panel is off by default for new installs.

When the player enters browser fullscreen, LST moves its subtitle overlay and optional player controls into the active fullscreen container. This works on both services, because both use the standard Fullscreen API. They return to the page root when fullscreen closes, preserving the same subtitle state and appearance in both modes.

The Translated episodes section in Settings groups locally cached episodes under their show, then lists each model/language combination with its translated cue count, estimated storage use, and last update time. Each episode can be previewed as timestamp, original text, and translated text, or exported as a UTF-8 TSV file. When a timed track becomes available, LST promotes uniquely matched DOM-fallback translations onto their timestamped cues and removes the redundant fallback records. Repeated or unmatched fallback text is preserved for playback recovery but omitted from previews and exports whenever timestamped cues exist. Individual caches or the entire local translation library can be removed there. Older caches remain readable and are migrated when their episode is revisited.

When look-ahead is enabled, LST prepares every subtitle within the configured time window and the first cue after that boundary. The window cannot be set below 30 seconds. Optional top-left notices report when the buffer is being prepared, when it is ready, or when an upcoming cue could not be translated.


## v0.2 progress / reliability changes

- Precompute is now detached from the extension popup. Closing the popup does **not** stop the job.
- Popup shows:
  - exact cached cue count
  - percentage
  - current batch / total batches
  - current subtitle text being processed
  - elapsed time
  - failed cue count
  - last translation / last error
- Ollama requests now have a configurable timeout (default 75 seconds).
- Failed batches are recursively split. A single bad cue is recorded and skipped instead of freezing the whole episode.
- LST requests `think: false` from Ollama for lower subtitle latency.
- The rendered subtitle DOM remains an active fallback even after a full timed-text track has been captured. This fixes cases where a captured track translates successfully but its timestamps do not line up with the playing track.
- A Stop button stops precompute after the currently-running Ollama request completes.

### If progress repeatedly stalls on a batch

Try a smaller **Precompute batch size** such as `8` or `4`, especially with smaller/translation-focused local models. The default request timeout is `75` seconds and can be changed in Settings.


## v0.3.0 diagnostics and Qwen ID recovery

v0.3.0 addresses the confusing error:

```text
Expected 1 translations, received 1
```

That could happen when a model returned the correct number of translations but rewrote LST's opaque subtitle cue IDs. LST now:

1. uses exact returned IDs when they match;
2. recovers positionally when the number/order of translations is correct;
3. falls back to a plain single-subtitle translation request if structured output still fails.

### Pinned debug panel

Settings now includes:

- **Show detailed LST debug panel**
- **Keep debug panel pinned in the top-right corner**

The panel displays model, cache progress, precompute batch, request time, translated/failed count, structured-vs-fallback mode, playback mode, video/cue timing, in-flight request count, timed-text source, current subtitle, last translation, returned IDs, raw Ollama response, verification result, and the latest error.

The panel is a separate `position: fixed` element with page-level maximum z-index so subtitle-container transforms do not move it.
