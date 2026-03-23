#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  Shared utilities for arch-backup / arch-restore
# ═══════════════════════════════════════════════════════════

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

# Load config file. Searches:
#   1. Same directory as the calling script
#   2. Explicit path passed as $1
load_config() {
    local script_dir config_path
    script_dir="$(cd "$(dirname "${BASH_SOURCE[1]}")" && pwd)"

    if [[ -n "${1:-}" && -f "$1" ]]; then
        config_path="$1"
    elif [[ -f "$script_dir/backup.conf" ]]; then
        config_path="$script_dir/backup.conf"
    else
        err "Cannot find backup.conf"
        exit 1
    fi

    # shellcheck source=backup.conf
    source "$config_path"
    log "Config loaded from: $config_path"
}

# Build rsync exclude args from RSYNC_EXCLUDES array
build_rsync_excludes() {
    local excludes=()
    for pattern in "${RSYNC_EXCLUDES[@]}"; do
        excludes+=(--exclude="$pattern")
    done
    echo "${excludes[@]}"
}

# Check if a service name is in the DEFAULT_SERVICES skip list
is_default_service() {
    local svc="$1"
    for default in "${DEFAULT_SERVICES[@]}"; do
        [[ "$svc" == "$default" ]] && return 0
    done
    return 1
}
