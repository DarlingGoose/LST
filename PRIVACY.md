# LST Privacy Policy

Effective date: September 16, 2026

LST — Local Subtitle Translate does not collect, sell, or transmit user data to the developer, advertisers, analytics providers, or other developer-operated services.

## Data processed

To provide subtitle translation, LST reads subtitle text from supported Netflix pages and sends it to the provider selected by the user. Ollama at `http://localhost:11434` remains the default, so translation stays on the user's device by default. If the user selects DeepSeek or Gemini, subtitle text and any enabled surrounding subtitle context are sent directly from the extension to that provider's API. The provider may process or retain this content under its own terms and privacy policy. A user-configured Ollama endpoint may also be remote.

LST stores its settings, optional provider API keys, translated subtitle text, subtitle cache identifiers, and translation diagnostics in browser extension storage on the user's device. API keys are used only to authenticate requests to the selected provider and are not included in Netflix page messages or translation diagnostics. This local storage makes repeat playback faster and preserves the user's preferences.

## Data not collected

LST does not include analytics, telemetry, advertising, tracking, or a developer-operated backend. The developer does not receive subtitle text, browsing history, settings, cached translations, or diagnostic information.

## User control

Users choose whether LST is enabled, choose the translation provider and Ollama endpoint, remove saved provider API keys, and clear locally cached translations from the extension's Settings page. Removing the extension also removes browser-managed extension data.

## Changes

Material changes to this policy will be documented in the project repository and reflected in the policy supplied with future releases.

## Contact

Questions and privacy reports can be submitted through the project's GitHub issue tracker: <https://github.com/DarlingGoose/LST/issues>.
