import httpProxy from "http-proxy";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { config, slotPorts } from "./config.js";
import { userFromToken } from "./auth.js";
import { labById, touch } from "./labs.js";

const proxy = httpProxy.createProxyServer({ xfwd: false, ws: true });
proxy.on("error", (_e, _req, res) => {
  if (res && "writeHead" in res && !res.headersSent) {
    res.writeHead(502);
    (res as ServerResponse).end("Upstream unavailable");
  } else (res as Duplex)?.destroy?.();
});
// Allow embedding inside the workspace UI
proxy.on("proxyRes", (pr) => {
  delete pr.headers["x-frame-options"];
  delete pr.headers["content-security-policy"];
});

export const cookieOf = (req: IncomingMessage, name = "dvd_sid") =>
  req.headers.cookie
    ?.split(/;\s*/)
    .map((c) => c.split("="))
    .find(([k]) => k === name)?.[1];

/**
 * Extracts the parent wildcard base domain from the request Host header so local
 * (`*.dvd.localhost`) and Tailscale/remote (`*.100.x.y.z.nip.io` or `*.sim.domain.com`)
 * work simultaneously without reconfiguring BASE_HOST.
 */
export function baseHostForReq(req: { headers: { host?: string } }): string {
  const rawHost = (req.headers.host ?? "").split(":")[0].toLowerCase();
  if (!rawHost || rawHost === "localhost" || rawHost === "127.0.0.1") return config.baseHost;
  // Bare IPv4 address (e.g. 100.100.125.13) -> use nip.io wildcard
  if (/^\d+\.\d+\.\d+\.\d+$/.test(rawHost)) return `${rawHost}.nip.io`;
  // Strip leading app. or <service>-<id>. prefix
  const stripped = rawHost.replace(/^(?:app|(?:sim|admin|term|gcs)-[0-9a-f]{10})\./, "");
  return stripped || config.baseHost;
}

export function resolve(
  req: IncomingMessage
): { kind: "none" } | { kind: "denied" } | { kind: "ok"; target: string; labId: string } {
  const host = (req.headers.host ?? "").split(":")[0].toLowerCase();
  const m = host.match(/^(sim|admin|term|gcs)-([0-9a-f]{10})\.(.+)$/);
  if (!m) return { kind: "none" };
  const user = userFromToken(cookieOf(req));
  const lab = labById(m[2]);
  if (!user || !lab || lab.status !== "healthy" || (lab.user_id !== user.id && !user.is_admin)) {
    return { kind: "denied" };
  }
  touch(lab.id);
  const p = slotPorts(lab.slot);
  return {
    kind: "ok",
    labId: lab.id,
    target: `http://127.0.0.1:${{ sim: p.sim, admin: p.admin, term: p.term, gcs: p.gcs }[m[1] as "sim"]}`,
  };
}

export function handleHttp(req: IncomingMessage, res: ServerResponse): boolean {
  const rawHost = (req.headers.host ?? "").split(":")[0];
  // If user visits bare IP (e.g. http://100.100.125.13:4000), redirect to app.<ip>.nip.io:4000
  // so subdomain cookies (.100.100.125.13.nip.io) work automatically.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(rawHost)) {
    res.writeHead(302, { Location: `http://app.${rawHost}.nip.io:${config.port}${req.url || "/"}` });
    res.end();
    return true;
  }
  const r = resolve(req);
  if (r.kind === "none") return false;
  if (r.kind === "denied") {
    res.writeHead(403);
    res.end("Forbidden");
    return true;
  }
  proxy.web(req, res, { target: r.target });
  return true;
}

export function handleUpgrade(req: IncomingMessage, sock: Duplex, head: Buffer) {
  const r = resolve(req);
  if (r.kind !== "ok") {
    sock.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    sock.destroy();
    return;
  }
  proxy.ws(req, sock, head, { target: r.target });
}
