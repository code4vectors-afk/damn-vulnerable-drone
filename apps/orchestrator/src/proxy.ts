import httpProxy from "http-proxy";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { config, slotPorts } from "./config.js";
import { userFromToken } from "./auth.js";
import { labById, touch } from "./labs.js";

const proxy = httpProxy.createProxyServer({ xfwd: false, ws: true });
proxy.on("error", (_e, _req, res) => { if (res && "writeHead" in res && !res.headersSent) { res.writeHead(502); (res as ServerResponse).end("Upstream unavailable"); } else (res as Duplex)?.destroy?.(); });
// Allow embedding inside the workspace UI
proxy.on("proxyRes", (pr) => { delete pr.headers["x-frame-options"]; delete pr.headers["content-security-policy"]; });

export const cookieOf = (req: IncomingMessage, name = "dvd_sid") =>
  req.headers.cookie?.split(/;\s*/).map((c) => c.split("=")).find(([k]) => k === name)?.[1];

// returns lab target for host like sim-<id>.<base>, or null if not a lab host / not authorized
export function resolve(req: IncomingMessage): { kind: "none" } | { kind: "denied" } | { kind: "ok"; target: string; labId: string } {
  const host = (req.headers.host ?? "").split(":")[0];
  const m = host.match(new RegExp(`^(sim|admin|term|gcs)-([0-9a-f]{10})\\.${config.baseHost.replace(/\./g, "\\.")}$`));
  if (!m) return { kind: "none" };
  const user = userFromToken(cookieOf(req));
  const lab = labById(m[2]);
  if (!user || !lab || lab.status !== "healthy" || (lab.user_id !== user.id && !user.is_admin)) return { kind: "denied" };
  touch(lab.id);
  const p = slotPorts(lab.slot);
  return { kind: "ok", labId: lab.id, target: `http://127.0.0.1:${{ sim: p.sim, admin: p.admin, term: p.term, gcs: p.gcs }[m[1] as "sim"]}` };
}
export function handleHttp(req: IncomingMessage, res: ServerResponse): boolean {
  const r = resolve(req); if (r.kind === "none") return false;
  if (r.kind === "denied") { res.writeHead(403); res.end("Forbidden"); return true; }
  proxy.web(req, res, { target: r.target }); return true;
}
export function handleUpgrade(req: IncomingMessage, sock: Duplex, head: Buffer) {
  const r = resolve(req);
  if (r.kind !== "ok") { sock.write("HTTP/1.1 403 Forbidden\r\n\r\n"); sock.destroy(); return; }
  proxy.ws(req, sock, head, { target: r.target });
}
