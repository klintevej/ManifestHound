import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServices, type Overrides } from "../src/bootstrap.js";
import type { BootConfig } from "../src/config.js";
import type { AppSnapshot } from "../src/steam/appinfo.js";
import type { FetchRequest, ManifestSource } from "../src/steam/manager.js";
import type { Services } from "../src/services.js";
import type { SendResult } from "../src/notify/discord.js";

export class FakeSource implements ManifestSource {
  snaps = new Map<number, AppSnapshot | Error>();
  calls = 0;
  set(appId: number, build: string, depots: Record<string, string>, timeUpdated: number | null = 1_800_000_000, name = "Test Game") {
    this.snaps.set(appId, {
      appId, name, branch: "public", buildId: build, timeUpdated, source: "fake", fetchedAt: new Date().toISOString(),
      depots: Object.fromEntries(Object.entries(depots).map(([d, m]) => [d, { manifest: m }])),
    });
  }
  fail(appId: number, msg = "boom") { this.snaps.set(appId, new Error(msg)); }
  async fetch(req: FetchRequest): Promise<AppSnapshot> {
    this.calls++;
    const s = this.snaps.get(req.appId);
    if (!s) throw new Error("unknown app");
    if (s instanceof Error) throw s;
    return s;
  }
}

export interface Env { dir: string; boot: BootConfig; svc: Services; source: FakeSource; sent: { url: string; payload: any }[]; sendResults: SendResult[]; cleanup(): Promise<void>; reopen(o?: Overrides): Env }

export const HOOK_URL = "https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-JKL";

export function makeEnv(dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-test-")), extra: Overrides = {}): Env {
  const boot: BootConfig = { host: "127.0.0.1", port: 4019, dataDir: dir, logLevel: "error", allowRemote: false, configFile: path.join(dir, "cfg.json"), adminPassword: "test-password-123" };
  const source = new FakeSource();
  const sent: Env["sent"] = [];
  const sendResults: SendResult[] = [];
  const svc = createServices(boot, {
    source, quietLogs: true, tickMs: 3_600_000,
    sender: async (url, payload) => { sent.push({ url, payload }); return sendResults.shift() ?? { ok: true, status: 200 }; },
    ...extra,
  });
  return {
    dir, boot, svc, source, sent, sendResults,
    async cleanup() { await svc.jobs.stop(200); svc.monitor.stop(); svc.ctx.logger.close(); svc.ctx.db.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); },
    reopen(o) { svc.ctx.logger.close(); svc.ctx.db.close(); return makeEnv(dir, o); },
  };
}

export function addHook(env: Env, name = "main") {
  const id = env.svc.ctx.db.run("INSERT INTO webhooks(name,url_enc,created_at) VALUES(?,?,?)", name, env.svc.ctx.box.encrypt(HOOK_URL), new Date().toISOString()).lastId;
  env.svc.ctx.settings.update({ notifications: { defaultWebhookId: id } });
  return id;
}

export const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error("waitFor timed out");
};
