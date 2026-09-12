# Firefox release guide

LST is configured for listed distribution through [addons.mozilla.org](https://addons.mozilla.org/developers/).

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
npm run package
```

The verified upload archive is written to:

```text
web-ext-artifacts/lst-firefox-<version>.zip
```

`npm run package` checks JavaScript syntax, confirms release metadata and icon declarations, runs Mozilla's linter, builds the archive, and verifies that `manifest.json` and the extension files are at its root.

Mozilla's linter currently reports two expected compatibility warnings for the unified Firefox/Chromium manifest:

- Firefox ignores `background.service_worker` and uses `background.scripts`.
- Firefox Android introduced the built-in consent manifest key in version 142; LST currently targets Firefox desktop 140 and is not being submitted as an Android add-on.

Both warnings are non-blocking. The package must have zero lint errors.

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

`.github/workflows/firefox-ci.yml` runs for every pull request and push to `main`. It installs the locked `web-ext` version, runs all validation, builds the AMO-ready ZIP, verifies its layout, and uploads it as a 14-day workflow artifact.

## Tagged releases

Before tagging, update the version in both `manifest.json` and `package.json`. Then create and push a matching tag:

```bash
git tag v0.4.4
git push origin v0.4.4
```

`.github/workflows/firefox-release.yml` rejects mismatched tags, builds and verifies the ZIP, creates a SHA-256 checksum, uploads both as workflow artifacts, and creates or updates the matching GitHub release.

## Optional AMO publishing from GitHub Actions

After the initial AMO listing exists:

1. Create a GitHub environment named `firefox-addons` and optionally require manual approval for it.
2. Add `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` as secrets in that environment.
3. Add the repository variable `AMO_PUBLISH` with the value `true`.

Future matching `v*` tags will then submit the listed version to AMO with `web-ext sign`. Pull-request workflows never receive these secrets and never publish externally.
