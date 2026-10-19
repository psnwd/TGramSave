.PHONY: help ext-% backend-run backend-test

help:
	@echo "Extension (delegates to extension/Makefile):  make ext-<target>   e.g. make ext-dev, ext-build, ext-package"
	@echo "make backend-run   - run Go backend (needs KOFI_VERIFICATION_TOKEN, optional ADMIN_TOKEN)"
	@echo "make backend-test  - go vet + go test"

ext-%:
	"$(MAKE)" -C extension $*

backend-run:
	cd backend && go run ./cmd/tgsd

backend-test:
	cd backend && go vet ./... && go test ./...
