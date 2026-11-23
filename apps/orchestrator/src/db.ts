import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  pw TEXT NOT NULL,
  is_admin INTEGER DEFAULT 0,
  tos_at INTEGER,
  created INTEGER
);
CREATE TABLE IF NOT EXISTS invites(
  code TEXT PRIMARY KEY,
  max_uses INTEGER DEFAULT 1,
  uses INTEGER DEFAULT 0,
  admin INTEGER DEFAULT 0,
  revoked INTEGER DEFAULT 0,
  created INTEGER
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS labs(
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  status TEXT NOT NULL,
  started INTEGER,
  last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS audit(
  ts INTEGER,
  user_id INTEGER,
  event TEXT,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS progress(
  user_id INTEGER NOT NULL,
  scenario_id TEXT NOT NULL,
  completed_steps TEXT NOT NULL DEFAULT '[]',
  completed_at INTEGER,
  PRIMARY KEY (user_id, scenario_id)
);
CREATE TABLE IF NOT EXISTS ai_usage(
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
`);

export const audit = (userId: number | null, event: string, detail = "") =>
  db.prepare("INSERT INTO audit VALUES(?,?,?,?)").run(Date.now(), userId, event, detail);
