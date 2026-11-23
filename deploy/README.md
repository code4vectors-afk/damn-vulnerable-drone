# DVDrone Web Range — Deployment & Remote Beta Guide

## 1. Local Prototype (macOS Apple Silicon / Docker Lite)
```bash
cd apps/orchestrator
npx tsx src/index.ts
# Open http://app.dvd.localhost:4000 (Chrome or Firefox)
```

## 2. Remote Beta via Tailscale (Partner Access)
1. Invite your partner to your tailnet (or share your Mac via Tailscale Node Sharing).
2. Run:
   ```bash
   ./scripts/start-tailscale.sh
   ```
3. Share the printed `http://app.<your-tailscale-ip>.nip.io:4000` URL + an invite token minted in **Admin C2**.

## 3. Cloud Linux Production Sizing (1–5 Concurrent Users)
| Mode | Recommended Host | Approx Cost | Capabilities |
| --- | --- | --- | --- |
| **Lite + ROS 2** (`docker-lite`) | 8–16 vCPU, 16–32 GB RAM Linux VPS (Hetzner / DO) | \$25–\$60/mo | All 39 network/MAVLink/companion/ROS 2/QGC scenarios |
| **Full Wi-Fi + 3D Gazebo** (`linux-vm`) | Bare-metal Linux or GPU VM with KVM + Incus (`mac80211_hwsim`) | \$90–\$200/mo | All 42 scenarios including WEP/WPA2 virtual Wi-Fi & 3D Gazebo |

### Linux Production Hardening
1. Apply host egress lockdown: `sudo nft -f deploy/firewall/egress-lockdown.nft`
2. Configure wildcard DNS `*.sim.yourdomain.com` → host IP and run Caddy with `deploy/caddy/Caddyfile`.
3. Set `BASE_HOST=sim.yourdomain.com`, `AI_API_KEY=...`, and `RUNTIME_DRIVER=docker-lite` (or `linux-vm`) in `.env`.
