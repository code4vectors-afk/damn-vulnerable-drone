import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "../../..");

// Load .env from repo root (and apps/orchestrator/.env if present) without overriding real env vars
for (const envFile of [path.join(ROOT, ".env"), path.join(ROOT, "apps/orchestrator/.env")]) {
  if (!fs.existsSync(envFile)) continue;
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? "0.0.0.0",
  // Base domain for per-lab subdomains. Local: dvd.localhost. Tailscale: <tailscale-ip>.nip.io
  baseHost: process.env.BASE_HOST ?? "dvd.localhost",
  maxSlots: Number(process.env.MAX_SLOTS ?? 5),
  idleMs: Number(process.env.IDLE_MINUTES ?? 45) * 60_000,
  hardCapMs: Number(process.env.HARD_CAP_HOURS ?? 2) * 3600_000,
  dbPath: process.env.DB_PATH ?? path.join(ROOT, "data", "app.db"),
  slotScript: path.join(ROOT, "scripts", "slot.sh"),
  catalogPath: path.join(ROOT, "data", "scenarios", "catalog.json"),
  knowledgePath: path.join(ROOT, "data", "knowledge", "chunks.json"),
  adminInvite: process.env.ADMIN_INVITE ?? "",
  runtimeDriver: (process.env.RUNTIME_DRIVER ?? "docker-lite") as "docker-lite" | "linux-vm",
  ai: {
    apiKey: process.env.AI_API_KEY ?? "",
    baseUrl: (process.env.AI_BASE_URL ?? "https://api.deepseek.com/v1").replace(/\/+$/, ""),
    modelFast: process.env.AI_MODEL_FAST ?? "deepseek-chat",
    modelPro: process.env.AI_MODEL_PRO ?? "deepseek-reasoner",
    dailyReqLimit: Number(process.env.AI_DAILY_REQ_LIMIT ?? 40),
    maxTokens: Number(process.env.AI_MAX_TOKENS ?? 1100),
  },
};

// Host ports published by the slot compose (see docker/templates)
export const slotPorts = (slot: number) => ({
  sim: 8100 + slot * 10,
  admin: 3100 + slot * 10,
  term: 7600 + slot * 10,
  gcs: 6100 + slot * 10,
});

export const slotIps = (slot: number) => ({
  fc: `10.13.${slot}.2`,
  companion: `10.13.${slot}.3`,
  gcs: `10.13.${slot}.4`,
  sim: `10.13.${slot}.5`,
  attacker: `10.13.${slot}.10`,
  subnet: `10.13.${slot}.0/24`,
});
