# Aitower — Makefile
#
# Usage:
#   make install     Install everything (deps, commands, systemd service)
#   make uninstall   Remove commands and systemd service

PREFIX    := $(HOME)/.local
BIN_DIR   := $(PREFIX)/bin
UNIT_DIR  := $(HOME)/.config/systemd/user
UNIT_NAME := aitower-daemon.service
REPO_DIR  := $(CURDIR)

# ── Targets ──────────────────────────────────────────────────────────

.PHONY: install uninstall check-bun deps links service login \
        remove-links remove-service status

install: check-bun deps links service
	@printf '\n  ✓ Aitower installed.\n'
	@printf '    Commands: aitowerd, aitower, exo\n'
	@printf '    Service:  aitower-daemon.service (systemd user)\n\n'
	@printf '  Next steps:\n'
	@printf '    1. Ensure ~/.local/bin is in your PATH\n'
	@printf '    2. Run: aitowerd login\n'
	@printf '    3. Run: aitower\n\n'

uninstall: remove-links remove-service
	@printf '\n  ✓ Aitower uninstalled.\n\n'

# ── Prerequisites ────────────────────────────────────────────────────

check-bun:
	@command -v bun >/dev/null 2>&1 || { \
		printf '\n  ✗ bun is required but not found.\n'; \
		printf '    Install: curl -fsSL https://bun.sh/install | bash\n\n'; \
		exit 1; \
	}

# ── Dependencies ─────────────────────────────────────────────────────

deps:
	@printf '  Installing dependencies...\n'
	@bun install --frozen-lockfile
	@printf '  ✓ Dependencies installed\n'

# ── Symlinks ─────────────────────────────────────────────────────────

links:
	@mkdir -p $(BIN_DIR)
	@ln -sf $(REPO_DIR)/bin/aitowerd $(BIN_DIR)/aitowerd
	@ln -sf $(REPO_DIR)/bin/aitower  $(BIN_DIR)/aitower
	@ln -sf $(REPO_DIR)/bin/exo        $(BIN_DIR)/exo
	@printf '  ✓ Linked aitowerd, aitower, exo → $(BIN_DIR)/\n'

remove-links:
	@rm -f $(BIN_DIR)/aitowerd $(BIN_DIR)/aitower $(BIN_DIR)/exo
	@printf '  ✓ Removed symlinks from $(BIN_DIR)/\n'

# ── Systemd service ─────────────────────────────────────────────────

service:
	@mkdir -p $(UNIT_DIR)
	@BUN_PATH=$$(command -v bun) && \
	printf '%s\n' \
		'[Unit]' \
		'Description=Aitower daemon (aitowerd)' \
		'' \
		'[Service]' \
		'Type=simple' \
		'WorkingDirectory=$(REPO_DIR)/daemon' \
		"ExecStart=$$BUN_PATH run src/main.ts" \
		'Restart=on-failure' \
		'RestartSec=2' \
		'' \
		'[Install]' \
		'WantedBy=default.target' \
	> $(UNIT_DIR)/$(UNIT_NAME)
	@systemctl --user daemon-reload
	@systemctl --user enable $(UNIT_NAME)
	@printf '  ✓ Installed and enabled $(UNIT_NAME)\n'
	@if ! systemctl --user is-active --quiet $(UNIT_NAME); then \
		systemctl --user start $(UNIT_NAME); \
		printf '  ✓ Started $(UNIT_NAME)\n'; \
	else \
		printf '  • $(UNIT_NAME) is already running (restart with: systemctl --user restart $(UNIT_NAME))\n'; \
	fi

remove-service:
	@if systemctl --user is-active --quiet $(UNIT_NAME) 2>/dev/null; then \
		systemctl --user stop $(UNIT_NAME); \
		printf '  ✓ Stopped $(UNIT_NAME)\n'; \
	fi
	@if [ -f $(UNIT_DIR)/$(UNIT_NAME) ]; then \
		systemctl --user disable $(UNIT_NAME) 2>/dev/null || true; \
		rm -f $(UNIT_DIR)/$(UNIT_NAME); \
		systemctl --user daemon-reload; \
		printf '  ✓ Removed $(UNIT_NAME)\n'; \
	fi

# ── Utilities ────────────────────────────────────────────────────────

status:
	@systemctl --user status $(UNIT_NAME) --no-pager

login:
	@cd $(REPO_DIR)/daemon && bun run src/main.ts login
