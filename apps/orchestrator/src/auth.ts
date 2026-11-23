import crypto from "node:crypto";
import { db, audit } from "./db.js";

export function hashPw(pw: string) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${crypto.scryptSync(pw, salt, 64).toString("hex")}`;
}
export function verifyPw(pw: string, stored: string) {
  const [, s, h] = stored.split("$");
  const calc = crypto.scryptSync(pw, Buffer.from(s, "hex"), 64);
  return crypto.timingSafeEqual(calc, Buffer.from(h, "hex"));
}
export interface User { id: number; username: string; is_admin: number; tos_at: number | null }

export function register(username: string, password: string, code: string, tos: boolean): User {
  if (!/^[a-zA-Z0-9_-]{3,24}$/.test(username)) throw new Error("Invalid callsign (3-24 chars, a-z 0-9 _ -)");
  if (password.length < 10) throw new Error("Password must be at least 10 characters");
  if (!tos) throw new Error("You must accept the Authorized Training agreement");
  const inv = db.prepare("SELECT * FROM invites WHERE code=?").get(code) as any;
  if (!inv || inv.revoked || inv.uses >= inv.max_uses) throw new Error("Invalid invite code");
  if (db.prepare("SELECT 1 FROM users WHERE username=?").get(username)) throw new Error("Callsign taken");
  const tx = db.transaction(() => {
    db.prepare("UPDATE invites SET uses=uses+1 WHERE code=?").run(code);
    return db.prepare("INSERT INTO users(username,pw,is_admin,tos_at,created) VALUES(?,?,?,?,?)")
      .run(username, hashPw(password), inv.admin, Date.now(), Date.now()).lastInsertRowid as number;
  });
  const id = Number(tx());
  audit(id, "register", username);
  return { id, username, is_admin: inv.admin, tos_at: Date.now() };
}

// naive in-memory login rate limit
const fails = new Map<string, { n: number; until: number }>();
export function login(username: string, password: string, ip: string): string {
  const key = `${ip}|${username}`; const f = fails.get(key);
  if (f && f.until > Date.now()) throw new Error("Too many attempts, try later");
  const u = db.prepare("SELECT * FROM users WHERE username=?").get(username) as any;
  if (!u || !verifyPw(password, u.pw)) {
    const n = (f?.n ?? 0) + 1; fails.set(key, { n, until: n >= 5 ? Date.now() + 5 * 60_000 : 0 });
    throw new Error("Invalid credentials");
  }
  fails.delete(key);
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(token, u.id, Date.now() + 12 * 3600_000);
  audit(u.id, "login", ip);
  return token;
}
export function userFromToken(token?: string): User | null {
  if (!token) return null;
  return (db.prepare(`SELECT u.id,u.username,u.is_admin,u.tos_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?`)
    .get(token, Date.now()) as User | undefined) ?? null;
}
export const logout = (token: string) => db.prepare("DELETE FROM sessions WHERE token=?").run(token);
