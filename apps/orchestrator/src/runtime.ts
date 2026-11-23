import { execFile } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { config, ROOT, slotPorts } from "./config.js";

export interface ServiceHealth {
  sim: boolean;
  admin: boolean;
  term: boolean;
  gcs: boolean;
}

export interface RuntimeDriver {
  readonly name: string;
  readonly supportsWifi: boolean;
  provisionSlot(slot: number): Promise<void>;
  destroySlot(slot: number): Promise<void>;
  resetAirframe(slot: number): Promise<void>;
  checkHealth(slot: number): Promise<ServiceHealth>;
}

const probeHttp = (port: number, reqPath = "/") =>
  new Promise<boolean>((res) => {
    const r = http.get({ host: "127.0.0.1", port, path: reqPath, timeout: 2000 }, (resp) => {
      resp.resume();
      res(true);
    });
    r.on("error", () => res(false));
    r.on("timeout", () => {
      r.destroy();
      res(false);
    });
  });

const postHttp = (port: number, reqPath: string) =>
  new Promise<void>((res, rej) => {
    const req = http.request({ host: "127.0.0.1", port, path: reqPath, method: "POST", timeout: 15_000 }, (resp) => {
      resp.resume();
      if ((resp.statusCode ?? 500) < 400) res();
      else rej(new Error(`HTTP ${resp.statusCode}`));
    });
    req.on("error", rej);
    req.on("timeout", () => {
      req.destroy();
      rej(new Error("reset timeout"));
    });
    req.end();
  });

const runScript = (script: string, args: string[]) =>
  new Promise<void>((res, rej) =>
    execFile(script, args, { timeout: 600_000 }, (e, _o, err) => (e ? rej(new Error(err || e.message)) : res()))
  );

export class DockerLiteDriver implements RuntimeDriver {
  readonly name = "docker-lite";
  readonly supportsWifi = false;

  provisionSlot(slot: number) {
    return runScript(config.slotScript, ["up", String(slot)]);
  }
  destroySlot(slot: number) {
    return runScript(config.slotScript, ["down", String(slot)]);
  }
  async resetAirframe(slot: number) {
    await postHttp(slotPorts(slot).sim, "/reset");
  }
  async checkHealth(slot: number): Promise<ServiceHealth> {
    const p = slotPorts(slot);
    const [sim, admin, term, gcs] = await Promise.all([
      probeHttp(p.sim, "/"),
      probeHttp(p.admin, "/"),
      probeHttp(p.term, "/"),
      probeHttp(p.gcs, "/vnc.html"),
    ]);
    return { sim, admin, term, gcs };
  }
}

/**
 * Linux VM Driver (Phase 5) — delegates each slot to an isolated Incus/Lima Linux VM
 * with kernel `mac80211_hwsim` virtual Wi-Fi and optional 3D Gazebo.
 */
export class LinuxVMDriver implements RuntimeDriver {
  readonly name = "linux-vm";
  readonly supportsWifi = true;
  private vmScript = path.join(ROOT, "deploy", "linux-vm", "vm-slot.sh");

  provisionSlot(slot: number) {
    return runScript(this.vmScript, ["up", String(slot)]);
  }
  destroySlot(slot: number) {
    return runScript(this.vmScript, ["down", String(slot)]);
  }
  async resetAirframe(slot: number) {
    await postHttp(slotPorts(slot).sim, "/reset");
  }
  async checkHealth(slot: number): Promise<ServiceHealth> {
    const p = slotPorts(slot);
    const [sim, admin, term, gcs] = await Promise.all([
      probeHttp(p.sim, "/"),
      probeHttp(p.admin, "/"),
      probeHttp(p.term, "/"),
      probeHttp(p.gcs, "/vnc.html"),
    ]);
    return { sim, admin, term, gcs };
  }
}

export const runtime: RuntimeDriver =
  config.runtimeDriver === "linux-vm" ? new LinuxVMDriver() : new DockerLiteDriver();
