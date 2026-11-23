import crypto from "node:crypto";
import { config } from "./config.js";
import { db, audit } from "./db.js";
import { runtime, type ServiceHealth } from "./runtime.js";

export interface Lab {
  id: string;
  user_id: number;
  slot: number;
  status: string;
  started: number;
  last_seen: number;
}

export const activeLabs = () => db.prepare("SELECT * FROM labs WHERE status!='stopped'").all() as Lab[];
export const labForUser = (uid: number) =>
  db.prepare("SELECT * FROM labs WHERE user_id=? AND status!='stopped'").get(uid) as Lab | undefined;
export const labById = (id: string) =>
  db.prepare("SELECT * FROM labs WHERE id=? AND status!='stopped'").get(id) as Lab | undefined;
export const touch = (id: string) => db.prepare("UPDATE labs SET last_seen=? WHERE id=?").run(Date.now(), id);

export function startLab(userId: number): Lab {
  if (labForUser(userId)) throw new Error("You already have an active lab");
  const used = new Set(activeLabs().map((l) => l.slot));
  let slot = 0;
  for (let i = 1; i <= config.maxSlots; i++) {
    if (!used.has(i)) {
      slot = i;
      break;
    }
  }
  if (!slot) throw new Error("All lab slots are busy. Try again later.");
  const id = crypto.randomBytes(5).toString("hex");
  const now = Date.now();
  db.prepare("INSERT INTO labs VALUES(?,?,?,?,?,?)").run(id, userId, slot, "booting", now, now);
  audit(userId, "lab_start", `slot ${slot} (${runtime.name})`);

  runtime
    .provisionSlot(slot)
    .then(async () => {
      for (let i = 0; i < 60; i++) {
        const h = await runtime.checkHealth(slot);
        if (h.sim && h.admin && h.term) {
          db.prepare("UPDATE labs SET status='healthy' WHERE id=? AND status='booting'").run(id);
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      throw new Error("health timeout");
    })
    .catch((e) => {
      audit(userId, "lab_error", String(e));
      db.prepare("UPDATE labs SET status='error' WHERE id=?").run(id);
    });

  return labById(id)!;
}

export async function stopLab(id: string, reason = "user") {
  const l = db.prepare("SELECT * FROM labs WHERE id=?").get(id) as Lab | undefined;
  if (!l || l.status === "stopped") return;
  db.prepare("UPDATE labs SET status='stopping' WHERE id=?").run(id);
  try {
    await runtime.destroySlot(l.slot);
  } finally {
    db.prepare("UPDATE labs SET status='stopped' WHERE id=?").run(id);
    audit(l.user_id, "lab_stop", `${reason} slot ${l.slot}`);
  }
}

export async function resetAirframe(id: string) {
  const l = labById(id);
  if (!l || l.status !== "healthy") throw new Error("Lab is not healthy");
  await runtime.resetAirframe(l.slot);
  touch(l.id);
  audit(l.user_id, "airframe_reset", `slot ${l.slot}`);
}

export async function resetLab(id: string) {
  const l = labById(id);
  if (!l) return;
  db.prepare("UPDATE labs SET status='booting' WHERE id=?").run(id);
  try {
    await runtime.destroySlot(l.slot);
    await runtime.provisionSlot(l.slot);
    for (let i = 0; i < 60; i++) {
      const h = await runtime.checkHealth(l.slot);
      if (h.sim && h.admin && h.term) {
        db.prepare("UPDATE labs SET status='healthy', last_seen=? WHERE id=?").run(Date.now(), id);
        audit(l.user_id, "lab_rebuild", `slot ${l.slot}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error("rebuild health timeout");
  } catch (e) {
    db.prepare("UPDATE labs SET status='error' WHERE id=?").run(id);
    throw e;
  }
}

export async function checkLabHealth(id: string): Promise<ServiceHealth | null> {
  const l = labById(id);
  if (!l) return null;
  return runtime.checkHealth(l.slot);
}

export function startReaper() {
  setInterval(() => {
    const now = Date.now();
    for (const l of activeLabs()) {
      if (l.status === "stopping") continue;
      if (now - l.last_seen > config.idleMs) stopLab(l.id, "idle").catch(() => {});
      else if (now - l.started > config.hardCapMs) stopLab(l.id, "hardcap").catch(() => {});
    }
  }, 60_000).unref();
}

export async function reconcile() {
  for (const l of activeLabs()) {
    await stopLab(l.id, "restart").catch(() => {});
  }
}
