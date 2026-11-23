#!/usr/bin/env bash
# Usage: scripts/slot.sh <up|down|ps|logs> <slot 1-5>
set -euo pipefail
cmd="${1:?up|down|ps|logs}"; slot="${2:?slot 1-5}"
[[ "$slot" =~ ^[1-5]$ ]] || { echo "slot must be 1-5" >&2; exit 1; }
cd "$(dirname "$0")/../docker/templates"
export SLOT="$slot"
f=(-f docker-compose.slot.yaml)
case "$cmd" in
  up)   docker-compose "${f[@]}" up -d --build ;;
  down) docker-compose "${f[@]}" down -v --remove-orphans ;;
  ps)   docker-compose "${f[@]}" ps ;;
  logs) docker-compose "${f[@]}" logs --tail=100 ;;
esac
