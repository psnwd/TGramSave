# Manual QA checklist

Run this before a release, on a fresh profile, for both Chrome and Firefox. Test Telegram Web **A** (`/a`) and **K** (`/k`).

## Install

- [ ] Load unpacked (`dist/chrome`) / temporary add-on (`dist/firefox/manifest.json`): no manifest warnings.
- [ ] First install opens `web.telegram.org/a` (install only, not on update).
- [ ] Popup on a non-Telegram tab shows "Open Telegram Web" and does **not** navigate the current tab.
- [ ] Popup on Telegram shows Download / Channel / [Premium] / Settings.

## Inline buttons

- [ ] Photo message: one "Download Image" button.
- [ ] Video message: one "Download Video" button.
- [ ] Album of 3: three overlay buttons + "Download all (3)".
- [ ] Inline buttons off: no buttons, but the Download tab still catalogs media and Force Download works.
- [ ] Promo/invite previews: no button by default; enable the setting and re-check.
- [ ] GIF/animated sticker: skipped by default; enable WebM and re-check.
- [ ] Avatars, emoji/reaction images, and `data:` placeholders never get buttons.
- [ ] Both `/a` and `/k`; switch chats and confirm buttons follow the open conversation only.

## Download tab

- [ ] Single download saves a playable file (video and image).
- [ ] Batch selects several and downloads them with at most 3 in flight.
- [ ] ZIP batch opens and contains every selected file; duplicate names are suffixed.
- [ ] ZIP cancel stops and saves nothing.
- [ ] A deliberately broken URL shows a failed row + toast, and Retry works.
- [ ] Copy Selected copies newline-separated URLs.
- [ ] Clear All empties the list and it stays empty while the same chat is open; new messages still appear.
- [ ] Switching chats keeps "Clear All" from hiding the new chat.
- [ ] Overall progress reaches 100 and the Cancel button disappears.

## Channel tab

- [ ] Detection shows the channel title; not-on-Telegram shows a warning.
- [ ] Start / Pause / Resume / Stop; Stop says "Stopped" (not "Done") and keeps the checkpoint.
- [ ] Resume continues from the checkpoint.
- [ ] Per-type caps and total cap stop the run with "Download limit reached".
- [ ] Video duration min/max filters; unknown durations are included.
- [ ] ZIP mode reports the queued count and produces archive part(s) of the configured size.
- [ ] Checkpoint every N files survives a reload and resumes.
- [ ] No new messages / small chat finishes with "Reached start of channel".

## Extension lifecycle

- [ ] Reload the extension with a Telegram tab open: one warning, no error spam; inline buttons still work.
- [ ] Storage stays bounded after browsing several chats (Settings → clear old chats once implemented).
- [ ] Download failures are visible, not only in the console.
- [ ] Theme light/dark/system; system change updates live; reduced-motion setting disables transitions.

## Backend (Premium build)

- [ ] `/healthz` returns ok; `/readyz` returns ready with the DB up and 503 with it down.
- [ ] Register returns `{id, secret, code}`; status is free.
- [ ] Ko-fi webhook with the correct token and a matching tier/code activates Premium.
- [ ] Bad token → 401; replay does not extend; renewal without a code matches by email.
- [ ] Claim with email + correct Ko-fi transaction ID activates; email-only returns 400 unless `ALLOW_EMAIL_CLAIM=1`.
- [ ] Admin requires the token, locks out after repeated failures, and `/admin/metrics` increments.
- [ ] Postgres path: `TEST_DATABASE_URL=... go test ./...`.

## Packaging

- [ ] `make ext-package` produces `dist/chrome.zip` and `dist/firefox.zip` with `manifest.json` at the root.
- [ ] No `.env`, source maps, dev-only `key`, or obfuscated code in the zips.
- [ ] Manifest version matches `package.json` (`bun run verify:dist`).
