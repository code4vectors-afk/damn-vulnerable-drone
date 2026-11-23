import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fstatic from "@fastify/static";
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { config, slotIps } from "./config.js";
import { db, audit } from "./db.js";
import { register, login, logout, userFromToken, type User } from "./auth.js";
import {
  startLab,
  stopLab,
  resetLab,
  resetAirframe,
  checkLabHealth,
  labForUser,
  activeLabs,
  startReaper,
  reconcile,
  type Lab,
} from "./labs.js";
import { handleHttp, handleUpgrade } from "./proxy.js";
import { askCopilot, getAiQuota } from "./ai.js";
import { runtime } from "./runtime.js";

const app = Fastify({
  serverFactory: (handler) => {
    const s = http.createServer((req, res) => {
      if (!handleHttp(req, res)) handler(req, res);
    });
    s.on("upgrade", handleUpgrade);
    return s;
  },
});
await app.register(cookie);
await app.register(fstatic, { root: path.resolve(import.meta.dirname, "../public") });

const cookieOpts = {
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  domain: `.${config.baseHost}`,
  maxAge: 12 * 3600,
};

const me = (req: any): User | null => userFromToken(req.cookies.dvd_sid);
const guard = (req: any, reply: any, admin = false) => {
  const u = me(req);
  if (!u) {
    reply.code(401).send({ error: "Not signed in" });
    return null;
  }
  if (admin && !u.is_admin) {
    reply.code(403).send({ error: "Admin only" });
    return null;
  }
  return u;
};
const wrap = (fn: (req: any, reply: any) => unknown) => async (req: any, reply: any) => {
  try {
    return await fn(req, reply);
  } catch (e: any) {
    return reply.code(400).send({ error: e.message });
  }
};

const labUrls = (id: string) => ({
  sim: `http://sim-${id}.${config.baseHost}:${config.port}`,
  admin: `http://admin-${id}.${config.baseHost}:${config.port}`,
  term: `http://term-${id}.${config.baseHost}:${config.port}`,
  gcs: `http://gcs-${id}.${config.baseHost}:${config.port}/vnc.html?autoconnect=1&resize=scale&path=websockify`,
});

const serializeLab = (l: Lab | undefined) =>
  l
    ? {
        ...l,
        urls: labUrls(l.id),
        ips: slotIps(l.slot),
        idleDeadline: l.last_seen + config.idleMs,
        hardDeadline: l.started + config.hardCapMs,
      }
    : null;

function loadCatalog() {
  if (!fs.existsSync(config.catalogPath)) return { count: 0, scenarios: [] };
  return JSON.parse(fs.readFileSync(config.catalogPath, "utf8"));
}

// --- Auth ---
app.post(
  "/api/register",
  wrap(async (req, reply) => {
    const { username, password, invite, tos } = req.body ?? {};
    const u = register(username, password, invite, !!tos);
    const token = login(username, password, req.ip);
    reply.setCookie("dvd_sid", token, cookieOpts);
    return { user: u };
  })
);
app.post(
  "/api/login",
  wrap(async (req, reply) => {
    const { username, password } = req.body ?? {};
    reply.setCookie("dvd_sid", login(username, password, req.ip), cookieOpts);
    return { user: db.prepare("SELECT id,username,is_admin FROM users WHERE username=?").get(username) };
  })
);
app.post(
  "/api/logout",
  wrap(async (req, reply) => {
    if (req.cookies.dvd_sid) logout(req.cookies.dvd_sid);
    reply.clearCookie("dvd_sid", cookieOpts);
    return { ok: true };
  })
);
app.get(
  "/api/me",
  wrap(async (req, reply) => {
    const u = guard(req, reply);
    if (!u) return;
    const l = labForUser(u.id);
    return {
      user: u,
      lab: serializeLab(l),
      runtime: { name: runtime.name, supportsWifi: runtime.supportsWifi, maxSlots: config.maxSlots },
      activeSlotCount: activeLabs().length,
      ai: getAiQuota(u.id),
    };
  })
);

// --- Lab lifecycle ---
app.post(
  "/api/lab/start",
  wrap(async (req, reply) => {
    const u = guard(req, reply);
    if (!u) return;
    const l = startLab(u.id);
    return { lab: serializeLab(l) };
  })
);
app.post(
  "/api/lab/stop",
  wrap(async (req, reply) => {
    const u = guard(req, reply);
    if (!u) return;
    const l = labForUser(u.id);
    if (l) await stopLab(l.id);
    return { ok: true };
  })
);
app.post(
  "/api/lab/reset-airframe",
  wrap(async (req, reply) => {
    const u = guard(req, reply);
    if (!u) return;
    const l = labForUser(u.id);
    if (!l) throw new Error("No active lab");
    await resetAirframe(l.id);
    return { ok: true };
  })
);
app.post(
  "/api/lab/reset",
  wrap(async (req, reply) => {
    const u = guard(req, reply);
    if (!u) return;
    const l = labForUser(u.id);
    if (l) await resetLab(l.id);
    return { ok: true };
  })
);
app.get(
  "/api/lab/health",
  wrap(async (req, reply) => {
    const u = guard(req, reply);
    if (!u) return;
    const l = labForUser(u.id);
    if (!l) return { health: null };
    return { health: await checkLabHealth(l.id), status: l.status };
  })
);

// --- Scenarios & Progress ---
app.get(
  "/api/scenarios",
  wrap(async (req, reply) => {
    const u = guard(req, reply);
    if (!u) return;
    const catalog = loadCatalog();
    const rows = db
      .prepare("SELECT scenario_id, completed_steps, completed_at FROM progress WHERE user_id=?")
      .all(u.id) as { scenario_id: string; completed_steps: string; completed_at: number | null }[];
    const progress: Record<string, { steps: number[]; completedAt: number | null }> = {};
    for (const r of rows) {
      progress[r.scenario_id] = {
        steps: JSON.parse(r.completed_steps || "[]"),
        completedAt: r.completed_at,
      };
    }
    return { ...catalog, progress };
  })
);

app.post(
  "/api/progress",
  wrap(async (req, reply) => {
    const u = guard(req, reply);
    if (!u) return;
    const { scenarioId, steps, completed } = req.body ?? {};
    if (typeof scenarioId !== "string" || !scenarioId) throw new Error("scenarioId required");
    const stepArr = Array.isArray(steps) ? steps.filter((n) => Number.isInteger(n)) : [];
    const completedAt = completed ? Date.now() : null;
    db.prepare(
      `INSERT INTO progress(user_id, scenario_id, completed_steps, completed_at) VALUES(?,?,?,?)
       ON CONFLICT(user_id, scenario_id) DO UPDATE SET completed_steps=excluded.completed_steps, completed_at=excluded.completed_at`
    ).run(u.id, scenarioId, JSON.stringify(stepArr), completedAt);
    return { ok: true, scenarioId, steps: stepArr, completedAt };
  })
);

// --- Grounded Tactical AI Copilot (Track C) ---
app.get(
  "/api/ai/status",
  wrap(async (req, reply) => {
    const u = guard(req, reply);
    if (!u) return;
    return getAiQuota(u.id);
  })
);

app.post(
  "/api/ai/chat",
  wrap(async (req, reply) => {
    const u = guard(req, reply);
    if (!u) return;
    const { message, scenarioId, modelTier } = req.body ?? {};
    const l = labForUser(u.id);
    return await askCopilot({
      userId: u.id,
      message: String(message ?? ""),
      scenarioId: scenarioId ?? null,
      slot: l?.slot ?? null,
      modelTier: modelTier === "pro" ? "pro" : "fast",
    });
  })
);

// --- Admin C2 ---
app.post(
  "/api/admin/invites",
  wrap(async (req, reply) => {
    const u = guard(req, reply, true);
    if (!u) return;
    const code = crypto.randomBytes(9).toString("base64url");
    db.prepare("INSERT INTO invites(code,max_uses,admin,created) VALUES(?,?,0,?)").run(
      code,
      Number(req.body?.maxUses ?? 1),
      Date.now()
    );
    audit(u.id, "invite_create", code);
    return { code };
  })
);
app.delete(
  "/api/admin/invites/:code",
  wrap(async (req, reply) => {
    const u = guard(req, reply, true);
    if (!u) return;
    db.prepare("UPDATE invites SET revoked=1 WHERE code=?").run(req.params.code);
    audit(u.id, "invite_revoke", req.params.code);
    return { ok: true };
  })
);
app.get(
  "/api/admin/state",
  wrap(async (req, reply) => {
    const u = guard(req, reply, true);
    if (!u) return;
    const labs = db
      .prepare(
        `SELECT l.*, u.username FROM labs l LEFT JOIN users u ON u.id=l.user_id WHERE l.status!='stopped' ORDER BY l.slot ASC`
      )
      .all();
    const users = db.prepare("SELECT id, username, is_admin, tos_at, created FROM users ORDER BY id ASC").all();
    const invites = db.prepare("SELECT * FROM invites ORDER BY created DESC").all();
    const recentAudit = db
      .prepare(
        `SELECT a.*, u.username FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.ts DESC LIMIT 60`
      )
      .all();
    return { labs, users, invites, audit: recentAudit };
  })
);
app.post(
  "/api/admin/labs/:id/kill",
  wrap(async (req, reply) => {
    const u = guard(req, reply, true);
    if (!u) return;
    await stopLab(req.params.id, "admin");
    return { ok: true };
  })
);

// Bootstrap: ensure an admin invite exists
const bootstrap = config.adminInvite || crypto.randomBytes(9).toString("base64url");
if (!db.prepare("SELECT 1 FROM users WHERE is_admin=1").get()) {
  db.prepare("INSERT OR REPLACE INTO invites(code,max_uses,admin,created) VALUES(?,1,1,?)").run(bootstrap, Date.now());
  console.log(`\nNo admin yet. First-admin invite code: ${bootstrap}\n`);
}
await reconcile();
startReaper();
await app.listen({ port: config.port, host: config.host });
console.log(`App: http://app.${config.baseHost}:${config.port}  [driver=${runtime.name}, ai=${config.ai.apiKey ? "configured" : "local-rag"}]`);
