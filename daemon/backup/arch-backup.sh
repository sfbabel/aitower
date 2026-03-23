#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  ARCH BACKUP — Declarative System Snapshot
#  Captures everything needed to reconstruct this Arch install
#  Usage: arch-backup.sh [target_dir]
#    target_dir defaults to /mnt/backup/archbox
# ═══════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"
load_config

# ── Target directory ──────────────────────────────────────
BACKUP_ROOT="${1:-/mnt/backup/archbox}"
TIMESTAMP=$(date +%Y-%m-%d_%H%M)
BACKUP_DIR="$BACKUP_ROOT/$TIMESTAMP"

if [[ ! -d "$BACKUP_ROOT" ]]; then
    err "Backup target '$BACKUP_ROOT' does not exist."
    err "Mount your USB stick and pass the path, e.g.:"
    err "  arch-backup.sh /run/media/$USER/USBSTICK/archbox"
    exit 1
fi

mkdir -p "$BACKUP_DIR"/{system,packages,dotfiles,services,data,scripts}

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

for f in "${ETC_FILES[@]}"; do
    src="/etc/$f"
    if [[ -f "$src" ]]; then
        mkdir -p "$SYSCONF/$(dirname "$f")"
        cp "$src" "$SYSCONF/$f" 2>/dev/null || warn "Failed to copy /etc/$f"
    fi
done

for d in "${ETC_DIRS[@]}"; do
    src="/etc/$d"
    if [[ -d "$src" ]] && ls "$src/"* &>/dev/null; then
        mkdir -p "$SYSCONF/$d"
        cp -a "$src/"* "$SYSCONF/$d/" 2>/dev/null || warn "Failed to copy /etc/$d/"
    fi
done

# Partition layout for reference
lsblk -o NAME,SIZE,TYPE,FSTYPE,LABEL,UUID,MOUNTPOINT > "$SYSCONF/partition-layout.txt" 2>/dev/null || true
sudo fdisk -l > "$SYSCONF/fdisk-output.txt" 2>/dev/null || true
ok "System configs captured"

# ── 3. Systemd Services ──────────────────────────────────
log "Capturing systemd service state..."
SVCDIR="$BACKUP_DIR/services"

systemctl list-unit-files --state=enabled --no-pager | grep enabled > "$SVCDIR/system-enabled.txt" 2>/dev/null || true
systemctl --user list-unit-files --state=enabled --no-pager | grep enabled > "$SVCDIR/user-enabled.txt" 2>/dev/null || true

# User unit files (actual files only, skip .wants symlink dirs)
if [[ -d "$HOME/.config/systemd/user" ]]; then
    mkdir -p "$SVCDIR/user-units"
    find "$HOME/.config/systemd/user" -maxdepth 1 -type f \
        \( -name "*.service" -o -name "*.timer" -o -name "*.path" \) \
        -exec cp {} "$SVCDIR/user-units/" \;
fi

# System units (non-symlink only — symlinks are just aliases)
mkdir -p "$SVCDIR/system-units"
for unit in /etc/systemd/system/*.service /etc/systemd/system/*.timer; do
    [[ -f "$unit" && ! -L "$unit" ]] && cp "$unit" "$SVCDIR/system-units/" 2>/dev/null || true
done
ok "Services captured"

# ── 4. Dotfiles & Configs ────────────────────────────────
log "Capturing dotfiles and user configs..."
DOTDIR="$BACKUP_DIR/dotfiles"

# Shell dotfiles
for f in "${DOTFILES[@]}"; do
    if [[ -f "$HOME/$f" ]]; then
        cp "$HOME/$f" "$DOTDIR/" 2>/dev/null || warn "Failed to copy $f"
    fi
done

# ~/.config items from config list
mkdir -p "$DOTDIR/config"
for item in "${CONFIG_ITEMS[@]}"; do
    src="$HOME/.config/$item"
    if [[ -e "$src" ]]; then
        if [[ -d "$src" ]]; then
            rsync -aL --quiet "$src/" "$DOTDIR/config/$item/"
        else
            cp "$src" "$DOTDIR/config/"
        fi
    fi
done

# KDE config files (globs — deduplicated against CONFIG_ITEMS)
for glob_pattern in "${KDE_GLOBS[@]}"; do
    for f in "$HOME"/.config/$glob_pattern; do
        [[ -f "$f" ]] || continue
        name=$(basename "$f")
        # Skip if already handled by CONFIG_ITEMS
        [[ -e "$DOTDIR/config/$name" ]] && continue
        cp "$f" "$DOTDIR/config/" 2>/dev/null || true
    done
done

# ~/.local/bin
if [[ -d "$HOME/.local/bin" ]]; then
    rsync -aL --quiet "$HOME/.local/bin/" "$DOTDIR/local-bin/"
fi

# SSH keys
if [[ -d "$HOME/.ssh" ]]; then
    if cp -a "$HOME/.ssh" "$DOTDIR/ssh" 2>/dev/null; then
        chmod 700 "$DOTDIR/ssh" 2>/dev/null || true  # no-op on FAT32
    else
        warn "Failed to copy ~/.ssh — keys NOT backed up"
    fi
fi

ok "Dotfiles captured"

# ── 5. User Data ─────────────────────────────────────────
log "Syncing user data..."
DATADIR="$BACKUP_DIR/data"

# Build exclude args once
EXCLUDE_ARGS=()
for pattern in "${RSYNC_EXCLUDES[@]}"; do
    EXCLUDE_ARGS+=(--exclude="$pattern")
done

for dir in "${DATA_DIRS[@]}"; do
    src="$HOME/$dir"
    if [[ -d "$src" ]]; then
        rsync -aL --quiet "${EXCLUDE_ARGS[@]}" "$src/" "$DATADIR/$dir/"
        SIZE=$(du -sh "$DATADIR/$dir" | cut -f1)
        log "  $dir ($SIZE)"
    fi
done

ok "User data synced"

# ── 6. Git Remotes ───────────────────────────────────────
log "Capturing git remote URLs..."
GIT_INFO="$BACKUP_DIR/git-remotes.txt"
: > "$GIT_INFO"
for dir in "${DATA_DIRS[@]}"; do
    repo="$HOME/$dir"
    if [[ -d "$repo/.git" ]]; then
        echo "=== $dir ===" >> "$GIT_INFO"
        git -C "$repo" remote -v >> "$GIT_INFO" 2>/dev/null
        echo "" >> "$GIT_INFO"
    fi
done
ok "Git remotes captured"

# ── 7. System Info Snapshot ───────────────────────────────
log "Capturing system info..."
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
    df -h / /boot/efi 2>/dev/null || true
    echo ""
    echo "═══ TIMEZONE ═══"
    readlink /etc/localtime 2>/dev/null || true
    echo ""
    echo "═══ LOCALE ═══"
    cat /etc/locale.conf 2>/dev/null || true
} > "$BACKUP_DIR/system-info.txt" 2>/dev/null

# ── 8. Bundle scripts + config ────────────────────────────
cp "$SCRIPT_DIR/lib.sh" "$BACKUP_DIR/scripts/"
cp "$SCRIPT_DIR/backup.conf" "$BACKUP_DIR/scripts/"
[[ -f "$SCRIPT_DIR/arch-restore.sh" ]] && cp "$SCRIPT_DIR/arch-restore.sh" "$BACKUP_DIR/scripts/"
cp "${BASH_SOURCE[0]}" "$BACKUP_DIR/scripts/arch-backup.sh"
chmod +x "$BACKUP_DIR/scripts/"*.sh 2>/dev/null || true

# ── 9. Update latest pointer ─────────────────────────────
# Use a text file instead of symlink (FAT32 compatibility)
if ! ln -sf "$TIMESTAMP" "$BACKUP_ROOT/latest" 2>/dev/null; then
    echo "$TIMESTAMP" > "$BACKUP_ROOT/LATEST.txt"
fi

# ── 10. Prune old backups ────────────────────────────────
BACKUPS=($(ls -1d "$BACKUP_ROOT"/????-??-??_???? 2>/dev/null | sort))
if (( ${#BACKUPS[@]} > MAX_BACKUPS )); then
    PRUNE_COUNT=$(( ${#BACKUPS[@]} - MAX_BACKUPS ))
    log "Pruning $PRUNE_COUNT old backup(s)..."
    for (( i=0; i<PRUNE_COUNT; i++ )); do
        log "  Removing $(basename "${BACKUPS[$i]}")"
        rm -rf "${BACKUPS[$i]}"
    done
    ok "Pruned"
fi

# ── 11. Verify backup integrity ───────────────────────────
log "Verifying backup..."
ERRORS=0

# Package lists should be non-empty
for f in "$BACKUP_DIR/packages/official-explicit.txt" "$BACKUP_DIR/packages/aur-explicit.txt"; do
    if [[ ! -s "$f" ]]; then
        warn "Empty package list: $(basename "$f")"
        ERRORS=$((ERRORS + 1))
    fi
done

# SSH keys should exist if source does
if [[ -d "$HOME/.ssh" && ! -d "$BACKUP_DIR/dotfiles/ssh" ]]; then
    warn "SSH keys missing from backup"
    ERRORS=$((ERRORS + 1))
fi

# At least one data dir should have synced
DATA_COUNT=$(find "$BACKUP_DIR/data" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
if (( DATA_COUNT == 0 )); then
    warn "No data directories were synced"
    ERRORS=$((ERRORS + 1))
fi

# Scripts bundle should be complete
for f in lib.sh backup.conf arch-restore.sh arch-backup.sh; do
    if [[ ! -f "$BACKUP_DIR/scripts/$f" ]]; then
        warn "Missing from scripts bundle: $f"
        ERRORS=$((ERRORS + 1))
    fi
done

if (( ERRORS > 0 )); then
    warn "Backup completed with $ERRORS warning(s) — review above"
else
    ok "Backup verified"
fi

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
