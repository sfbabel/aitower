#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  ARCH BACKUP — Declarative System Snapshot
#  Captures everything needed to reconstruct this Arch install
#  Usage: arch-backup.sh [target_dir]
#    target_dir defaults to /mnt/backup/archbox
# ═══════════════════════════════════════════════════════════
set -euo pipefail

RED='\033[0;31m'
GRN='\033[0;32m'
YLW='\033[1;33m'
AMB='\033[38;5;214m'
RST='\033[0m'

log()  { echo -e "${AMB}▸${RST} $*"; }
ok()   { echo -e "${GRN}✓${RST} $*"; }
warn() { echo -e "${YLW}⚠${RST} $*"; }
err()  { echo -e "${RED}✗${RST} $*" >&2; }

# ── Target directory ──────────────────────────────────────
BACKUP_ROOT="${1:-/mnt/backup/archbox}"
TIMESTAMP=$(date +%Y-%m-%d_%H%M)
BACKUP_DIR="$BACKUP_ROOT/$TIMESTAMP"
LATEST_LINK="$BACKUP_ROOT/latest"

if [[ ! -d "$BACKUP_ROOT" ]]; then
    err "Backup target '$BACKUP_ROOT' does not exist."
    err "Mount your USB stick and pass the path, e.g.:"
    err "  arch-backup.sh /run/media/$USER/USBSTICK/archbox"
    exit 1
fi

mkdir -p "$BACKUP_DIR"/{system,packages,configs,dotfiles,services,data,scripts}

log "Backing up to: $BACKUP_DIR"

# ── 1. Package Lists ─────────────────────────────────────
log "Capturing package lists..."
pacman -Qen > "$BACKUP_DIR/packages/official-explicit.txt"
pacman -Qem > "$BACKUP_DIR/packages/aur-explicit.txt"
pacman -Q   > "$BACKUP_DIR/packages/all-installed.txt"
ok "Packages: $(wc -l < "$BACKUP_DIR/packages/official-explicit.txt") official, $(wc -l < "$BACKUP_DIR/packages/aur-explicit.txt") AUR"

# ── 2. System Configs ────────────────────────────────────
log "Capturing system configs..."
SYSCONF="$BACKUP_DIR/system"

# Core system files
for f in /etc/pacman.conf /etc/pacman.d/mirrorlist \
         /etc/fstab /etc/hostname /etc/hosts \
         /etc/locale.conf /etc/locale.gen /etc/vconsole.conf \
         /etc/mkinitcpio.conf /etc/default/grub \
         /etc/makepkg.conf /etc/environment \
         /etc/modprobe.d /etc/sysctl.d \
         /etc/X11/xorg.conf.d /etc/udev/rules.d; do
    if [[ -e "$f" ]]; then
        if [[ -d "$f" ]]; then
            cp -a "$f" "$SYSCONF/$(basename "$f")" 2>/dev/null || true
        else
            mkdir -p "$SYSCONF/$(dirname "${f#/etc/}")"
            cp -a "$f" "$SYSCONF/${f#/etc/}" 2>/dev/null || true
        fi
    fi
done

# Partition layout for reference
lsblk -o NAME,SIZE,TYPE,FSTYPE,LABEL,UUID,MOUNTPOINT > "$SYSCONF/partition-layout.txt" 2>/dev/null
sudo fdisk -l > "$SYSCONF/fdisk-output.txt" 2>/dev/null || true
ok "System configs captured"

# ── 3. Systemd Services ──────────────────────────────────
log "Capturing systemd service state..."
SVCDIR="$BACKUP_DIR/services"

# Enabled services
systemctl list-unit-files --state=enabled --no-pager | grep enabled > "$SVCDIR/system-enabled.txt" 2>/dev/null
systemctl --user list-unit-files --state=enabled --no-pager | grep enabled > "$SVCDIR/user-enabled.txt" 2>/dev/null

# User unit files (the actual .service/.timer files)
if [[ -d "$HOME/.config/systemd/user" ]]; then
    cp -a "$HOME/.config/systemd/user" "$SVCDIR/user-units"
fi

# Custom system units (non-symlink, non-default)
mkdir -p "$SVCDIR/system-units"
for unit in /etc/systemd/system/*.service /etc/systemd/system/*.timer; do
    [[ -e "$unit" ]] && cp -a "$unit" "$SVCDIR/system-units/" 2>/dev/null || true
done
ok "Services captured"

# ── 4. Dotfiles & Configs ────────────────────────────────
log "Capturing dotfiles and user configs..."
DOTDIR="$BACKUP_DIR/dotfiles"

# Shell configs
for f in .zshrc .bashrc .bash_profile .zsh_history .gitconfig; do
    [[ -f "$HOME/$f" ]] && cp "$HOME/$f" "$DOTDIR/" 2>/dev/null || true
done

# Important ~/.config directories (skip bloated/regeneratable ones)
IMPORTANT_CONFIGS=(
    kitty
    fastfetch
    exocortex
    obs-studio
    spicetify
    Kvantum
    OpenRGB
    fcitx5
    gtk-3.0
    gtk-4.0
    nvim
    btop
    plasma-org.kde.plasma.desktop-appletsrc
    kdeglobals
    kwinrc
    kglobalshortcutsrc
    kcminputrc
    dolphinrc
    konsolerc
    rice-rollback-copperforge-2026-02-13
)

mkdir -p "$DOTDIR/config"
for item in "${IMPORTANT_CONFIGS[@]}"; do
    src="$HOME/.config/$item"
    if [[ -e "$src" ]]; then
        if [[ -d "$src" ]]; then
            rsync -a --quiet "$src/" "$DOTDIR/config/$item/"
        else
            cp "$src" "$DOTDIR/config/"
        fi
    fi
done

# KDE plasma config files (top-level in .config)
for f in "$HOME"/.config/k*rc "$HOME"/.config/plasma*; do
    [[ -f "$f" ]] && cp "$f" "$DOTDIR/config/" 2>/dev/null || true
done

# ~/.local/bin (custom scripts)
if [[ -d "$HOME/.local/bin" ]]; then
    rsync -a --quiet "$HOME/.local/bin/" "$DOTDIR/local-bin/"
fi

# ~/.ssh (keys — IMPORTANT)
if [[ -d "$HOME/.ssh" ]]; then
    cp -a "$HOME/.ssh" "$DOTDIR/ssh"
    chmod 700 "$DOTDIR/ssh"
fi

ok "Dotfiles captured"

# ── 5. User Data ─────────────────────────────────────────
log "Syncing user data..."
DATADIR="$BACKUP_DIR/data"

# Critical directories
DATA_DIRS=(
    university
    website
    Exocortex
    sauron
    Documents
    Desktop
    Pictures
    tbdchat
    Vencord
    arrpc
    msc-mods
    MSCLoader
    Themes
)

for dir in "${DATA_DIRS[@]}"; do
    src="$HOME/$dir"
    if [[ -d "$src" ]]; then
        rsync -a --quiet \
            --exclude='node_modules' \
            --exclude='.git' \
            --exclude='__pycache__' \
            --exclude='.next' \
            --exclude='dist' \
            --exclude='.venv' \
            --exclude='venv' \
            "$src/" "$DATADIR/$dir/"
        SIZE=$(du -sh "$DATADIR/$dir" | cut -f1)
        log "  $dir ($SIZE)"
    fi
done

ok "User data synced"

# ── 6. System Info Snapshot ───────────────────────────────
log "Capturing system info..."
INFO="$BACKUP_DIR/system-info.txt"
{
    echo "═══ ARCH BACKUP SNAPSHOT ═══"
    echo "Date: $(date)"
    echo "Hostname: $(hostname)"
    echo "Kernel: $(uname -r)"
    echo "User: $USER"
    echo "Shell: $SHELL"
    echo ""
    echo "═══ GPU ═══"
    lspci | grep -i vga 2>/dev/null || true
    echo ""
    echo "═══ CPU ═══"
    grep "model name" /proc/cpuinfo | head -1
    echo ""
    echo "═══ MEMORY ═══"
    free -h | head -2
    echo ""
    echo "═══ DISK ═══"
    df -h / /boot/efi
    echo ""
    echo "═══ TIMEZONE ═══"
    readlink /etc/localtime
    echo ""
    echo "═══ LOCALE ═══"
    cat /etc/locale.conf
} > "$INFO" 2>/dev/null

# ── 7. Copy the restore script ───────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/arch-restore.sh" ]]; then
    cp "$SCRIPT_DIR/arch-restore.sh" "$BACKUP_DIR/scripts/"
    chmod +x "$BACKUP_DIR/scripts/arch-restore.sh"
fi
cp "${BASH_SOURCE[0]}" "$BACKUP_DIR/scripts/arch-backup.sh"
chmod +x "$BACKUP_DIR/scripts/arch-backup.sh"

# ── 8. Update latest symlink ─────────────────────────────
rm -f "$LATEST_LINK"
ln -s "$TIMESTAMP" "$LATEST_LINK"

# ── Summary ──────────────────────────────────────────────
TOTAL=$(du -sh "$BACKUP_DIR" | cut -f1)
echo ""
echo -e "${AMB}═══════════════════════════════════════════${RST}"
echo -e "${GRN}  Backup complete: $TOTAL${RST}"
echo -e "${AMB}  Location: $BACKUP_DIR${RST}"
echo -e "${AMB}═══════════════════════════════════════════${RST}"
echo ""
echo "To restore from a fresh Arch install, run:"
echo "  bash $BACKUP_DIR/scripts/arch-restore.sh $BACKUP_DIR"
