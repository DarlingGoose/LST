# Contributing to LST

Thanks for considering contributing to **LST — Local Subtitle Translate**.

LST is a privacy-first browser extension for translating Netflix subtitles locally with Ollama. Contributions are welcome, including bug fixes, documentation, UI improvements, model/runtime support, subtitle parsing improvements, performance work, and support for additional streaming services.

## Before you start

For substantial changes, please open an issue first so we can discuss the approach before you spend a lot of time implementing it.

Small bug fixes, documentation corrections, and straightforward cleanup can usually go directly to a pull request.

## Development setup

Requirements:

- Node.js 22 or newer
- npm
- Firefox and/or a Chromium-based browser
- Ollama running locally for translation testing

Install dependencies:

```bash
npm ci
```

Run project checks:

```bash
npm run check
```

For Firefox development, load the extension temporarily from:

```text
about:debugging#/runtime/this-firefox
```

For Chromium development:

1. Open `chrome://extensions`
2. Enable Developer mode
3. Choose **Load unpacked**
4. Select the repository directory

## Ollama

LST defaults to:

```text
http://localhost:11434
```

Verify Ollama with:

```bash
curl http://localhost:11434/api/tags
```

Browser extension origins may need to be enabled using `OLLAMA_ORIGINS`.

## Making changes

Please:

- Keep changes focused on one problem or feature when practical.
- Avoid unrelated formatting or refactoring in the same pull request.
- Keep Firefox and Chromium compatibility in mind.
- Preserve LST's local-first/privacy-first behavior.
- Do not add telemetry, analytics, tracking, or external services without discussing it first.
- Do not introduce remote executable code.
- Avoid adding permissions or host permissions unless they are necessary for a clearly defined LST feature.

## Testing

Before opening a pull request, run:

```bash
npm run check
```

If your change affects subtitle playback or translation behavior, test the relevant paths such as:

- realtime translation
- subtitle look-ahead/buffering
- cached translations
- subtitle timing
- hiding/showing Netflix and LST subtitles
- seeking/playback synchronization

If your change is browser-specific, mention which browser/version you tested.

## Pull requests

A good pull request should include:

- what changed
- why it changed
- how you tested it
- screenshots or recordings for visible UI changes
- any known limitations or follow-up work

## Feature ideas

Areas where contributions are especially welcome include:

- additional local model runtimes
- improved translation prompts/context handling
- additional streaming platforms
- subtitle export/import
- language-learning features
- performance and caching improvements
- Firefox/Chromium compatibility
- accessibility
- documentation

## Reporting bugs

Use the bug report template and include:

- browser and version
- operating system
- Ollama version
- model used
- LST version
- whether realtime or precomputed translation was being used
- console/debug output when relevant

Remove personal information, authentication tokens, cookies, and other secrets before posting logs.

## Security issues

Do **not** report security vulnerabilities through a public issue. Follow [SECURITY.md](SECURITY.md).

## License

By contributing to LST, you agree that your contributions will be licensed under the same license as the project.
