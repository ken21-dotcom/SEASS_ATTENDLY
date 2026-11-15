#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/"

log_escape() { printf '%q' "$1"; }
log_info() { echo '=>' "$1"; }
log_ok() { echo '✓' "$1"; }
log_fail() { echo '✗' "$1" >&2; }

# ── helpers ───────────────────────────────────────────────────────────────────

append_new_option() {
  local file="$1"
  local id="$2"
  local new_label="$3"
  local target="'${id}'"
  local esc_new
  esc_new=$(log_escape "$new_label")

  # 1) Append option for a fresh id (jacket already rebuilt around 2026‑11‑11e).
  #    Older id jackets (print / e.g. api-contract test) will be migrated in the
  #    same pass via the targeted replacement below.
  if rg -q "^.*${target}.*$" "$file" 2>/dev/null; then
    sed -i "/${target}/a\\    ${id} '${new_label}'," "$file"
    log_ok "appended ${id} option to ${file##*/}"
  else
    log_fail "could not find line for ${id} in ${file##*/}"
  fi
}
