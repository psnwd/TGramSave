# Store submission notes

Developer-facing. Build: `bun run package` → `dist/chrome.zip`, `dist/firefox.zip` (each has `manifest.json` at the root).
Single targets: `bun run package:chrome`, `bun run package:firefox`. `make package` is the same.

## Chrome Web Store checklist
- [ ] Upload `dist/chrome.zip` (the dev-only `key` is not in production builds — CWS assigns the ID).
- [ ] Store listing: description, 1280x800 or 640x400 screenshots (`assets/*.jpg` need resizing), 128px icon, optional 440x280 promo tile.
- [ ] Single purpose statement: "Download media from Telegram Web (web.telegram.org)."
- [ ] Permission justifications (table below).
- [ ] Privacy tab: data-use disclosures + privacy-policy URL (see below). Certify no sale/transfer of data.
- [ ] Remote code: "No" (all code bundled; see audit).
- [ ] Set `HOMEPAGE_URL` / `AUTHOR_EMAIL` in `src/config.ts` (currently empty).
- [ ] Add trademark disclaimer to the listing ("Unofficial, not affiliated with Telegram") — name contains "Telegram".

## Firefox AMO checklist
- [ ] Upload `dist/firefox.zip` as "On this site" (listed) or self-distributed.
- [ ] Add-on ID is `tgramsave@blackcat` (`GECKO_ID` in `src/manifest.ts`). Choose final ID **before** first upload; it can't change later.
- [ ] `data_collection_permissions.required = ["none"]` is declared (nothing leaves the browser). Revisit if telemetry is ever added.
- [ ] Reviewers may ask for source: submit the repo / `git archive` plus build steps: `bun install --frozen-lockfile && bun run package:firefox` (Bun ≥ 1.2, Node ≥ 20). Bundled output is minified by Vite, not obfuscated.
- [ ] Summary ≤ 250 chars, categories, screenshots, license (Apache-2.0), privacy policy if you claim one.
- [ ] Min Firefox 128 (MV3 + content script `world: "MAIN"`). Desktop only tested path; Android not verified.

## Permissions
Chrome builds declare `minimum_chrome_version: 111` (MAIN-world content scripts). The popup talks to the active Telegram tab through `chrome.tabs.sendMessage`, covered by the host permission.

| Permission | Why |
|---|---|
| `host_permissions: https://web.telegram.org/*` | Content scripts inject download buttons, read media element URLs, and fetch media bytes with the user's Telegram session. |
| `storage` | Settings (theme, folder, filters, limits) and the batch list of media seen on the current page. |
| `downloads` | Save files to the user's Downloads folder (single, ZIP, channel run). |
| `downloads.open` | Popup checks/opens finished downloads. |

Removed vs. 1.1.1: `activeTab` (redundant with host permission), broad `*://*/*` web-accessible resources (now fonts only, Telegram origin only), popup/icons from web-accessible resources.

## Data
- **Collected/stored locally** (`storage.local`): user settings; per-page list of media items (URL, name, type, size) discovered on web.telegram.org, keyed by an MD5 hash of the page URL. Cleared via the popup.
- **Accessed**: DOM of web.telegram.org (media elements, message metadata needed to name files), active tab URL.
- **Transmitted**: nothing to the developer or any third party. No analytics, no remote config, no accounts. The extension only requests media from `web.telegram.org` (Telegram's own servers, with the user's existing session cookies) and writes files locally.
- **External services**: only Telegram Web (user-operated). No other hosts referenced in source (verified by grep; build output contains no external URLs besides a `localhost` token in a bundled URL-regex of the UI library).
- Downloaded media may be personal communications; it stays on the user's machine.

## Premium build (only when `BACKEND_URL` + `KOFI_URL` are set in `src/config.ts`)
With both empty the build is free-only and everything above ("nothing transmitted", `data_collection_permissions: none`) stays true. Enabling Premium changes the disclosures:
- [ ] Manifest gains `host_permissions` for the backend origin (automatic). Add to the permissions table: "backend origin: check Premium status / register an anonymous install id."
- [ ] **Transmitted** to the backend you run: a random install id + secret (generated on first run, no account), the Premium status check, and, only if the user uses "Restore", their Ko-fi email and transaction id. Payments themselves are handled by Ko-fi. The backend defaults to transaction-id proof; `ALLOW_EMAIL_CLAIM=1` restores legacy email-only restore and is not recommended.
- [ ] Not sent: Telegram content, media, URLs, usage counts (the free daily counter is local).
- [ ] Chrome Privacy tab: tick "Website content: no", "Authentication information: no"; "Personally identifiable information": yes only if you keep the email-restore field (email is stored server-side to match payments).
- [ ] Firefox: build declares `required: ["technicalAndInteraction"]`, `optional: ["personallyIdentifyingInfo"]` automatically. Verify the category names against the current AMO docs before upload.
- [ ] Single-purpose statement still holds (Premium only lifts download limits). Describe the free limits (10 downloads/day, no batch/ZIP/channel) in the listing.
- [ ] Privacy policy URL is now required: publish [PRIVACY.md](PRIVACY.md) (fill the contact email and backend retention).

## Privacy policy
Both stores want a policy URL when user data is handled. Draft: [PRIVACY.md](PRIVACY.md). It covers the free build and the Premium build; delete the Premium section if you ship free-only. Needs owner/contact details before publishing.

## Chrome vs Firefox differences
| | Chrome | Firefox |
|---|---|---|
| Background | `service_worker` (module) | `background.scripts` (event page, module) |
| Manifest extras | none (`key` dev-only) | `browser_specific_settings.gecko` (id, min version, data collection) |
| API access | `webextension-polyfill` (`browser.*`) used everywhere; no `chrome.*` calls in app code | same code |
| MAIN-world content script | Chrome 111+ | Firefox 128+ |
| Host permissions | granted at install | granted at install (≥127) but user can revoke in `about:addons` → extension breaks until re-granted |

## Audit results
- No `eval`/`new Function`/remote scripts/external `<script>`; no `localhost` or dev URLs in source; no secrets/API keys/tokens (grep clean).
- `innerHTML` used once (`src/channel-downloader/index.ts`, floating panel) with a static template — no user data interpolated.
- `console.warn/error` calls remain for diagnostics (prefixed `[tgdl]`); no `console.log`. Product decision whether to strip for release.
- `author` in manifest is a plain string (Chrome accepts; Firefox ignores).
- `_locales/en_US` duplicates `en` — harmless.

## Manual test checklist (both browsers)
- [ ] Load unpacked (`dist/chrome`) / temporary add-on (`dist/firefox/manifest.json`): no manifest warnings.
- [ ] First install opens web.telegram.org/a.
- [ ] Popup on non-Telegram tab redirects to Telegram; on Telegram shows tabs.
- [ ] Inline download buttons appear under photo/video/file (Telegram Web A **and** K).
- [ ] Single download, album "Download all", ZIP batch, copy links.
- [ ] Badge count updates, clears.
- [ ] Settings persist after popup close and browser restart; theme switch.
- [ ] Channel download: start/pause/resume/stop, limits, folder.
- [ ] After extension reload, console warns to refresh page, no error spam.
- [ ] Inspect service worker / background console and page console for errors.

## Verification status (this change)
Built, linted (`biome ci`), type-checked (`vue-tsc`), manifests and ZIP structure inspected. **Not** loaded in real Chrome/Firefox (not installed on the build machine) — run the manual checklist, especially Firefox content-script dynamic import and `world: "MAIN"` behaviour, before submitting.
