# Changelog

## Unreleased

### Added

- **Optional Premium tier** (Ko-fi + Go backend in `/backend`). Off by default: with `BACKEND_URL`/`KOFI_URL` empty in `src/config.ts` the extension behaves exactly as before. When enabled: free = 10 single downloads/day; Premium = unlimited, batch/ZIP and the Channel downloader. New Premium tab (activation code, plans from the server, restore by transaction id).
- **Unit and DOM-fixture tests** (Vitest + happy-dom) for range math, filenames, caps, catalog ids, URL guards, Premium rules, and album/avatar/preview extraction; CI runs them.
- **CI hardening**: extension job runs in `extension/`, secret scanning (gitleaks), a Postgres backend job, and manifest verification after every build.
- **Backend readiness and metrics**: `GET /readyz`, admin-only counters, structured request logs, and transaction-id proof for claiming payments.
- **JSON-based UI localization**: 14 locales (`en`, `zh-CN`, `zh-TW`, `es`, `fr`, `de`, `pt-BR`, `ru`, `ja`, `ko`, `it`, `tr`, `ar`, `hi`), a language selector in Settings, localized manifest name/description, and English fallback for partial translations. English, Simplified/Traditional Chinese, and Spanish are complete; the other locales cover the core UI and fall back to English for long-tail strings. Add a language by dropping `src/locales/<code>.json` next to the others.

### Changed

- **One isolated content script** now hosts both the catalog/inline-button scanner and the channel runner, so `catalog.ts` is bundled once and exactly one listener owns the save bridge.
- **Observer-driven scanning** replaces the 3-second full-DOM poll: media/message mutations, settled scrolls, and a slow reconciliation timer; no work while the tab is hidden.
- **Bounded batch downloads** (3 concurrent) and **streamed ZIP assembly** (async, store mode for media, 2 GiB guard) reduce memory spikes on large runs.
- **Storage growth is capped**: 400 items/chat, 150 thumbnails, 20 chats, with quota fallback and startup pruning.
- **Popup no longer navigates the current tab**; it offers an "Open Telegram Web" action instead.
- **Tab panes are lazy-mounted**, so the Channel scroll watcher only runs while that tab is open.
- Accessibility: tab roles/arrow-key navigation, aria labels, focus-visible, and reduced-motion support; shared strings moved into a small `t()` table.
- Settings now carry a schema version and deep-merge nested channel options.

### Fixed

- **Album items no longer disappear** from the catalog: storage writes are serialized and batched.
- **Clear All stays cleared** instead of being repopulated by the next scan.
- **Channel Stop/Resume**: Stop no longer looks like "Done", the checkpoint is kept for Resume, ZIP runs report queued counts, and in-flight fetches are aborted.
- **No silent truncation** when a `206` response omits the Range total; partial probes fall back to a full fetch.
- **No shared-media observer leak**; Force Download now catalogs even with inline buttons disabled.
- **Downloads report failures** to the popup (failed row + toast) instead of only the console; retries cover network errors, 429 and 5xx with backoff and `Retry-After`.
- **Save fallback** works when the isolated relay is unavailable (e.g. channel feature disabled).
- **Download bridge hardening**: non-Telegram URLs are rejected and filenames/paths are sanitized before `chrome.downloads`.

## 1.1.1 — 2026-09-04

### Added

- **Setting: "Also show it on channel/invite preview images"** (off by default). Controls whether the inline button appears on promotional link-preview cards (channel/group invites, "boost this channel", "subscribe", bot mini-apps, themes), service messages, sponsored posts, and similar-channels strips. Plain photo and article link previews are unaffected.

## 1.1.0 — 2026-09-04

### Added

- **Channel download limits** — per-type caps (videos / images / documents) plus an overall total cap, in the Channel tab. Blank = no limit. Caps are remembered between sessions; a run stops early with "Download limit reached" once they're met.
- **Live "Found" count** — while the Channel tab is open, the visible-media count updates as you scroll the chat (throttled; no work when the popup is closed).
- **Best-effort document extraction** for channel downloads — catches file attachments that expose a real URL.
- **Continuous integration** — GitHub Actions runs Biome (lint + format), `vue-tsc`, and a production build on every push to `main` and every PR; the built `dist/` is uploaded as an artifact.

### Changed

- **Channel downloader rewritten.** It now reuses the same media extraction as the inline buttons, and routes every file through the page's own service-worker context — previously it handed Telegram's virtual `progressive/…` URLs straight to `chrome.downloads`, which had no session and saved the app's HTML shell as a broken `.htm`. Downloads run strictly one at a time, paced to avoid throttling, and it auto-scrolls the channel history from newest to oldest.
- **Resilient DOM matching.** Message-root detection walks a tight→loose list of selectors and falls back to anchoring on the media elements themselves, so a Telegram class rename degrades instead of silently breaking — and logs a console warning when it can't find anything.
- **Leaner background scan.** Settings are cached (no `chrome.storage` round-trip every 3 s), thumbnails are captured once per item instead of on every scan tick, and album items are catalogued once rather than repeatedly.
- Album "Download all" and single-media buttons are placed inside the message's content column.

### Fixed

- Inline download buttons no longer leak into the chat list and the right-hand profile / shared-media panel — injection is scoped to the open conversation column.
- The album "Download all" button rendered beside the album instead of below it.
- The Stop button is hidden until a run starts, and disabled buttons now actually look disabled (brand `!important` styles were overriding Element Plus's dimmed state).
- Channel limit fields are plain number inputs instead of fiddly spinners.
- Emoji / reaction images can no longer be mistaken for downloadable media (size check).

## 1.0.1 — 2026-09-04

### Fixed

- Inline download buttons stopped appearing on `web.telegram.org/a`. `isAvatarElement` matched **any** class containing the substring `"avatar"` — including `no-avatars` on a message-list ancestor — so `closest()` flagged every media element as an avatar and skipped it, with no error. It now matches real avatar class tokens only (`avatar`, `avatar-*`, `Avatar__*`).

## 1.0.0 — 2026-07-29

Initial release.

- Download videos from Telegram Web channels and groups, including private ones, in one click.
- Batch download mode for grabbing multiple videos at once, with ZIP export.
- Per-channel download pane with catalog scanning of available media.
- Light/dark theme support.
- Download progress badge and history tracking.
- Configurable settings panel.
