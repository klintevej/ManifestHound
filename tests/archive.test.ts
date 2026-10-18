import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { makeEnv, type Env } from "./helpers.js";
import { createApp } from "../src/web/server.js";
import { AuthService } from "../src/web/auth.js";
import { globToFilelistLine, planDownloads } from "../src/jobs/depotdownload.js";
import { validateConfig } from "../src/jobs/types.js";

let env: Env;
afterEach(async () => { await env?.cleanup(); });

const ev = (manifestIds: Record<string, string>, branch = "public"): any => ({ appId: 480, newBuild: "9", changes: { manifestIds, branch } });

describe("depot download planning", () => {
  it("pins one download per changed depot to the event's manifest", () => {
    const cfg = validateConfig("depotdownload", { os: "windows" });
    const plans = planDownloads({ event: ev({ "481": "111", "482": "222" }), outputDir: "/out" }, cfg, null);
    expect(plans.map((p) => p.args.slice(p.args.indexOf("-depot")))).toEqual([["-depot", "481", "-manifest", "111"], ["-depot", "482", "-manifest", "222"]]);
    expect(plans[0].args).toEqual(expect.arrayContaining(["-app", "480", "-dir", "/out", "-os", "windows"]));
    expect(plans[0].args).not.toContain("-branch");
  });
  it("respects the depot list, branch, account and filelist; falls back to all depots", () => {
    const cfg = validateConfig("depotdownload", { depots: ["482"], username: "alice" });
    const p = planDownloads({ event: ev({ "481": "111", "482": "222" }, "beta"), outputDir: "/out" }, cfg, "/out/list.txt");
    expect(p).toHaveLength(1);
    expect(p[0].args).toEqual(expect.arrayContaining(["-depot", "482", "-manifest", "222", "-branch", "beta", "-username", "alice", "-remember-password", "-filelist", "/out/list.txt"]));
    expect(p[0].args).not.toContain("-password");
    const all = planDownloads({ event: ev({}), outputDir: "/out" }, validateConfig("depotdownload", {}), null);
    expect(all).toEqual([{ label: "all depots", args: ["-app", "480", "-dir", "/out", "-max-downloads", "8"] }]);
  });
  it("turns globs into regex filelist lines that match either slash style", () => {
    const line = globToFilelistLine("**/*_Data/Managed/*.dll");
    expect(line.startsWith("regex:")).toBe(true);
    const re = new RegExp(line.slice(6), "i");
    expect(re.test("Game_Data/Managed/Assembly-CSharp.dll")).toBe(true);
    expect(re.test(["sub", "Game_Data", "Managed", "Assembly-CSharp.dll"].join(String.fromCharCode(92)))).toBe(true);
    expect(re.test("Game_Data/Managed/deeper/x.dll")).toBe(false);
    expect(re.test("Game_Data/Plugins/x.dll")).toBe(false);
  });
  it("rejects option injection through the account name", () => {
    expect(() => validateConfig("depotdownload", { username: "x -dir /etc" })).toThrow();
    expect(() => validateConfig("depotdownload", { depots: ["1; rm"] })).toThrow();
  });
});

describe("Archive preset", () => {
  it("creates download -> decompile -> git jobs chained by source job", async () => {
    env = makeEnv();
    const w = env.svc.watches.create({ appId: 480, followMode: "all" }, "Spacewar");
    const agent = request.agent(createApp(env.svc, new AuthService(env.svc.ctx)));
    const csrf = (await agent.post("/api/login").send({ password: "test-password-123" })).body.csrf;
    const bad = await agent.post("/api/presets/archive").set("x-csrf-token", csrf).send({ watchId: w.id, push: true });
    expect(bad.status).toBe(400);
    const r = await agent.post("/api/presets/archive").set("x-csrf-token", csrf).send({ watchId: w.id, os: "windows", assemblies: ["*_Data/Managed/*.dll"], excludeAssemblies: ["**/System*.dll"], remoteUrl: "https://github.com/me/r.git", push: true });
    expect(r.status).toBe(201);
    const jobs = (await agent.get("/api/jobs")).body;
    const by = Object.fromEntries(jobs.map((j: any) => [j.type, j]));
    expect(jobs.map((j: any) => j.ord)).toEqual([10, 20, 30]);
    expect(by.decompile.config.selection.sourceJobId).toBe(by.depotdownload.id);
    expect(by.decompile.config.onExisting).toBe("overwrite");
    expect(by.git.config.sources[0]).toMatchObject({ sourceJobId: by.decompile.id, path: "src", dest: "", mirror: true });
    expect(by.git.config.push).toBe(true);
    expect(jobs.every((j: any) => j.watchId === w.id)).toBe(true);
    expect(by.depotdownload.stopOnFail && by.decompile.stopOnFail).toBe(true);
  });
});

describe("Pull now", () => {
  it("queues the game's jobs in order for the current build, without notifying", async () => {
    const order: string[] = [];
    env = makeEnv(undefined, { handlers: {
      depotdownload: async (c) => { order.push("download:" + JSON.stringify(c.event.changes.manifestIds)); return { summary: "d" }; },
      decompile: async () => { order.push("decompile"); return { summary: "c" }; },
      git: async () => { order.push("git"); return { summary: "g" }; },
    } });
    const hook = env.svc.ctx.db.run("INSERT INTO webhooks(name,url_enc,created_at) VALUES('m',?,'x')", env.svc.ctx.box.encrypt("https://discord.com/api/webhooks/123456789012345678/tok")).lastId;
    env.svc.ctx.settings.update({ notifications: { defaultWebhookId: hook } });
    const w = env.svc.watches.create({ appId: 480, followMode: "all" }, "Spacewar");
    const agent = request.agent(createApp(env.svc, new AuthService(env.svc.ctx)));
    const csrf = (await agent.post("/api/login").send({ password: "test-password-123" })).body.csrf;
    const post = (p: string, b: any = {}) => agent.post(p).set("x-csrf-token", csrf).send(b);

    env.source.fail(480, "no steam");
    expect((await post(`/api/watches/${w.id}/pull`)).status).toBe(409);           // nothing known yet
    env.source.set(480, "7", { "481": "111", "482": "222" });
    expect((await post(`/api/watches/${w.id}/pull`)).status).toBe(409);           // known build, but no jobs
    await post("/api/presets/archive", { watchId: w.id });
    const r = await post(`/api/watches/${w.id}/pull`);
    expect(r.status).toBe(202);
    const db = env.svc.ctx.db;
    for (let i = 0; i < 100 && db.get("SELECT 1 FROM job_runs WHERE status IN ('queued','running')"); i++) { await env.svc.jobs.tick(); await new Promise((x) => setTimeout(x, 20)); }
    expect(order).toEqual(['download:{"481":"111","482":"222"}', "decompile", "git"]);
    expect(db.all("SELECT status FROM job_runs").map((x) => x.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(db.get("SELECT kind,new_build FROM events WHERE id=?", r.body.eventId)).toMatchObject({ kind: "manual", new_build: "7" });
    expect(db.all("SELECT * FROM notifications")).toHaveLength(0);
    // a second click is a fresh run
    await post(`/api/watches/${w.id}/pull`);
    expect(db.get("SELECT COUNT(*) c FROM job_runs")!.c).toBe(6);
  });
});
