# Notes for Mozilla Add-ons reviewers

LST translates Netflix and Prime Video subtitle text using an Ollama instance operated by the user by default. DeepSeek and Gemini are optional providers selected in Settings. Version 0.5.7 also includes an advanced user-editable translation prompt with a restore-original control, automatic look-ahead caching across episode changes, and no translation work on browse or storefront pages. LST is not affiliated with, endorsed by, or sponsored by Netflix or Amazon.

## Test setup

1. Install Ollama from <https://ollama.com/>.
2. Start Ollama at `http://localhost:11434`.
3. Configure `OLLAMA_ORIGINS` to allow the Firefox extension origin.
4. Install the default model with `ollama pull translategemma:4b`, or use the model download field in LST Settings.
5. Open a Netflix watch page using a test account and enable a subtitle track.
6. Open LST Settings, refresh the model list, select the installed model, and save.

Netflix requires an account and may not expose the same timed-text format for every title or region. If a full timed-text track is unavailable, LST falls back to observing the subtitle text the player is currently rendering.

Prime Video requires an Amazon account. Prime Video delivers its timed text as a listing of a title's assets rather than as a document, so the page hook reads that listing, takes the subtitle track the adapter names and fetches that one document in the page's own world, giving LST the whole episode's cues and the same precompute, cache and transcript it has on Netflix. If no track can be read or fetched, LST falls back to the caption spans the player draws and translates the visible line, one cue at a time. Prime Video is supported on `www.amazon.co.jp`, `www.amazon.com`, and `www.primevideo.com`; each service can be switched off independently in Settings.

## Implementation details

- `page-hook.js` runs in the page's main world to observe the streaming service's `fetch` and `XMLHttpRequest` responses that contain TTML or WebVTT timed text. It tags each captured document with the service it came from, and `content.js` refuses a document captured for a different service. On Prime Video it also reads the playback-resources response listing the title's subtitle tracks, and fetches the one document it names — again in the page's own world, with the page's own origin and cookies, using the page's `fetch`. Because every request and every capture happens in the page world, the extension never fetches a subtitle asset itself and needs no permission for any subtitle CDN host.
- `playback-site.js` holds the site-specific facts for each supported service (playback URL shapes, the active `<video>` element, how a caption line is rendered, page-title boilerplate, the CSS that hides native captions, the timed-text URL shapes the page hook watches, and the asset listing that names a title's subtitle tracks along with how one is chosen). It is static, declarative data: no fetched behavior, no remote code.
- `content.js` parses and displays subtitle cues and sends translation requests to `background.js`.
- `background.js` sends subtitle text to the selected provider: the user-configured Ollama endpoint, `https://api.deepseek.com`, or `https://generativelanguage.googleapis.com`. The default is local Ollama at `http://localhost:11434`; remote providers require the user to add an API key and select them.
- The two remote host permissions are limited to these provider API hosts. No provider SDK or remote code is loaded.
- Prime Video support adds no host permission. Capture and caption reading happen through `content_scripts.matches` and the page world, and the extension refuses to read a tab's URL, so no `tabs` or Amazon host permission is requested.
- Imported subtitles are the extension's only other network access, and every part of it is user-initiated. `subtitle-import.js` owns the two hosts: the search is the anonymous proxy published at `https://www.subtitlebot.com/api/jimaku/search`, and the file listing and download are `https://jimaku.cc/api/entries/{id}/files` and the public download URL that listing returns. Both hosts are declared as `optional_host_permissions` and are **requested the first time a viewer presses Search** — they are not in `host_permissions`, so nothing is granted at install or on upgrade. A file URL that leaves `jimaku.cc` is refused rather than fetched, so a listing cannot widen that access.

- A subtitle file the viewer already has on disk is imported through a second path that touches neither host: the options page reads the file the viewer picked (`<input type="file">`) and sends the text to the background, which stores it. That path calls neither `fetch` nor `importFetch`, involves no host permission and no API key, and works with both optional hosts ungranted — the background test asserts that no request is made. The file picker is the only new surface, and it is a standard file input on an extension page: it cannot read anything the viewer did not choose.
- The Jimaku API key, when a viewer supplies one to list an entry's files, is stored exactly like the DeepSeek and Gemini keys: written by its own message, never written by a settings save, never returned by `GET_SETTINGS`, and never included in diagnostics.
- An imported subtitle file is stored locally in `storage.local`, keyed by episode, and listed with its size and a Remove button. A file that is already written in the viewer's target language is displayed without being sent to any translation provider, which the options page states before the file is imported.
- A search also leaves a note in `storage.local` about the **show** — how many entries Jimaku listed for it and when — so the player can say what exists without contacting anyone when the viewer opens another episode of that show. Reading it is a local storage read, never a request: **opening a page cannot contact Jimaku**, and the only request LST sends about a show the viewer merely opened is the one behind the viewer's own "Check Jimaku" button. A note expires after 60 days and the import card's "Forget this" removes it at once.
- `storage` and `unlimitedStorage` hold user settings, imported subtitle files, notes about what Jimaku held for a show the viewer searched for, and episode translation caches locally.
- The extension contains no telemetry, analytics, advertising, tracking, remote executable code, or developer-operated backend.
- The extension is readable vanilla JavaScript, HTML, and CSS. It has no bundling, transpilation, minification, generated application code, or runtime third-party libraries.

## Testing subtitle import

An import needs a subtitle archive entry and, to list its files, a free Jimaku
API key from <https://jimaku.cc/account>. Importing is optional and the rest of
the extension works without it.

1. Open a Netflix or Prime Video watch page and start playing an episode.
2. Open LST Settings → Subtitles → Import subtitles.
3. Press Search: the browser should ask for access to `jimaku.cc` and
   `www.subtitlebot.com`, and only then. Type a show name first, e.g.
   `The Witch from Mercury`, and search again.
4. Choose an entry, save a Jimaku API key if asked, and list its files.
5. Import a file and watch the player: the imported cues replace the service's
   track, and a file already in the target language is displayed without any
   request to Ollama or another provider (visible in the debug panel, which
   reports the decision and its reason).
6. Choose a file from your own disk in the same card (or drag one onto it): it is
   imported with no permission prompt and no request. A file naming another
   episode is imported with a note saying so, not a refusal.
7. Remove the import in the same card; the player returns to the service's own
   track without a reload.

### The second path: a file already on the device

The same card also takes a file the viewer already has, by picker or by dropping
it on the card. Reviewer notes for that path:

- it needs no Jimaku key, no entry, no permission prompt, and no granted host —
  it works with both optional hosts refused;
- no request is made for it at all (the background test asserts the request count
  is unchanged), because the file is read in the options page and only its text
  is handed to the background;
- the file is read with the standard file input API, so nothing can be read that
  the viewer did not explicitly choose; dropping a file anywhere else on the page
  is cancelled rather than navigated to;
- the text is stored in `storage.local` like any other imported track, appears in
  the same list, and is removed the same way;
- refusals (an archive, ASS/SSA, a file with no subtitle timings, an empty or
  oversized file) each produce one sentence naming what is wrong, and nothing is
  stored.

The `websiteContent` data transmission declaration covers subtitle text sent to the selected provider. See `PRIVACY.md` for the user-facing policy.
