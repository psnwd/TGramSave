# Security policy

TGramSave is an unofficial browser extension that downloads media from Telegram Web. It is not affiliated with Telegram FZ-LLC.

## Supported versions

Security fixes land on the latest released version. If you are running an older build, upgrade before reporting.

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Report privately to the maintainer (use the contact address in `extension/PRIVACY.md` once published, or a private GitHub security advisory). Include:

- affected version and browser;
- steps to reproduce, ideally a minimal page/DOM snippet;
- impact (data exposure, arbitrary download, permission abuse, etc.);
- whether the issue requires a compromised `web.telegram.org` page.

You should get an acknowledgement within a few days. Please give us a reasonable window to ship a fix before public disclosure.

## Scope

In scope:

- the extension's permissions, message bridge, and download/save paths;
- the optional backend (`backend/`): authentication, payment/claim flow, rate limits, data handling;
- XSS/HTML injection in the popup or the channel panel;
- secret leakage or supply-chain issues in the build.

Out of scope:

- the security of Telegram itself or `web.telegram.org`;
- content the user chooses to download (copyright, privacy of third parties);
- issues that require installing a malicious extension or a rooted browser.

## Data handling

The free build sends nothing to the developer. The optional Premium build sends a random install id/secret, a status check, and (only if the user restores by email) the Ko-fi email. See `extension/PRIVACY.md` and `STORE_SUBMISSION.md`.
