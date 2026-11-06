.PHONY: help ext-% backend-run backend-test ci

help:
	@echo "Extension (delegates to extension/Makefile):  make ext-<target>   e.g. make ext-dev, ext-test, ext-build, ext-package"
	@echo "make backend-run   - run Go backend (needs KOFI_VERIFICATION_TOKEN, optional ADMIN_TOKEN)"
	@echo "make backend-test  - go vet + go test"
	@echo "make ci            - full local gate: extension lint/typecheck/test/build + backend vet/test"

ext-%:
	"$(MAKE)" -C extension $*

backend-run:
	cd backend && go run ./cmd/tgsd

backend-test:
	cd backend && go vet ./... && go test -race ./...

ci:
	"$(MAKE)" -C extension ci
	cd backend && go vet ./... && go test -race ./...
