# Browser release guide

LST builds Firefox and Chrome packages from one shared manifest and one release workflow. Firefox is configured for listed distribution through [addons.mozilla.org](https://addons.mozilla.org/developers/); Chrome publishing uses the Chrome Web Store API.

## Release identity and privacy

- Permanent add-on ID: `lst-local-subtitle-translate@darlinggoose`
- Minimum Firefox version: 140
- Declared transmitted data: `websiteContent`
- Default Ollama endpoint: `http://localhost:11434`
- Privacy policy: [`PRIVACY.md`](PRIVACY.md)
- Reviewer notes: [`AMO_REVIEWER_NOTES.md`](AMO_REVIEWER_NOTES.md)
- AMO listing metadata: [`amo-metadata.json`](amo-metadata.json)

The AMO metadata currently selects `all-rights-reserved`. Change `version.license` in `amo-metadata.json` before the first submission if LST should use an open-source license instead. Do not change the add-on ID after the first AMO submission.

## Local validation and packaging

Node.js 22 or newer is required.

```bash
npm ci
npm run package:all
```

The verified upload archives are written to:

```text
web-ext-artifacts/lst-firefox-<version>.zip
web-ext-artifacts/lst-chrome-<version>.zip
```

`npm run package:all` checks JavaScript syntax, confirms release metadata and icon declarations, runs the cache tests and Mozilla linter, builds both browser-specific source trees, and verifies both archives. `npm run package:firefox` and `npm run package:chrome` remain available when only one package is needed.

The generated Firefox manifest removes Chromium's `background.service_worker`, retains Firefox's `background.scripts`, and declares Firefox Android 142 as its Android minimum because that release introduced built-in data consent. The generated Chrome manifest retains `background.service_worker` and removes Firefox-only fields. The shared source manifest retains both background declarations so unpacked development works in both browser families. A release build must have zero lint errors and zero warnings.

## First AMO submission

For the first release, use the Developer Hub so the privacy policy and listing can be reviewed before enabling automated publishing:

1. Run `npm run package`.
2. Create a new listed add-on in the AMO Developer Hub.
3. Upload `web-ext-artifacts/lst-firefox-<version>.zip`.
4. Use the name, summary, description, and categories from `amo-metadata.json`.
5. Paste `PRIVACY.md` into the privacy policy field.
6. Paste `AMO_REVIEWER_NOTES.md` into Notes for Reviewers.
7. Upload `icons/icon-128.png` as the listing icon if AMO does not adopt the packaged icon automatically.

## Pull-request automation

`.github/workflows/browser-ci.yml` runs for every pull request and push to `main`. Its browser matrix builds and verifies both store-ready ZIPs and uploads them as 14-day workflow artifacts.

## Creating a release

Run the **Browser release** workflow from GitHub Actions and enter the new `major.minor.patch` version. The workflow:

1. Updates `manifest.json`, `package.json`, and both version fields in `package-lock.json` together.
2. Validates the release metadata.
3. Commits the version update to `main` and creates the matching `v<version>` tag.
4. Builds and verifies Firefox and Chrome packages from that exact commit.
5. Publishes both archives and checksums on one GitHub release.

The workflow needs permission to push to `main`. If branch protection is enabled, allow GitHub Actions to create the release commit or use a matching `v*` tag created from an already-versioned commit.

For a local version bump, use `npm run version:set -- 1.2.3`. Pushing a matching tag also starts `.github/workflows/release.yml`; mismatched tags are rejected before either browser package is published.

## Optional AMO publishing from GitHub Actions

After the initial AMO listing exists:

1. Create a GitHub environment named `firefox-addons` and optionally require manual approval for it.
2. Add `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` as secrets in that environment.
3. Add the repository variable `AMO_PUBLISH` with the value `true`.

Future releases will then submit the listed Firefox version to AMO with `web-ext sign`. Pull-request workflows never receive these secrets and never publish externally.

## Optional Chrome Web Store publishing

1. Create a GitHub environment named `chrome-web-store` and optionally require manual approval for it.
2. Add `CHROME_SERVICE_ACCOUNT_JSON` as an environment secret.
3. Add `CHROME_PUBLISHER_ID` and `CHROME_EXTENSION_ID` as repository variables.
4. Add the repository variable `CHROME_PUBLISH` with the value `true`.

The same release run uploads the verified Chrome artifact and submits it for review after both browser packages have built successfully.
