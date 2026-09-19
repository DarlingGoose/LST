# LST Privacy Policy

Effective date: September 16, 2026

LST — Local Subtitle Translate does not collect, sell, or transmit user data to the developer, advertisers, analytics providers, or other developer-operated services.

## Data processed

To provide subtitle translation, LST reads subtitle text from supported Netflix and Prime Video pages and sends it to the provider selected by the user. Ollama at `http://localhost:11434` remains the default, so translation stays on the user's device by default. If the user selects DeepSeek or Gemini, subtitle text and any enabled surrounding subtitle context are sent directly from the extension to that provider's API. The provider may process or retain this content under its own terms and privacy policy. A user-configured Ollama endpoint may also be remote.

If the user imports a subtitle file (Settings → Subtitles → Import subtitles), LST searches for the show through the anonymous search service published at `www.subtitlebot.com`, lists the chosen entry's files at `jimaku.cc` using the user's own Jimaku API key, and downloads one subtitle file from a URL that Jimaku publishes. The search carries the show name the user typed; nothing about the page being watched, and no subtitle text, is sent with it. These two hosts are optional permissions that LST requests the first time the user imports, and LST contacts neither host unless the user asks it to.

LST stores its settings, optional provider API keys, imported subtitle files, what Jimaku held for a show it was asked about, translated subtitle text, subtitle cache identifiers, and translation diagnostics in browser extension storage on the user's device. API keys are used only to authenticate requests to the selected provider or to Jimaku and are not included in streaming-service page messages or translation diagnostics. This local storage makes repeat playback faster and preserves the user's preferences.

Imported subtitle files are kept on the user's device and can be removed individually in Settings → Subtitles → Import subtitles. A file that is already written in the user's target language is displayed without being sent to a translation provider at all.

A search for a show on Jimaku also leaves a note about that show — what Jimaku held for it, and when LST asked — stored on the user's device so the player can say what exists without contacting anyone when the show is opened again. The note names the show and the Jimaku entry, and it is never sent anywhere; it expires after 60 days, and **Forget this** in the import card removes it immediately. Opening a title never contacts Jimaku: LST asks only when the user presses Search in the import card or **Check Jimaku** in the player's controls.

A subtitle file the user already has on their own device can be imported instead of downloaded. LST reads that file in its own settings page and stores it locally; importing it makes no network request and requires no host permission. If the user has asked for the file to be translated, its text is sent to the selected translation provider exactly as any other subtitle text is — nothing else about the file, and no information about where it came from, is sent with it.

## Data not collected

LST does not include analytics, telemetry, advertising, tracking, or a developer-operated backend. The developer does not receive subtitle text, browsing history, settings, cached translations, or diagnostic information.

## User control

Users choose whether LST is enabled, choose the translation provider and Ollama endpoint, remove saved provider API keys, and clear locally cached translations from the extension's Settings page. Removing the extension also removes browser-managed extension data.

## Changes

Material changes to this policy will be documented in the project repository and reflected in the policy supplied with future releases.

## Contact

Questions and privacy reports can be submitted through the project's GitHub issue tracker: <https://github.com/DarlingGoose/LST/issues>.
