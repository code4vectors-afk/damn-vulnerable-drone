#!/usr/bin/env bash
# Phase 5: Linux VM Driver (Incus / QEMU) for full multi-user DVD parity:
#  - Isolated Linux kernel per slot with `mac80211_hwsim` virtual Wi-Fi (WEP + WPA2)
#  - Literal 10.13.0.0/24 + 192.168.13.0/24 inside each VM with zero cross-user collisions
#  - Optional Full 3D Gazebo mode on GPU-equipped Linux hosts
#
# Usage: vm-slot.sh <up|down> <slot 1-5>
set -euo pipefail

CMD="${1:?up|down}"
SLOT="${2:?slot 1-5}"
[[ "$SLOT" =~ ^[1-5]$ ]] || { echo "slot must be 1-5" >&2; exit 1; }

VM_NAME="dvd-slot-${SLOT}"
SIM_PORT=$((8100 + SLOT * 10))
ADMIN_PORT=$((3100 + SLOT * 10))
TERM_PORT=$((7600 + SLOT * 10))
GCS_PORT=$((6100 + SLOT * 10))

if ! command -v incus >/dev/null 2>&1; then
  echo "incus CLI not found. Install Incus on a Linux host (see deploy/README.md) or use RUNTIME_DRIVER=docker-lite." >&2
  exit 1
fi

case "$CMD" in
  up)
    if ! incus info "$VM_NAME" >/dev/null 2>&1; then
      incus launch images:ubuntu/22.04 "$VM_NAME" --vm \
        -c limits.cpu=4 -c limits.memory=6GiB
      incus config device add "$VM_NAME" sim proxy listen=tcp:127.0.0.1:${SIM_PORT} connect=tcp:127.0.0.1:8000
      incus config device add "$VM_NAME" admin proxy listen=tcp:127.0.0.1:${ADMIN_PORT} connect=tcp:127.0.0.1:3000
      incus config device add "$VM_NAME" term proxy listen=tcp:127.0.0.1:${TERM_PORT} connect=tcp:127.0.0.1:7681
      incus config device add "$VM_NAME" gcs proxy listen=tcp:127.0.0.1:${GCS_PORT} connect=tcp:127.0.0.1:6080
    fi
    incus exec "$VM_NAME" -- bash -lc "modprobe mac80211_hwsim radios=3 && cd /opt/dvd && ./start.sh --wifi"
    ;;
  down)
    incus delete -f "$VM_NAME" 2>/dev/null || true
    ;;
  *)
    echo "Unknown command: $CMD" >&2; exit 1 ;;
esac
