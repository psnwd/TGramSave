# Changelog

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
