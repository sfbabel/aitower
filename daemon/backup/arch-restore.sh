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

RED='\033[0;31m'
GRN='\033[0;32m'
YLW='\033[1;33m'
AMB='\033[38;5;214m'
RST='\033[0m'
BOLD='\033[1m'

log()  { echo -e "${AMB}▸${RST} $*"; }
ok()   { echo -e "${GRN}✓${RST} $*"; }
warn() { echo -e "${YLW}⚠${RST} $*"; }
err()  { echo -e "${RED}✗${RST} $*" >&2; }
ask()  { echo -en "${AMB}?${RST} $* [y/N] "; read -r ans; [[ "$ans" =~ ^[Yy] ]]; }

BACKUP_DIR="${1:-}"

if [[ -z "$BACKUP_DIR" || ! -d "$BACKUP_DIR" ]]; then
    err "Usage: arch-restore.sh <backup_dir>"
    err "  e.g.: arch-restore.sh /mnt/usb/archbox/latest"
    exit 1
fi

# Resolve symlinks
BACKUP_DIR="$(realpath "$BACKUP_DIR")"

echo -e "${AMB}"
echo "  ╔═══════════════════════════════════════╗"
echo "  ║     ARCH LINUX SYSTEM RESTORE         ║"
echo "  ╚═══════════════════════════════════════╝"
echo -e "${RST}"
echo "  Restoring from: $BACKUP_DIR"
echo ""

if [[ -f "$BACKUP_DIR/system-info.txt" ]]; then
    echo -e "${BOLD}Original system:${RST}"
    head -6 "$BACKUP_DIR/system-info.txt" | tail -4
    echo ""
fi

# ── Phase 1: System Configs ──────────────────────────────
if ask "Restore system configs (/etc)?"; then
    log "Restoring system configs..."

    for f in pacman.conf hostname hosts locale.conf locale.gen \
             vconsole.conf mkinitcpio.conf environment; do
        src="$BACKUP_DIR/system/$f"
        if [[ -f "$src" ]]; then
            sudo cp "$src" "/etc/$f"
            log "  /etc/$f"
        fi
    done

    # GRUB config
    if [[ -f "$BACKUP_DIR/system/default/grub" ]]; then
        sudo cp "$BACKUP_DIR/system/default/grub" /etc/default/grub
        log "  /etc/default/grub"
    fi

    # Mirrorlist
    if [[ -f "$BACKUP_DIR/system/pacman.d/mirrorlist" ]]; then
        sudo cp "$BACKUP_DIR/system/pacman.d/mirrorlist" /etc/pacman.d/mirrorlist
        log "  /etc/pacman.d/mirrorlist"
    fi

    # Config directories
    for dir in modprobe.d sysctl.d xorg.conf.d udev/rules.d; do
        dirbase=$(basename "$dir")
        if [[ -d "$BACKUP_DIR/system/$dirbase" ]]; then
            sudo mkdir -p "/etc/$dir"
            sudo cp -a "$BACKUP_DIR/system/$dirbase/"* "/etc/$dir/" 2>/dev/null || true
            log "  /etc/$dir/"
        fi
    done

    # Regenerate locale
    if [[ -f /etc/locale.gen ]]; then
        sudo locale-gen
    fi

    # Set timezone
    sudo ln -sf /usr/share/zoneinfo/Europe/Madrid /etc/localtime
    sudo hwclock --systohc

    ok "System configs restored"
fi

# ── Phase 2: Install Packages ────────────────────────────
if ask "Install packages?"; then
    log "Syncing pacman database..."
    sudo pacman -Sy

    log "Installing official packages..."
    if [[ -f "$BACKUP_DIR/packages/official-explicit.txt" ]]; then
        # Install in batches, skip already installed, don't fail on missing
        cut -d' ' -f1 "$BACKUP_DIR/packages/official-explicit.txt" | \
            sudo pacman -S --needed --noconfirm - 2>&1 | tail -5
        ok "Official packages installed"
    fi

    log "Installing yay (AUR helper)..."
    if ! command -v yay &>/dev/null; then
        sudo pacman -S --needed --noconfirm git base-devel
        TMPYAY=$(mktemp -d)
        git clone https://aur.archlinux.org/yay.git "$TMPYAY/yay"
        cd "$TMPYAY/yay" && makepkg -si --noconfirm
        cd ~
        rm -rf "$TMPYAY"
        ok "yay installed"
    else
        ok "yay already installed"
    fi

    if [[ -f "$BACKUP_DIR/packages/aur-explicit.txt" ]]; then
        log "Installing AUR packages..."
        AUR_PKGS=$(cut -d' ' -f1 "$BACKUP_DIR/packages/aur-explicit.txt" | grep -v "^yay" | grep -v "\-debug$")
        echo "$AUR_PKGS" | while read -r pkg; do
            if ! pacman -Q "$pkg" &>/dev/null; then
                log "  Installing $pkg..."
                yay -S --noconfirm "$pkg" 2>&1 | tail -2 || warn "Failed: $pkg (install manually)"
            fi
        done
        ok "AUR packages installed"
    fi
fi

# ── Phase 3: Dotfiles & User Config ─────────────────────
if ask "Restore dotfiles and user configs?"; then
    log "Restoring dotfiles..."
    DOTDIR="$BACKUP_DIR/dotfiles"

    # Shell configs
    for f in .zshrc .bashrc .bash_profile .gitconfig; do
        [[ -f "$DOTDIR/$f" ]] && cp "$DOTDIR/$f" "$HOME/$f"
    done

    # ~/.config directories
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
    log "Restoring user systemd units..."

    # Copy user unit files
    if [[ -d "$BACKUP_DIR/services/user-units" ]]; then
        mkdir -p "$HOME/.config/systemd/user"
        cp -a "$BACKUP_DIR/services/user-units/"* "$HOME/.config/systemd/user/" 2>/dev/null || true
        systemctl --user daemon-reload
        ok "User unit files copied"
    fi

    # Enable system services
    if [[ -f "$BACKUP_DIR/services/system-enabled.txt" ]]; then
        log "Enabling system services..."
        # Skip default/base services, enable custom ones
        CUSTOM_SERVICES=(
            bluetooth.service
            NetworkManager.service
            NetworkManager-dispatcher.service
            sddm.service
            sshd.service
            tailscaled.service
            surfsharkd2.service
            input-remapper.service
            nvidia-hibernate.service
            nvidia-resume.service
            nvidia-suspend.service
            nvidia-suspend-then-hibernate.service
        )
        for svc in "${CUSTOM_SERVICES[@]}"; do
            if grep -q "$svc" "$BACKUP_DIR/services/system-enabled.txt" 2>/dev/null; then
                sudo systemctl enable "$svc" 2>/dev/null && log "  $svc" || warn "  $svc not available"
            fi
        done
    fi

    # Enable user services
    if [[ -f "$BACKUP_DIR/services/user-enabled.txt" ]]; then
        log "Enabling user services..."
        while IFS= read -r line; do
            unit=$(echo "$line" | awk '{print $1}')
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
echo -e "${AMB}═══════════════════════════════════════════${RST}"
echo -e "${GRN}  Restore complete!${RST}"
echo -e "${AMB}═══════════════════════════════════════════${RST}"
echo ""
echo -e "${BOLD}Manual steps remaining:${RST}"
echo "  1. sudo grub-mkconfig -o /boot/grub/grub.cfg"
echo "  2. sudo mkinitcpio -P"
echo "  3. Log out and back in (or reboot)"
echo "  4. Re-clone git repos (.git was excluded from backup):"
echo "     cd ~/website && git init && git remote add origin <url>"
echo "     cd ~/Exocortex && git init && git remote add origin <url>"
echo "  5. Run 'node_modules' installs where needed:"
echo "     cd ~/website && npm install"
echo "     cd ~/sauron && npm install (or bun install)"
echo "  6. Log into apps: Firefox, Chrome, Discord (Vesktop), Surfshark"
echo "  7. Check ~/.ssh/config and test connections"
echo ""
