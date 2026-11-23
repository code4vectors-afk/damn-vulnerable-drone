# Phase 1 — Upstream DVD Audit

Pinned: `upstream/Damn-Vulnerable-Drone` (see `version.txt`).

## Findings
| Item | Finding | Handling |
| --- | --- | --- |
| Static IPs | `10.13.0.2–.5` hardcoded only in compose YAML; elsewhere only in docs/scenario text | Slot template uses `10.13.${SLOT}.x`; scenario text must be templated with slot IPs (Phase 3) |
| Container names | Simulator looks up containers by fixed name (`routes/utils.py`, `docker.from_env()`, `exec_run`) | `docker/overrides/utils.py` adds `SLOT_PREFIX`, bind-mounted per slot |
| **Docker socket** | Simulator mounts host `/var/run/docker.sock` | **Critical for outsiders.** Replaced with per-slot `docker-socket-proxy` (containers+exec only). Residual risk: exec into privileged containers |
| `privileged: true` | All DVD containers are privileged | Kept (upstream needs it); mitigated by `internal` net. For untrusted users prefer the Phase 5 VM driver |
| Upstream networks | `internal: false` | Slot net is `internal: true`; only the `gateway` publishes ports on 127.0.0.1 |
| GCS | Needs X11 + `/dev/dri` | Removed; `HEADLESS=1` supported by `launch_qgc.sh` |
| Wi-Fi | Needs `mac80211_hwsim` | Not on macOS; Phase 5 |
| X-Frame-Options/CSP | Not yet checked (needs running stack) | TODO when booting |

## Not yet verified (needs Docker daemon access)
Docker is not reachable from the agent sandbox, so the stack has not been booted. Run `scripts/slot.sh up 1` and `up 2`, then check RAM/CPU with `docker stats`.
