#!/usr/bin/env bash
# Starts the DVDrone Web Range bound to your Tailscale IP using nip.io wildcard DNS
# so invited tailnet partners can access http://app.<tailscale-ip>.nip.io:4000
set -euo pipefail

if ! command -v tailscale >/dev/null 2>&1; then
  echo "tailscale CLI not found. Install Tailscale or pass BASE_HOST=<ip>.nip.io manually." >&2
  exit 1
fi

TS_IP="$(tailscale ip -4 | head -n 1)"
if [[ -z "$TS_IP" ]]; then
  echo "Could not determine Tailscale IPv4 address. Is Tailscale connected?" >&2
  exit 1
fi

export BASE_HOST="${TS_IP}.nip.io"
export PORT="${PORT:-4000}"

echo "================================================================"
echo "  DVDrone Web Range — Tailscale Remote Beta Mode"
echo "  Share this URL with your tailnet partner:"
echo "    http://app.${BASE_HOST}:${PORT}"
echo "================================================================"

cd "$(dirname "$0")/../apps/orchestrator"
exec npx tsx src/index.ts
