import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { makeEnv, waitFor, type Env } from "./helpers.js";
import { createApp } from "../src/web/server.js";
import { AuthService } from "../src/web/auth.js";
import { scrubPaths } from "../src/util/redact.js";

let env: Env;
let tmp: string;
afterEach(async () => { await env?.cleanup(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

const WIN = process.platform === "win32";
const TAR = path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "tar.exe");
const zipRead = (z: string, f: string) => (WIN ? execFileSync(TAR, ["-xOf", z, f], { encoding: "utf8" }) : execFileSync("unzip", ["-p", z, f], { encoding: "utf8" }));

/** Every spelling of every host path that must never appear in output. */
function forbidden(): string[] {
  const bases = [os.homedir(), os.tmpdir(), process.cwd(), env.dir, tmp, path.basename(os.homedir())].filter(Boolean);
  return [...new Set(bases.flatMap((b) => [b, b.replace(/\\/g, "/"), b.replace(/\//g, "\\"), b.replace(/\\/g, "\\\\")]))].map((s) => s.toLowerCase());
}
const assertClean = (label: string, text: string) => {
  const t = text.toLowerCase();
  for (const f of forbidden()) if (t.includes(f)) throw new Error(`LEAK in ${label}: found "${f}"\n${text.slice(Math.max(0, t.indexOf(f) - 80), t.indexOf(f) + 120)}`);
};

describe("host path scrubbing", () => {
  it("replaces known roots and home directories, in any slash style", () => {
    env = makeEnv();
    env.svc.ctx.settings.update({ paths: { allowedRoots: [os.tmpdir()] } });
    expect(scrubPaths(`open ${env.dir}\\work\\x.txt failed`)).toMatch(/^open <work>.x\.txt failed$/);
    expect(scrubPaths("C:\\Users\\SomeoneElse\\Desktop\\a")).toBe("<home>\\Desktop\\a");
    expect(scrubPaths("c:/users/grayson/x")).toBe("<home>/x");
    expect(scrubPaths("/home/iidk/.config/x")).toBe("<home>/.config/x");
    expect(scrubPaths("/Users/bob/x")).toBe("<home>/x");
    expect(scrubPaths("a normal message")).toBe("a normal message");
  });

  it("no output surface leaks host paths: job logs/results/errors, events, diagnostics, logs, error bodies, bundle", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-leak-"));
    const game = path.join(tmp, "game");
    fs.mkdirSync(game, { recursive: true });
    fs.writeFileSync(path.join(game, "A.dll"), "x");
    env = makeEnv();
    env.svc.ctx.settings.update({ paths: { allowedRoots: [tmp] }, tools: { ilspyCmdPath: path.join(tmp, "no-such-ilspy") } });
    const w = env.svc.watches.create({ appId: 480, followMode: "all" }, "Spacewar");
    const db = env.svc.ctx.db;
    const add = (name: string, type: string, config: any, ord = 1) =>
      db.run("INSERT INTO job_defs(name,type,ord,max_retries,timeout_sec,config_json,created_at,updated_at) VALUES(?,?,?,0,60,?,'x','x')", name, type, ord, JSON.stringify(config));
    add("ok-collect", "collect", { selection: { root: game } });
    add("missing-dir", "collect", { selection: { root: path.join(game, "nope") } });
    add("outside", "collect", { selection: { root: path.parse(tmp).root } });
    add("decomp", "decompile", { selection: { root: game }, assemblies: ["A.dll"] });
    add("zip", "archive", { selection: { root: game }, destinationIds: [] });
    add("git-bad", "git", { repoPath: path.join(tmp, "norepo"), init: false, sources: [{ path: "x", dest: "d" }] });
    add("git-remote", "git", { repoPath: path.join(tmp, "r2"), push: true, remoteUrl: path.join(tmp, "missing.git"), sources: [{ path: game, dest: "G" }] });
    env.source.set(480, "1", { "1": "a" }); await env.svc.monitor.check(w.id);
    env.source.set(480, "2", { "1": "b" }); const ev = (await env.svc.monitor.check(w.id)).eventId!;
    await waitFor(async () => { await env.svc.jobs.tick(); return !db.get("SELECT 1 FROM job_runs WHERE status IN ('queued','running')"); }, 30_000);

    // Steam-side error text containing a path must be scrubbed before it is stored
    env.source.fail(480, `ENOENT: open '${path.join(tmp, "secret", "file")}'`);
    await env.svc.monitor.check(w.id);
    env.svc.ctx.logger.write("error", "t", `crash at ${path.join(os.homedir(), "x")}`, { err: new Error(`bad ${process.cwd()}`) });

    const agent = request.agent(createApp(env.svc, new AuthService(env.svc.ctx)));
    const csrf = (await agent.post("/api/login").send({ password: "test-password-123" })).body.csrf;
    const surfaces: Record<string, string> = {};
    for (const p of ["/api/overview", "/api/watches", `/api/events/${ev}`, "/api/events", "/api/job-runs", "/api/diagnostics", "/api/logs", "/api/git/repos", "/api/accounts", "/api/webhooks"]) {
      const r = await agent.get(p); surfaces[p] = JSON.stringify(r.body) + r.text;
    }
    for (const run of db.all("SELECT id FROM job_runs")) surfaces[`run ${run.id}`] = JSON.stringify((await agent.get(`/api/job-runs/${run.id}`)).body);
    // the settings page shows nothing absolute that the admin did not type
    const s = (await agent.get("/api/settings")).body;
    surfaces.settingsComputed = JSON.stringify({ paths: s.paths, network: s.network, pw: s.passwordFromEnv });
    // error bodies
    surfaces.err1 = (await agent.post("/api/jobs").set("x-csrf-token", csrf).send({ name: "e", type: "collect", config: { selection: { root: path.join(os.homedir(), "Desktop") } } })).text;
    surfaces.err2 = (await agent.put("/api/network").set("x-csrf-token", csrf).send({ host: "0.0.0.0", port: 1 })).text;
    surfaces.err3 = (await agent.get("/api/nonexistent")).text;
    // diagnostic bundle
    const bundle = await agent.get("/api/diagnostics/export").buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on("data", (d: Buffer) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); });
    const zipFile = path.join(tmp, "bundle.zip"); fs.writeFileSync(zipFile, bundle.body);
    surfaces.bundleDiag = zipRead(zipFile, "diagnostics.json"); surfaces.bundleSettings = zipRead(zipFile, "settings.json");

    // sanity: errors really happened (so the test exercises the leak paths)
    const errs = db.all("SELECT error FROM job_runs WHERE error IS NOT NULL").map((r) => r.error).join("|");
    expect(errs).toMatch(/does not exist/); expect(errs).toMatch(/outside the allowed/); expect(errs).toMatch(/not found or not runnable/);
    for (const [label, text] of Object.entries(surfaces)) assertClean(label, text);
  }, 60_000);

  it("artifacts written for others (reports, metadata, zips, export-info, commits) contain no absolute paths", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-leak2-"));
    const game = path.join(tmp, "game");
    fs.mkdirSync(game, { recursive: true }); fs.writeFileSync(path.join(game, "A.dll"), "x");
    env = makeEnv();
    env.svc.ctx.settings.update({ paths: { allowedRoots: [tmp] } });
    const w = env.svc.watches.create({ appId: 480, followMode: "all" }, "Spacewar");
    const db = env.svc.ctx.db;
    const dest = path.join(tmp, "up");
    const destId = db.run("INSERT INTO destinations(name,type,config_json,created_at) VALUES('n','local',?, 'x')", JSON.stringify({ dir: dest })).lastId;
    const add = (name: string, type: string, config: any, ord: number) =>
      db.run("INSERT INTO job_defs(name,type,ord,max_retries,timeout_sec,config_json,created_at,updated_at) VALUES(?,?,?,0,60,?,'x','x')", name, type, ord, JSON.stringify(config)).lastId;
    const c = add("collect", "collect", { selection: { root: game } }, 1);
    add("zip", "archive", { selection: { root: game }, destinationIds: [destId] }, 2);
    add("git", "git", { repoPath: path.join(tmp, "repo"), sources: [{ sourceJobId: c, path: "files", dest: "G" }] }, 3);
    env.source.set(480, "1", { "1": "a" }); await env.svc.monitor.check(w.id);
    env.source.set(480, "2", { "1": "b" }); await env.svc.monitor.check(w.id);
    await waitFor(async () => { await env.svc.jobs.tick(); return !db.get("SELECT 1 FROM job_runs WHERE status IN ('queued','running')"); }, 30_000);
    expect(db.all("SELECT status FROM job_runs").map((r) => r.status)).toEqual(["succeeded", "succeeded", "succeeded"]);

    const texts: Record<string, string> = {};
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== ".git") walk(p); } else if (/\.(json|md|html|txt)$/.test(e.name) && e.name !== "bundle.zip") texts[p] = fs.readFileSync(p, "utf8"); } };
    walk(env.svc.ctx.settings.workDir()); walk(path.join(tmp, "repo"));
    const zip = fs.readdirSync(dest)[0]; texts.zipMeta = zipRead(path.join(dest, zip), "metadata.json");
    const git = (...a: string[]) => execFileSync("git", a, { cwd: path.join(tmp, "repo"), encoding: "utf8" });
    texts.commit = git("log", "--format=%B%an%ae"); texts.commitFiles = git("show", "--stat", "--format=", "HEAD");
    expect(Object.keys(texts).length).toBeGreaterThan(5);
    for (const [label, text] of Object.entries(texts)) assertClean(label.replace(tmp, "<tmp>"), text);
    for (const r of db.all("SELECT result_json FROM job_runs")) assertClean("result_json", r.result_json);
  }, 60_000);
});

describe("repository hygiene", () => {
  it("source, docs, tests and config contain no developer machine paths", () => {
    const root = path.resolve(__dirname, "..");
    const bad = [/grayson/i, /iidk/i, /other stuff/i, /qubitsource/i, /[A-Za-z]:[\\/]+Users[\\/]/, /\/home\/[a-z]/i];
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (["node_modules", "dist", "data", ".git", "coverage"].includes(e.name)) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|js|json|md|html|css|ps1|sh|example)$/.test(e.name) && e.name !== "leak.test.ts" && e.name !== "package-lock.json") {
          const t = fs.readFileSync(p, "utf8");
          for (const re of bad) if (re.test(t)) hits.push(`${path.relative(root, p)} ~ ${re}`);
        }
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});

describe("git commits and webhooks", () => {
  it("csproj HintPaths are reduced to file names", async () => {
    const { sanitizeCsproj } = await import("../src/jobs/decompile.js");
    const x = String.raw`<Reference Include="UnityEngine"><HintPath>..\..\..\Users\Someone\Game\Managed\UnityEngine.dll</HintPath></Reference><HintPath>/srv/g/A.dll</HintPath>`;
    expect(sanitizeCsproj(x)).toBe(`<Reference Include="UnityEngine"><HintPath>UnityEngine.dll</HintPath></Reference><HintPath>A.dll</HintPath>`);
  });

  it("git job refuses to commit a file containing a path of this machine, and nothing is committed", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-leak3-"));
    const game = path.join(tmp, "game");
    fs.mkdirSync(game, { recursive: true });
    fs.writeFileSync(path.join(game, "clean.txt"), "fine");
    fs.writeFileSync(path.join(game, "leaky.json"), JSON.stringify({ log: path.join(os.homedir(), "Documents", "x.log") }));
    env = makeEnv();
    env.svc.ctx.settings.update({ paths: { allowedRoots: [tmp] } });
    const w = env.svc.watches.create({ appId: 480, followMode: "all" }, "Spacewar");
    const db = env.svc.ctx.db;
    db.run("INSERT INTO job_defs(name,type,ord,max_retries,timeout_sec,config_json,created_at,updated_at) VALUES('git','git',1,0,60,?,'x','x')",
      JSON.stringify({ repoPath: path.join(tmp, "repo"), sources: [{ path: game, dest: "G" }] }));
    env.source.set(480, "1", { "1": "a" }); await env.svc.monitor.check(w.id);
    env.source.set(480, "2", { "1": "b" }); await env.svc.monitor.check(w.id);
    await waitFor(async () => { await env.svc.jobs.tick(); return !db.get("SELECT 1 FROM job_runs WHERE status IN ('queued','running')"); }, 30_000);
    const run = db.get("SELECT status,error FROM job_runs")!;
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/Refusing to commit.*leaky\.json/);
    assertClean("guard error", run.error);
    expect(() => execFileSync("git", ["rev-parse", "HEAD"], { cwd: path.join(tmp, "repo"), stdio: "pipe" })).toThrow(); // no commit exists
    // fixing the cause lets the same event commit
    fs.rmSync(path.join(game, "leaky.json"));
    env.svc.jobs.enqueueManual(1); 
    await waitFor(async () => { await env.svc.jobs.tick(); return !db.get("SELECT 1 FROM job_runs WHERE status IN ('queued','running')"); }, 30_000);
    expect(db.all("SELECT status FROM job_runs ORDER BY id").map((r) => r.status)).toEqual(["failed", "succeeded"]);
  }, 60_000);

  it("webhook payloads contain only game data and links, never host paths", async () => {
    env = makeEnv();
    const hook = env.svc.ctx.db.run("INSERT INTO webhooks(name,url_enc,created_at) VALUES('m',?,'x')", env.svc.ctx.box.encrypt("https://discord.com/api/webhooks/123456789012345678/tok")).lastId;
    env.svc.ctx.settings.update({ notifications: { defaultWebhookId: hook, useEmbed: true } });
    const w = env.svc.watches.create({ appId: 480, followMode: "all" }, "Spacewar");
    env.source.set(480, "1", { "1": "a" }); await env.svc.monitor.check(w.id);
    env.source.set(480, "2", { "1": "b" }); await env.svc.monitor.check(w.id);
    await env.svc.notifier.tick();
    expect(env.sent).toHaveLength(1);
    assertClean("webhook payload", JSON.stringify(env.sent[0].payload));
    expect(JSON.stringify(env.sent[0].payload)).toContain("http://127.0.0.1:4019/#/history/");
  });
});
