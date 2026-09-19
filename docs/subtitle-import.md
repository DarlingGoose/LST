# Importing subtitles

LST can use a subtitle file instead of translating the service's own track — and
instead of translating anything at all when the file is already written in the
language the viewer wants to read.

This document records what the feature does, which hosts it contacts, what was
verified by hand against those services, and what is deliberately left out.
## Why

A service does not always subtitle what it streams. Japanese Prime Video
catalogues often carry no English track, and Netflix Japan carries some titles
with Japanese captions only. LST's answer to that was "translate the Japanese
track", which still requires the service to subtitle the title in the first
place, and requires a model call for every line.

A file from a subtitle archive removes both requirements. The file states its own
timeline, so the player does not have to render anything for LST to know which
line is being said — which also means an imported track gives Prime Video a full
track (precompute, transcript sidebar) without waiting for its timed text to be
proven capturable.

## Where the files come from

A file arrives one of two ways, and both end at the same record.

**Fetched from Jimaku.** The viewer searches for the show, chooses the entry,
lists its files with their own API key, and downloads one.

**Read from the viewer's own device.** The viewer already has the file — they
downloaded it from Jimaku's site by hand, or made it themselves — and picks it in
the same card (or drops it on it). Nothing is fetched: the options page reads the
file with a standard file input, asks `subtitle-import.js` what encoding the
bytes are in, and sends the text to the background, which files it under the
episode that is playing. No host permission, no API key, no request. A background
test asserts that the request count does not change when this path runs, and that
it never touches the Jimaku key.

### The endpoints, for the fetched path

| Step | Endpoint | Authentication |
| --- | --- | --- |
| Find the show | `https://www.subtitlebot.com/api/jimaku/search?query=…&limit=50&anime=true` | none |
| List an entry's files | `https://jimaku.cc/api/entries/{id}/files?episode={n}` | the viewer's own Jimaku API key, `Authorization` header |
| Download one file | the `url` the listing returned, e.g. `https://jimaku.cc/entry/1811/download/…` | none |
| Open the entry by hand | `https://jimaku.cc/entry/{id}` | none |

The search is `subtitlebot.com`'s anonymous proxy, which is the step that needs
no account; its own interface searches there and then sends the viewer to
Jimaku, which is the same shape LST follows. Everything after that is Jimaku's
documented API (`https://jimaku.cc/api/openapi.json`), and only listing an
entry's files needs a key. Download URLs are public and served with
`access-control-allow-origin: *`.

Verified by hand on 2026-09-18:

- the search payload (ids, `english_name`, `japanese_name`, `notes`, `flags`,
  `anilist_id`) and that it needs no account or key;
- that the file listing answers `401` without a key, and that a download does
  not;
- a real `.srt` from entry 1811, including its byte-order mark and `\r\n` line
  endings, at `https://jimaku.cc/entry/1811/download/<urlencoded name>`;
- that entry 1811 lists its files publicly in its HTML, which is why LST's own
  download needs no key.

Taken from Jimaku's published schema (`/api/openapi.json`) rather than from a
live call, because a key is needed to make one:

- the shape of a file listing: `[{ url, name, size, last_modified }]`;
- the `?episode=N` filter, described as a best-effort guess based on the file
  name — which is why LST also reads the episode number out of the name itself
  and does not rely on the filter;
- the `Authorization` header carrying the key.

The reader tolerates both: a listing entry without a usable URL is skipped, a
file URL that leaves `jimaku.cc` is refused rather than fetched, and a file whose
name states no episode is offered as a candidate rather than assumed.

### What the query is

The query is the show, not the episode, because Jimaku files one entry per show
or season and the same search serves every episode of it. A service states the
season inside the show's own name, so `queryFromShowName()` trims a trailing
season or episode marker before the search is sent — the same words in the three
scripts the services write them in:

| Written as | Trimmed |
| --- | --- |
| `Mobile Suit Gundam: The Witch from Mercury Season 2`, `… - Season 2`, `… S01E04`, `… Episode 4`, `… - 4` | to the show's name |
| `機動戦士ガンダム 水星の魔女 シーズン1`, `… 第2期`, `… 2期`, `… 第2クール`, `… パート2`, `… 第2季` | `機動戦士ガンダム 水星の魔女` |
| `機動戦士ガンダム 水星の魔女 第1話`, `… 4話`, `… 第4回`, and any episode title after it | `機動戦士ガンダム 水星の魔女` |
| `Show (Season 2)`, `Show（第2期）`, `Show (第3話)` | `Show` |

This is not cosmetic: `機動戦士ガンダム 水星の魔女 シーズン1` finds nothing, while
`機動戦士ガンダム 水星の魔女` finds the entry, because the entry is filed under the
bare name. Both the import card's search and the player's **Check Jimaku** button
ask this module, so the two cannot trim differently.

Two rules keep it safe. A pattern is never allowed to empty the query, so a show
actually called `第2期` or `シーズン1` is still searched for as itself; and a word
that only looks like a marker is left alone — `進撃の巨人 完結編` and
`鬼滅の刃 無限列車編` keep the `編` that names them, because `編` follows no number.
The separator a marker leaves behind goes with it (`Show - 第2期` → `Show`), and a
name that is nothing but punctuation is reported as no name at all.

## Reading the bytes, and knowing what the file is

Both paths hand their text to `describeTextTrack()`, which is the one owner of
the question "is this usable as an episode's track, and what will LST do with
it". Neither path can decide the language, or whether to translate, differently
from the other. It refuses, with a reason each:

- empty text (`track-text-empty`);
- text larger than 8 MB (`track-text-too-large`);
- a named format LST cannot read, such as `.zip` or `.ass`
  (`track-format-unsupported`) — checked *before* a download starts, so an
  unreadable file is never fetched;
- a name with no recognizable extension (`track-format-unknown`);
- a `.srt` that holds no readable cues (`track-has-no-readable-cues`);
- a WebVTT or TTML file whose text is not timed text at all
  (`track-is-not-timed-text`) — LST parses SubRip itself, and content.js parses
  WebVTT and TTML, so this is the module's own sanity check rather than a second
  parser.

`background.js` turns each of those reasons into one sentence, and a test fails
if a reason ever appears without a sentence.

A file is bytes before it is text, so `decodeSubtitleBytes()` decides the
encoding: UTF-8 strictly first, then Shift-JIS (which is what a file packaged for
a Japanese release is often written in) if it reads every byte without a
replacement character of its own, then UTF-8 leniently, and otherwise it reports
`undecodable-subtitle-file` rather than filling the subtitle with replacement
characters. A file in some third legacy encoding (Windows-1252, say) is not
detected and may show replacement characters; that is a known limit.

Finally, the file's own episode number is compared with the number the page
states, and a mismatch is **reported, never refused**
(`episode-mismatch`, with both numbers) — the viewer chose the file, and a
release may number its episodes differently from the service. It is not part of
the remote path's *recommendation* logic (`chooseFileForEpisode`, which ranks)
but a note attached to whatever was imported, from either source.

## What is stored, and where

`importedTracks` in `browser.storage.local`, keyed by **episode key** —
`8123` on Netflix, `primevideo~B0B6GZ954Y` on Prime Video (`episode-identity.js`
owns that spelling). The cache id is not used as the key because it also names
the model and the target language, and changing either must not lose the file.

Each record holds the file's text verbatim plus the facts needed to describe it:
entry id and name, file name and URL, size, format, language, cue count, when it
was imported, whether it needs translating with the reason for that answer, and
the correction the viewer made to where its timeline sits on the video's clock
(`timingOffsetMs`, ten minutes either way).
`source` says where the file came from (`jimaku-download` or `local-file`); a
record stored before that field existed is read as a Jimaku download, which was
the only way in. Storage is capped at 500 imported episodes (oldest first), and
Settings → Subtitles → Import subtitles lists every imported episode with its
size, where it came from, and a Remove button.

## How the track plays

`content.js` asks for the current episode's import when playback starts, when the
episode changes, and when an import is added or removed elsewhere. An imported
track replaces the captured one:

- captured documents are refused while an import is in use (`subtitle-track-ignored`,
  reason `imported-track-in-use`);
- the DOM fallback stops reading the service's captions, so the service's line
  cannot appear next to the imported one;
- the timeline comes from the file, so nothing has to be validated against what
  the player draws. What the viewer corrects is the distance between the file's
  clock and the video's, and that correction belongs to the file — see below;
- the transcript sidebar, precompute, look-ahead, and paused caching all work
  from the imported cues, because they are ordinary cues.

Whether the service's own captions stay visible is unchanged by an import: that
is the "Hide the service's own subtitles" setting, which is on by default. With
it off, both the imported subtitle and the service's caption are drawn.

## When the file does not line up with the video

A file states when each of its lines is spoken, and a file made for another
release of the same episode states it somewhere else: a different cut, a recap
the file does not have, a broadcast master against a streaming one. The distance
is usually the same from beginning to end, and it is usually much larger than the
100 ms steps the timing controls offer — a file for another release is minutes,
not milliseconds, away.

Because LST renders an imported file from its own timeline, that distance has to
be expressible, and it belongs to the file rather than to one setting:

| | |
| --- | --- |
| Stored | with the file, `timingOffsetMs`, keyed by episode key |
| Range | ten minutes either way |
| Steps | 30 s, 5 s, 1 s, 0.1 s, and Reset |
| Moved by | the player's **Timing offset** section and the popup's, while an imported file is in use |
| Stored by | `SET_IMPORTED_TRACK_TIMING`, applied in place |

- Two files for two episodes are two distances, so correcting one never moves the
  other. A file further than ten minutes out is a file for another title, and the
  panel says at the limit that LST has gone as far as it will.
- The global **Timing offset** setting keeps its meaning: it is what the service's
  own track is tuned with, and the player's timing controls move it when no
  imported file is in use. Both panels ask `timingTargetFor()` which clock they
  move, so they cannot point at different ones.
- While a file is in use the global setting still applies on top of the file's own
  correction, and the panel says so rather than leaving a viewer to wonder why the
  file is still off by what they set.
- A press is written straight to storage and applied at once: the line under the
  viewer's eyes moves, and the file is not re-read. A newly imported file starts
  in step, because a correction belonged to the file the viewer replaced.
- The import card in settings lists the correction for every imported episode, so
  it can be seen without watching.

What this cannot do: a file for a **re-cut** episode, where the distance changes
partway through, is not fixed by any single number. The answers are a file for the
release being watched, or a re-timed copy — and an automatic alignment is not
available either, because it would need the service to render a comparable line,
which is exactly the case an import exists to cover.

## When nothing is translated

Importing a file the viewer can already read is the case the feature exists for,
so it must cost nothing. The decision is made once, when the file is imported,
and stored with it:

1. the file names a language and it is the target language (by name or by code,
   including qualified names like "Brazilian Portuguese") → show it as it is;
2. both are known and different → translate;
3. the file names no language: the writing system decides, when the target
   language has one LST knows (`こんにちは` is Japanese; `Hello` is Latin);
4. anything else is translated, because reading a subtitle in a language nobody
   checked is worse than translating one that was already readable.

The viewer can overrule the decision when importing (`Show it as it is, never
translate it` / `Always translate it`); that choice is recorded as
`viewer-choice` and survives a target-language change, while a decision LST made
is made again when the target language changes.

A track that needs no translation never reaches a provider: no realtime request,
no look-ahead, no paused caching, and precompute reports that there is nothing to
do. It is also not written to the translation cache, because there is nothing to
cache.

## What the player says, and what it remembers about a show

An imported file is a different thing from the service's own captions, so the
player says which one is on screen rather than leaving the viewer to open a
settings page:

- an **Imported** chip on the LST controls while an imported track is in use;
- a line in the controls naming the file, and saying whether it is being
  translated or shown as it is (`already English, so it is shown as it is`), with
  the file in use taking precedence over anything about Jimaku;
- one button that opens the import card for the episode being watched, and one
  that asks Jimaku about this show.

A **finding** is the second thing the player knows. It is what Jimaku held for a
show when LST last asked, kept in `jimakuFindings` in `browser.storage.local`,
keyed by **show key** (`episode-identity.js`: the service's name for the show,
lower-cased and reduced to letters and digits — `the-witcher`,
`primevideo~the-witcher`). It is keyed by show and not by episode because the
question it answers — *does Jimaku have subtitles for this?* — is a question
about the show, and the viewer asks it again on the next episode.

A finding is written by the one thing that may ask, which is the viewer:

- a search writes how many entries Jimaku listed for that query, and when
  (`search-found-entries`, or `search-found-nothing`);
- listing an entry's files sharpens it with that entry's name and how many files
  it has for the episode being watched (`files-listed-for-episode`, or
  `entry-has-no-files`);
- a finding more than 60 days old is dropped rather than used, because the
  listing behind it has probably changed;
- **Forget this** in the import card deletes it, and the player stops saying it.

`describeJimakuFinding()` is the one owner of what a finding means, and the
player, the popup and the settings card all read their sentence from it. Without
a clock the date is stated instead of an age, so a caller that has no clock still
gets a sentence rather than a guess.

**Nothing is fetched on arrival.** Reading a finding is a local read
(`GET_JIMAKU_FINDING`), and the message the player sends to get one is asserted
by test to be the only thing it sends when an episode starts. The single request
LST sends about a show the viewer only opened is the one behind **Check Jimaku**,
and it is sent because a button was pressed.

The sentence itself outlives the status line, which every other message replaces
(often within a second of arriving), so it is drawn in its own element with its
own dismiss button. It is never drawn while an imported file is in use, and it
follows the "Show info messages" setting, so a viewer who wants quiet gets quiet.

## Permissions

Both hosts are `optional_host_permissions`, not required ones:

```json
"optional_host_permissions": [
  "https://jimaku.cc/*",
  "https://www.subtitlebot.com/*"
]
```

Nothing is granted at install, nothing is granted on upgrade, and the options
page asks for both the first time a viewer presses Search. LST fetches neither
host unless the viewer asks for an import, and every URL it fetches is one
`subtitle-import.js` produced: a file URL that leaves `jimaku.cc` is refused
(`file-url-off-origin`) rather than fetched, so a listing cannot send the
extension somewhere it has no permission to go.

The second way in needs none of this: a file the viewer picks from their own disk
is read by the options page itself, so that path works with both hosts ungranted
and contacts nothing.

A browser grants an optional host only if the manifest it parsed **at load time**
declared it, and Firefox keeps that manifest for the life of the load: a copy of
LST loaded before these two hosts were declared is refused with the browser's own
words. The options page therefore reads the manifest it is really running under
(`runtime.getManifest()`, accepting hosts declared under `optional_permissions`
as well) and answers with one sentence naming the host and saying to reload the
extension. In practice this only bites a development copy whose manifest changed
while it stayed loaded — pressing **Reload** in `about:debugging` is the fix.

**Check Jimaku** inside the player's controls sends the same search the import
card sends, from the same module endpoints, and only when the viewer presses it.
It reports a refused request in the card's own words, so a viewer who has not
granted the two hosts yet is sent to the place that asks for them.

The Jimaku API key is stored like a provider key, not like a preference: it is
written by its own message, never by a settings save, never returned by
`GET_SETTINGS`, and never included in diagnostics.

## Deliberately not done yet

- **Whole-season import.** One file is attached to the episode that is playing.
  Matching a season's files to a season's episodes needs an episode-number →
  video-id mapping that LST does not have.
- **Formats other than SubRip, WebVTT, and TTML.** ASS/SSA and archive files are
  listed and marked as unreadable rather than offered and then failing. A `.zip`
  the viewer picked from their own disk is refused with the same sentence, since
  unpacking it is a conversion LST does not do.
- **Legacy encodings other than Shift-JIS.** UTF-8 and Shift-JIS are read; a file
  in Windows-1252 or another legacy encoding may show replacement characters
  rather than being detected.
- **Automatic timing alignment.** A correction is made by the viewer, in the
  player, and stored with the file. Measuring the distance automatically would
  need a reference: the service's own track, rendered or captured, which is
  exactly what an import exists to replace. Correlating two tracks' cue
  boundaries across languages is not a signal LST trusts yet.
- **Stretching a file to a different frame rate.** The correction is a constant,
  so a file whose lines drift further apart towards the end of an episode (a
  23.976 ↔ 25 fps difference) is better at the start than at the end. Two
  anchors and a rate would fix that; one distance is what the common case needs.
- **A file for a re-cut episode.** Where the distance changes partway through, no
  single number helps; see above.
- **Shifting an import to another episode.** Removing and re-importing is the way
  today.
