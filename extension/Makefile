.PHONY: help install dev build typecheck test clean package icons

help:
	@echo "make install    - bun install"
	@echo "make dev        - start Vite dev build (watches src/, loads unpacked from dist/chrome)"
	@echo "make build      - type-check then produce production builds in dist/chrome and dist/firefox"
	@echo "make typecheck  - vue-tsc --noEmit only"
	@echo "make test       - vitest run"
	@echo "make icons      - regenerate public/icons/{16,32,48,128}.png from master.png (or existing 128.png)"
	@echo "make clean      - remove dist/"
	@echo "make package    - build, then zip into dist/chrome.zip and dist/firefox.zip"

install:
	bun install

dev:
	bun run dev

build:
	bun run build

typecheck:
	bun run typecheck

test:
	bun run test

icons:
	node scripts/generate-icons.mjs

clean:
	node -e "require('fs').rmSync('dist', { recursive: true, force: true })"

package:
	bun run package
