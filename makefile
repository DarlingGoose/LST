SHELL := /usr/bin/env bash

ROOT := $(CURDIR)
CHROME_BUILD := $(ROOT)/.chrome-build
FIREFOX_BUILD := $(ROOT)/.firefox-build
DEV_PROFILE := /tmp/lst-browser-profile

.PHONY: run browser firefox chromium clean-dev help

run:
	@set -euo pipefail; \
	desktop="$$(xdg-settings get default-web-browser 2>/dev/null || true)"; \
	if [[ -z "$$desktop" ]]; then \
		echo "Could not determine default browser."; \
		exit 1; \
	fi; \
	echo "Default browser: $$desktop"; \
	case "$$desktop" in \
		firefox*.desktop) \
			$(MAKE) firefox \
			;; \
		librewolf*.desktop) \
			$(MAKE) firefox FIREFOX_BIN=librewolf \
			;; \
		google-chrome*.desktop) \
			$(MAKE) chromium CHROMIUM_BIN=google-chrome-stable \
			;; \
		chromium*.desktop) \
			$(MAKE) chromium CHROMIUM_BIN=chromium \
			;; \
		brave*.desktop) \
			$(MAKE) chromium CHROMIUM_BIN=brave \
			;; \
		*) \
			echo "Unsupported default browser: $$desktop"; \
			echo "Try one of:"; \
			echo "  make firefox"; \
			echo "  make chromium CHROMIUM_BIN=chromium"; \
			exit 1; \
			;; \
	esac

browser:
	@xdg-settings get default-web-browser

firefox:
	@set -euo pipefail; \
	bin="$${FIREFOX_BIN:-firefox}"; \
	echo "Preparing Firefox build..."; \
	npm run prepare:firefox; \
	echo "Launching $$bin with LST installed temporarily..."; \
	npx web-ext run \
		--source-dir="$(FIREFOX_BUILD)" \
		--firefox="$$bin"

chromium:
	@set -euo pipefail; \
	bin="$${CHROMIUM_BIN:-chromium}"; \
	echo "Preparing Chromium build..."; \
	if npm run | grep -q 'prepare:chrome'; then \
		npm run prepare:chrome; \
		source_dir="$(CHROME_BUILD)"; \
	else \
		echo "prepare:chrome not found; using repository root."; \
		source_dir="$(ROOT)"; \
	fi; \
	echo "Launching $$bin with LST loaded from $$source_dir"; \
	rm -rf "$(DEV_PROFILE)"; \
	"$$bin" \
		--user-data-dir="$(DEV_PROFILE)" \
		--load-extension="$$source_dir" \
		--no-first-run \
		--no-default-browser-check \
		"https://www.netflix.com/"

clean-dev:
	rm -rf "$(DEV_PROFILE)"
	rm -rf "$(FIREFOX_BUILD)"
	rm -rf "$(CHROME_BUILD)"

help:
	@echo "LST development commands"
	@echo
	@echo "  make run"
	@echo "      Detect default browser and launch LST."
	@echo
	@echo "  make firefox"
	@echo "      Launch Firefox with LST installed temporarily."
	@echo
	@echo "  make chromium"
	@echo "      Launch Chromium with LST loaded unpacked."
	@echo
	@echo "  make chromium CHROMIUM_BIN=brave"
	@echo "      Launch a specific Chromium browser."
	@echo
	@echo "  make browser"
	@echo "      Show the detected default browser."
	@echo
	@echo "  make clean-dev"
	@echo "      Remove generated builds and temporary browser profile."
