.PHONY: help install dev build typecheck clean package icons

help:
	@echo "make install    - bun install"
	@echo "make dev        - start Vite dev build (watches src/, loads unpacked from dist/)"
	@echo "make build      - type-check then produce a production build in dist/"
	@echo "make typecheck  - vue-tsc --noEmit only"
	@echo "make icons      - regenerate public/icons/{16,32,48,128}.png from master.png (or existing 128.png)"
	@echo "make clean      - remove dist/"
	@echo "make package    - build, then zip dist/ into tgramsave.zip"

install:
	bun install

dev:
	bun run dev

build:
	bun run build

typecheck:
	bun run typecheck

icons:
	node scripts/generate-icons.mjs

clean:
	node -e "require('fs').rmSync('dist', { recursive: true, force: true })"

package: build
	powershell -NoProfile -Command "Compress-Archive -Path 'dist/*' -DestinationPath 'tgramsave.zip' -Force"
