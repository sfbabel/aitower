#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  ARCH RESTORE — Rebuild system from backup snapshot
#  Run this from a fresh Arch install with internet access.
#  Usage: arch-restore.sh <backup_dir>
#
#  Prerequisites:
#    - Fresh Arch install (base, linux, linux-firmware, grub, networkmanager)
#    - Internet connection
#    - Running as your user (not root), with sudo access
# ═══════════════════════════════════════════════════════════
set -euo pipefail

BACKUP_DIR="${1:-}"

if [[ -z "$BACKUP_DIR" || ! -d "$BACKUP_DIR" ]]; then
    echo "Usage: arch-restore.sh <backup_dir>"
    echo "  e.g.: arch-restore.sh /mnt/usb/archbox/latest"
    exit 1
fi

BACKUP_DIR="$(realpath "$BACKUP_DIR")"

# Source lib + config — check bundled scripts first, then script's own directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$BACKUP_DIR/scripts/lib.sh" && -f "$BACKUP_DIR/scripts/backup.conf" ]]; then
    source "$BACKUP_DIR/scripts/lib.sh"
    load_config "$BACKUP_DIR/scripts/backup.conf"
elif [[ -f "$SCRIPT_DIR/lib.sh" ]]; then
    source "$SCRIPT_DIR/lib.sh"
    load_config
else
    echo "✗ Fatal: cannot find lib.sh and backup.conf" >&2
    echo "  Expected at: $BACKUP_DIR/scripts/ or $SCRIPT_DIR/" >&2
    echo "  These are bundled with every backup. Is the backup corrupt?" >&2
    exit 1
fi

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║     ARCH LINUX SYSTEM RESTORE         ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""
echo "  Restoring from: $BACKUP_DIR"
echo ""

if [[ -f "$BACKUP_DIR/system-info.txt" ]]; then
    echo "Original system:"
    head -6 "$BACKUP_DIR/system-info.txt" | tail -4
    echo ""
fi

# ── Phase 1: System Configs ──────────────────────────────
if ask "Restore system configs (/etc)?"; then
    log "Restoring system configs..."

    # Files
    for f in "${ETC_FILES[@]}"; do
        src="$BACKUP_DIR/system/$f"
        if [[ -f "$src" ]]; then
            sudo mkdir -p "/etc/$(dirname "$f")"
            sudo cp "$src" "/etc/$f"
            log "  /etc/$f"
        fi
    done

    # Directories
    for d in "${ETC_DIRS[@]}"; do
        if [[ -d "$BACKUP_DIR/system/$d" ]]; then
            sudo mkdir -p "/etc/$d"
            sudo cp -a "$BACKUP_DIR/system/$d/"* "/etc/$d/" 2>/dev/null || true
            log "  /etc/$d/"
        fi
    done

    # Regenerate locale
    [[ -f /etc/locale.gen ]] && sudo locale-gen

    # Set timezone
    sudo ln -sf "/usr/share/zoneinfo/${TIMEZONE}" /etc/localtime
    sudo hwclock --systohc

    ok "System configs restored"
fi

# ── Phase 2: Install Packages ────────────────────────────
if ask "Install packages?"; then
    log "Syncing pacman database..."
    sudo pacman -Sy

    log "Installing official packages..."
    if [[ -f "$BACKUP_DIR/packages/official-explicit.txt" ]]; then
        PKG_LIST=$(cut -d' ' -f1 "$BACKUP_DIR/packages/official-explicit.txt")
        # Try batch install first (fast path)
        if echo "$PKG_LIST" | sudo pacman -S --needed --noconfirm - 2>/dev/null; then
            ok "Official packages installed"
        else
            # Batch failed — some packages likely removed from repos. Fall back to per-package.
            warn "Batch install failed, falling back to per-package..."
            echo "$PKG_LIST" | while read -r pkg; do
                [[ -z "$pkg" ]] && continue
                sudo pacman -S --needed --noconfirm "$pkg" 2>/dev/null || warn "Skipped: $pkg (not in repos)"
            done
            ok "Official packages installed (with fallback)"
        fi
    fi

    log "Installing yay (AUR helper)..."
    if ! command -v yay &>/dev/null; then
        sudo pacman -S --needed --noconfirm git base-devel
        TMPYAY=$(mktemp -d)
        git clone https://aur.archlinux.org/yay.git "$TMPYAY/yay"
        (cd "$TMPYAY/yay" && makepkg -si --noconfirm)
        rm -rf "$TMPYAY"
        ok "yay installed"
    else
        ok "yay already installed"
    fi

    if [[ -f "$BACKUP_DIR/packages/aur-explicit.txt" ]]; then
        log "Installing AUR packages..."
        while read -r pkg _ver; do
            # Skip yay itself and debug packages
            [[ "$pkg" == "yay" || "$pkg" == *-debug ]] && continue
            if ! pacman -Q "$pkg" &>/dev/null; then
                log "  Installing $pkg..."
                yay -S --noconfirm "$pkg" 2>&1 | tail -2 || warn "Failed: $pkg (install manually)"
            fi
        done < "$BACKUP_DIR/packages/aur-explicit.txt"
        ok "AUR packages installed"
    fi
fi

# ── Phase 3: Dotfiles & User Config ─────────────────────
if ask "Restore dotfiles and user configs?"; then
    log "Restoring dotfiles..."
    DOTDIR="$BACKUP_DIR/dotfiles"

    # Shell dotfiles
    for f in "${DOTFILES[@]}"; do
        [[ -f "$DOTDIR/$f" ]] && cp "$DOTDIR/$f" "$HOME/$f"
    done

    # ~/.config
    if [[ -d "$DOTDIR/config" ]]; then
        mkdir -p "$HOME/.config"
        for item in "$DOTDIR/config/"*; do
            name=$(basename "$item")
            if [[ -d "$item" ]]; then
                rsync -a "$item/" "$HOME/.config/$name/"
            else
                cp "$item" "$HOME/.config/$name"
            fi
            log "  ~/.config/$name"
        done
    fi

    # ~/.local/bin
    if [[ -d "$DOTDIR/local-bin" ]]; then
        mkdir -p "$HOME/.local/bin"
        cp -a "$DOTDIR/local-bin/"* "$HOME/.local/bin/"
        chmod +x "$HOME/.local/bin/"* 2>/dev/null || true
        ok "~/.local/bin restored"
    fi

    # SSH keys
    if [[ -d "$DOTDIR/ssh" ]]; then
        if ask "  Restore SSH keys?"; then
            mkdir -p "$HOME/.ssh"
            cp -a "$DOTDIR/ssh/"* "$HOME/.ssh/"
            chmod 700 "$HOME/.ssh"
            chmod 600 "$HOME/.ssh/"* 2>/dev/null || true
            chmod 644 "$HOME/.ssh/"*.pub 2>/dev/null || true
            ok "SSH keys restored"
        fi
    fi

    ok "Dotfiles restored"
fi

# ── Phase 4: Systemd Services ───────────────────────────
if ask "Restore and enable systemd services?"; then
    # Copy user unit files
    if [[ -d "$BACKUP_DIR/services/user-units" ]]; then
        mkdir -p "$HOME/.config/systemd/user"
        cp -a "$BACKUP_DIR/services/user-units/"* "$HOME/.config/systemd/user/" 2>/dev/null || true
        systemctl --user daemon-reload
        ok "User unit files copied"
    fi

    # Enable system services (everything from backup, skip known defaults)
    if [[ -f "$BACKUP_DIR/services/system-enabled.txt" ]]; then
        log "Enabling system services..."
        while read -r svc _rest; do
            [[ -z "$svc" ]] && continue
            is_default_service "$svc" && continue
            sudo systemctl enable "$svc" 2>/dev/null && log "  $svc" || warn "  $svc not available"
        done < "$BACKUP_DIR/services/system-enabled.txt"
    fi

    # Enable user services
    if [[ -f "$BACKUP_DIR/services/user-enabled.txt" ]]; then
        log "Enabling user services..."
        while read -r unit _rest; do
            [[ -z "$unit" ]] && continue
            systemctl --user enable "$unit" 2>/dev/null && log "  $unit" || warn "  $unit not available yet"
        done < "$BACKUP_DIR/services/user-enabled.txt"
    fi

    ok "Services configured"
fi

# ── Phase 5: User Data ──────────────────────────────────
if ask "Restore user data (university, website, Exocortex, etc.)?"; then
    log "Restoring user data..."

    if [[ -d "$BACKUP_DIR/data" ]]; then
        for dir in "$BACKUP_DIR/data/"*/; do
            name=$(basename "$dir")
            rsync -a "$dir" "$HOME/$name/"
            SIZE=$(du -sh "$HOME/$name" | cut -f1)
            log "  ~/$name ($SIZE)"
        done
    fi

    ok "User data restored"
fi

# ── Phase 6: Final Steps ────────────────────────────────
echo ""
echo "═══════════════════════════════════════════"
echo "  Restore complete!"
echo "═══════════════════════════════════════════"
echo ""
echo "Manual steps remaining:"
echo "  1. sudo grub-mkconfig -o /boot/grub/grub.cfg"
echo "  2. sudo mkinitcpio -P"
echo "  3. Log out and back in (or reboot)"

# Show git remote restore commands from captured data
if [[ -f "$BACKUP_DIR/git-remotes.txt" ]]; then
    echo ""
    echo "  4. Restore git repos:"
    while IFS= read -r line; do
        if [[ "$line" == "=== "* ]]; then
            dir="${line#=== }"
            dir="${dir% ===}"
        elif [[ "$line" == *"(fetch)"* ]]; then
            remote=$(echo "$line" | awk '{print $1}')
            url=$(echo "$line" | awk '{print $2}')
            echo "     cd ~/$dir && git init && git remote add $remote $url"
        fi
    done < "$BACKUP_DIR/git-remotes.txt"
fi

echo ""
echo "  5. Run dependency installs where needed:"
echo "     cd ~/website && npm install"
echo "     cd ~/sauron && bun install"
echo "  6. Log into apps: Firefox, Chrome, Discord (Vesktop), Surfshark"
echo "  7. Check ~/.ssh/config and test connections"
echo ""
