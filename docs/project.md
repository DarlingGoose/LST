# LST — Local Subtitle Translate

**LST** stands for **Local Subtitle Translate**.

A local-first browser extension for translating Netflix subtitles through Ollama.

## Core goals

- Keep subtitle translation local.
- Let the user select any installed Ollama model.
- Support realtime translation.
- Support precomputing a full subtitle track before playback.
- Cache translated subtitle cues locally.
- Remain usable even if Netflix's full timed-text track cannot be captured.

## Current platform support

- Firefox
- Chrome / Chromium
- Brave

## Current target

Netflix is the first supported streaming site. The architecture is intentionally separable so other subtitle-based sites can be added later.


## Current version

v0.5.2 enriches cached episode records with separate Netflix show and episode names while retaining compatibility with older caches.
