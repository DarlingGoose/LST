# Security Policy

## Supported versions

Security fixes are generally applied to the latest released version of LST.

| Version | Supported |
| --- | --- |
| Latest release | ✅ |
| Older releases | Best effort |

Users are encouraged to update to the newest available release.

## Reporting a vulnerability

Please **do not open a public GitHub issue** for security vulnerabilities.

Instead, report the issue privately using GitHub's private vulnerability reporting feature if it is enabled for this repository.

If private vulnerability reporting is not available, contact the maintainer privately using the contact information on the maintainer's GitHub profile.

Please include:

- a clear description of the vulnerability
- affected LST version
- affected browser(s)
- reproduction steps
- potential impact
- any proof-of-concept material that is safe to share
- suggested mitigation, if you have one

Please do not include real Netflix cookies, account credentials, API keys, Ollama secrets, or other sensitive personal information.

## Security-sensitive areas

LST interacts with:

- Netflix playback pages and subtitle data
- browser extension storage
- a user-configured Ollama endpoint, normally on localhost
- optional DeepSeek and Gemini API keys and provider requests
- locally cached subtitle translations

Changes involving host permissions, extension permissions, page-context code, content-script boundaries, local network access, storage, or execution of externally supplied content should receive extra scrutiny.

LST should not execute remote JavaScript or WebAssembly, use `eval()` on network-provided content, or transmit user subtitle data to developer-operated services.

## Disclosure

Please allow reasonable time for investigation and a fix before publicly disclosing a vulnerability.
