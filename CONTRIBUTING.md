# Contributing to TGramSave

Thanks for helping. The project is two parts: `extension/` (Manifest V3, Vue 3 + TypeScript) and `backend/` (Go + Gin + GORM, optional Premium).

## Setup

Requirements: Bun ≥ 1.2, Node ≥ 20, Go ≥ 1.24.

```bash
cd extension
bun install
bun run build        # type-check + Chrome/Firefox builds + manifest checks
bun run dev          # watch build into extension/dist/chrome
```

Load `extension/dist/chrome` as an unpacked extension, then open `https://web.telegram.org/a` (and `/k`). After a rebuild, reload the extension and hard-refresh the Telegram tab.

Backend:

```bash
cd backend
cp .env.example .env   # fill KOFI_VERIFICATION_TOKEN (never commit .env)
go run ./cmd/tgsd serve
go test -race ./...
```

## Checks before a PR

```bash
make ci               # extension: biome, vue-tsc, vitest, build; backend: vet, test -race
```

Or individually:

```bash
cd extension
bun run check
bun run typecheck
bun run test
bun run build
```

## Code layout

| Path | Runs in | Responsibility |
|---|---|---|
| `extension/src/content-script/` | Telegram isolated world | DOM scan, inline buttons, catalog storage |
| `extension/src/channel-downloader/` | same isolated entry (registered by content-script) | whole-channel scroll/download run |
| `extension/src/content-script-inject/` | Telegram MAIN world | range fetching, ZIP assembly, save bridge |
| `extension/src/background/` | MV3 service worker | messages, badge, `chrome.downloads` |
| `extension/src/popup/` | extension page | Vue/Element Plus UI |
| `extension/src/lib/` | shared | pure helpers (range, limits, names, urls, premium rules) |

Keep DOM-free logic in `src/lib/` and add a unit test next to it. `catalog.test.ts` shows the happy-dom fixture pattern.

## Rules of thumb

- Never commit `.env`, tokens, downloaded media, or `dist/`.
- Keep the extension free of remote code and unnecessary permissions.
- Add a `CHANGELOG.md` entry for user-visible changes.
- Match the existing comment style: explain *why*, not what the code obviously does.
- For Telegram DOM selectors, add a tight-to-loose fallback and keep the "barren scan" warning useful.

## Commit / PR

- Conventional-ish subject (`fix:`, `feat:`, `docs:`, `refactor:`), short and specific.
- One concern per PR when possible.
- Include how you tested (browser, Telegram `/a` or `/k`, build target).
