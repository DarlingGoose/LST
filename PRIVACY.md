# LST Privacy Policy

Effective date: September 12, 2026

LST — Local Subtitle Translate does not collect, sell, or transmit user data to the developer, advertisers, analytics providers, or other developer-operated services.

## Data processed

To provide subtitle translation, LST reads subtitle text from supported Netflix pages and sends that text to the Ollama endpoint configured by the user. The default endpoint is `http://localhost:11434`, which runs on the user's own device. If the user changes the endpoint, subtitle text is sent to that configured endpoint instead.

LST stores its settings, translated subtitle text, subtitle cache identifiers, and translation diagnostics in Firefox extension storage on the user's device. This local storage makes repeat playback faster and preserves the user's preferences.

## Data not collected

LST does not include analytics, telemetry, advertising, tracking, or a developer-operated backend. The developer does not receive subtitle text, browsing history, settings, cached translations, or diagnostic information.

## User control

Users choose whether LST is enabled, choose the Ollama endpoint, and can clear locally cached translations from the extension's Settings page. Removing the extension also removes data managed by Firefox for the extension.

## Changes

Material changes to this policy will be documented in the project repository and reflected in the policy supplied with future releases.

## Contact

Questions and privacy reports can be submitted through the project's GitHub issue tracker: <https://github.com/DarlingGoose/LST/issues>.
