import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { makeEnv, waitFor, type Env } from "./helpers.js";
import { commitSubject, eventTimestamp, manifestToken, isSecretLike } from "../src/jobs/git.js";
import { diffFiles, globToRegExp, scanFiles, SelectionSchema } from "../src/jobs/files.js";
import { isManagedAssembly, stripTokenComments } from "../src/jobs/decompile.js";
import { isInside, resolveInsideRoots, safeJoin } from "../src/util/misc.js";

let env: Env;
let tmp: string;
afterEach(async () => { await env?.cleanup(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

const WIN = process.platform === "win32";
const TAR = path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "tar.exe");
const zipList = (z: string) => (WIN ? execFileSync(TAR, ["-tf", z], { encoding: "utf8" }) : execFileSync("unzip", ["-Z1", z], { encoding: "utf8" }));
const zipRead = (z: string, f: string) => (WIN ? execFileSync(TAR, ["-xOf", z, f], { encoding: "utf8" }) : execFileSync("unzip", ["-p", z, f], { encoding: "utf8" }));
const dotnetDir = ["C:/Program Files/dotnet", "/usr/share/dotnet", "/usr/lib/dotnet", path.join(os.homedir(), ".dotnet"), process.env.DOTNET_ROOT ?? ""].map((d) => path.join(d, "shared", "Microsoft.NETCore.App")).find((d) => fs.existsSync(d));
const OUTSIDE = path.join(path.parse(os.tmpdir()).root, "mh-outside-root");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const write = (root: string, rel: string, content: string | Buffer) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); };

function setup(extraRoots: string[] = []) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-jobs-"));
  const game = path.join(tmp, "game");
  fs.mkdirSync(game, { recursive: true });
  env = makeEnv();
  env.svc.ctx.settings.update({ paths: { allowedRoots: [tmp, ...extraRoots] } });
  const w = env.svc.watches.create({ appId: 480, followMode: "all" }, "Spacewar");
  return { game, w };
}
function addJob(name: string, type: string, config: any, ord = 1, over: any = {}) {
  return env.svc.ctx.db.run(
    "INSERT INTO job_defs(watch_id,name,type,ord,max_retries,timeout_sec,output_dir,config_json,stop_on_fail,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    null, name, type, ord, over.maxRetries ?? 0, over.timeoutSec ?? 60, over.outputDir ?? null, JSON.stringify(config), over.stopOnFail ? 1 : 0, "x", "x").lastId;
}
async function publish(watchId: number, build: string, depots: Record<string, string>, tu = 1_800_000_000) {
  env.source.set(480, build, depots, tu);
  return (await env.svc.monitor.check(watchId)).eventId!;
}
async function drain(ms = 30_000) {
  await waitFor(async () => { await env.svc.jobs.tick(); return !env.svc.ctx.db.get("SELECT 1 FROM job_runs WHERE status IN ('queued','running')"); }, ms);
}
const runOf = (name: string, i = -1) => { const r = env.svc.ctx.db.all("SELECT * FROM job_runs WHERE job_name=? ORDER BY id", name); return r.at(i)!; };

describe("file selection and diff", () => {
  it("honours globs, extensions, explicit files, exclusions and recursion", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-sel-"));
    write(tmp, "Managed/A.dll", "a"); write(tmp, "Managed/sub/B.dll", "b"); write(tmp, "Managed/A.pdb", "p"); write(tmp, "readme.txt", "r"); write(tmp, "Plugins/native.dll", "n");
    const sel = (o: any) => SelectionSchema.parse(o);
    expect((await scanFiles(tmp, sel({ include: ["Managed/**/*.dll"] }))).map((f) => f.path)).toEqual(["Managed/A.dll", "Managed/sub/B.dll"]);
    expect((await scanFiles(tmp, sel({ include: ["Managed/*.dll"] }))).map((f) => f.path)).toEqual(["Managed/A.dll"]);
    expect((await scanFiles(tmp, sel({ extensions: [".dll"], exclude: ["Plugins/**"] }))).map((f) => f.path)).toEqual(["Managed/A.dll", "Managed/sub/B.dll"]);
    expect((await scanFiles(tmp, sel({ files: ["Managed/A.pdb"] }))).map((f) => f.path)).toEqual(["Managed/A.pdb"]);
    expect((await scanFiles(tmp, sel({ extensions: ["dll"], recursive: false }))).map((f) => f.path)).toEqual([]);
    const f = (await scanFiles(tmp, sel({ files: ["readme.txt"] })))[0];
    expect(f.sha256).toBe(createHash("sha256").update("r").digest("hex"));
    expect(f.size).toBe(1);
    expect(globToRegExp("a/**/b.dll").test("a/b.dll")).toBe(true);
  });
  it("classifies added, modified, removed and unchanged", () => {
    const f = (p: string, h: string) => ({ path: p, sha256: h, size: 1, mtimeMs: 0 });
    const d = diffFiles([f("keep", "1"), f("mod", "1"), f("gone", "1")], [f("keep", "1"), f("mod", "2"), f("new", "1")]);
    expect([d.added, d.modified, d.removed, d.unchanged].map((x) => x.length)).toEqual([1, 1, 1, 1]);
    expect(d.modified[0]).toMatchObject({ path: "mod" });
  });
});

describe("path safety", () => {
  it("rejects traversal and paths outside allowed roots", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-path-"));
    expect(() => safeJoin(tmp, "../evil")).toThrow(/traversal/);
    expect(() => safeJoin(tmp, "a/../../evil")).toThrow(/traversal/);
    expect(safeJoin(tmp, "a/b.txt")).toBe(path.join(tmp, "a", "b.txt"));
    expect(() => resolveInsideRoots(path.join(tmp, "..", "x"), [tmp])).toThrow(/outside/);
    expect(() => resolveInsideRoots(OUTSIDE, [tmp])).toThrow(/outside/);
    expect(resolveInsideRoots("sub/dir", [tmp], tmp)).toBe(path.join(tmp, "sub", "dir"));
    expect(isInside(tmp, tmp + "-sibling")).toBe(false);
  });
  it("does not follow symlinks out of the scan root", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-link-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mh-outside-"));
    write(outside, "secret.dll", "s"); write(tmp, "ok.dll", "o");
    try { fs.symlinkSync(outside, path.join(tmp, "link"), "junction"); } catch { /* symlink not permitted: nothing to test */ }
    expect((await scanFiles(tmp, SelectionSchema.parse({}))).map((f) => f.path)).toEqual(["ok.dll"]);
    fs.rmSync(outside, { recursive: true, force: true });
  });
  it("API rejects job paths outside allowed roots", async () => {
    setup();
    const { default: request } = await import("supertest");
    const { createApp } = await import("../src/web/server.js");
    const { AuthService } = await import("../src/web/auth.js");
    const app = createApp(env.svc, new AuthService(env.svc.ctx));
    const agent = request.agent(app);
    const login = await agent.post("/api/login").send({ password: "test-password-123" });
    const body = { name: "evil", type: "collect", config: { selection: { root: OUTSIDE } } };
    const res = await agent.post("/api/jobs").set("x-csrf-token", login.body.csrf).send(body);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/outside the allowed/);
  });
});

describe("collect + report jobs", () => {
  it("collects files and reports added / modified / removed across updates", async () => {
    const { game, w } = setup();
    write(game, "Managed/A.dll", "v1"); write(game, "Managed/B.dll", "v1"); write(game, "Managed/skip.pdb", "x");
    addJob("collect-dlls", "collect", { selection: { root: game, include: ["Managed/*.dll"] } });
    await publish(w.id, "1", { "1": "a" });                   // baseline: no job
    expect(env.svc.ctx.db.all("SELECT * FROM job_runs")).toHaveLength(0);
    const ev1 = await publish(w.id, "2", { "1": "b" }); await drain();
    let run = runOf("collect-dlls"); expect(run.status).toBe("succeeded");
    const out = path.join(env.svc.ctx.settings.workDir(), "480", "collect-dlls-1");
    expect(fs.readFileSync(path.join(out, "files/Managed/A.dll"), "utf8")).toBe("v1");
    expect(fs.existsSync(path.join(out, "files/Managed/skip.pdb"))).toBe(false);
    const r1 = JSON.parse(fs.readFileSync(path.join(out, "reports", `${ev1}.json`), "utf8"));
    expect(r1.counts).toEqual({ added: 2, modified: 0, removed: 0, unchanged: 0 });
    expect(r1.meta.manifestIds).toEqual({ "1": "b" });

    write(game, "Managed/A.dll", "v2"); fs.rmSync(path.join(game, "Managed/B.dll")); write(game, "Managed/C.dll", "v1");
    const ev2 = await publish(w.id, "3", { "1": "c" }); await drain();
    const r2 = JSON.parse(fs.readFileSync(path.join(out, "reports", `${ev2}.json`), "utf8"));
    expect(r2.counts).toEqual({ added: 1, modified: 1, removed: 1, unchanged: 0 });
    expect(r2.diff.modified[0].path).toBe("Managed/A.dll");
    expect(fs.readFileSync(path.join(out, "files/Managed/A.dll"), "utf8")).toBe("v2");
    expect(fs.existsSync(path.join(out, "files/Managed/B.dll"))).toBe(false);
    expect(fs.readFileSync(path.join(out, "reports", `${ev2}.md`), "utf8")).toContain("Modified");
    expect(fs.readFileSync(path.join(out, "reports", `${ev2}.html`), "utf8")).toContain("<table>");

    // a crash-retry of the same event reuses its report (snapshot already advanced)
    env.svc.ctx.db.run("UPDATE job_runs SET status='queued' WHERE id=?", runOf("collect-dlls").id);
    await drain();
    expect(JSON.parse(runOf("collect-dlls").result_json).data.reused).toBe(true);
    expect(JSON.parse(runOf("collect-dlls").result_json).data.counts.modified).toBe(1);
  });

  it("report job writes reports without copying", async () => {
    const { game, w } = setup();
    write(game, "x.dll", "1");
    addJob("rep", "report", { selection: { root: game } });
    await publish(w.id, "1", { "1": "a" }); const ev = await publish(w.id, "2", { "1": "b" }); await drain();
    const out = path.join(env.svc.ctx.settings.workDir(), "480", "rep-1");
    expect(fs.existsSync(path.join(out, "reports", `${ev}.json`))).toBe(true);
    expect(fs.existsSync(path.join(out, "files"))).toBe(false);
  });

  it("manual 'run now' works against existing local files without a new update", async () => {
    const { game, w } = setup();
    write(game, "x.dll", "1");
    const id = addJob("manual", "collect", { selection: { root: game } });
    env.source.set(480, "1", { "1": "a" }); await env.svc.monitor.check(w.id);
    env.svc.jobs.enqueueManual(id);
    await drain();
    expect(runOf("manual").error).toBeNull();
    expect(runOf("manual")).toMatchObject({ status: "succeeded", manual: 1 });
  });

  it("fails with a clear error when the source directory is missing or unsafe", async () => {
    const { game, w } = setup();
    addJob("missing", "collect", { selection: { root: path.join(game, "nope") } });
    addJob("unsafe", "collect", { selection: { root: OUTSIDE } });
    await publish(w.id, "1", { "1": "a" }); await publish(w.id, "2", { "1": "b" }); await drain();
    expect(runOf("missing").error).toMatch(/does not exist/);
    expect(runOf("unsafe").error).toMatch(/outside the allowed/);
  });

  it("enforces the job timeout", async () => {
    const { game, w } = setup();
    for (let i = 0; i < 3; i++) write(game, `f${i}.bin`, "x");
    env.svc.ctx.db.run("UPDATE settings SET key=key");
    const id = addJob("slow", "collect", { selection: { root: game } }, 1, { timeoutSec: 1 });
    void id;
    await publish(w.id, "1", { "1": "a" });
    // swap in a handler that never finishes
    (env.svc.jobs as any).handlers.collect = (c: any) => new Promise((_, rej) => c.signal.addEventListener("abort", () => rej(c.signal.reason)));
    await publish(w.id, "2", { "1": "b" });
    await drain(8000);
    expect(runOf("slow")).toMatchObject({ status: "failed" });
    expect(runOf("slow").error).toMatch(/timed out after 1s/);
  });
});

describe("archive job + upload providers", () => {
  it("creates a ZIP with files + metadata and uploads/verifies via the local provider", async () => {
    const { game, w } = setup();
    write(game, "a.dll", "AAA"); write(game, "b.txt", "BBB");
    const dest = path.join(tmp, "uploads");
    const destId = env.svc.ctx.db.run("INSERT INTO destinations(name,type,config_json,created_at) VALUES('nas','local',?,?)", JSON.stringify({ dir: dest }), "x").lastId;
    addJob("zip", "archive", { selection: { root: game, extensions: [".dll"] }, include: { files: true, metadata: true }, destinationIds: [destId] });
    await publish(w.id, "1", { "1": "a" }); await publish(w.id, "2", { "1": "bbbb" }); await drain();
    const run = runOf("zip"); expect(run.status).toBe("succeeded");
    const res = JSON.parse(run.result_json).data;
    expect(res.uploads[0]).toMatchObject({ destination: "nas", verified: true });
    const uploaded = fs.readdirSync(dest);
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]).toMatch(/^Spacewar-480-b2-.*Z\.zip$/);
    const listing = zipList(path.join(dest, uploaded[0])).split(/\r?\n/).filter(Boolean).sort();
    expect(listing).toEqual(["files/a.dll", "metadata.json"]);
    const meta = JSON.parse(zipRead(path.join(dest, uploaded[0]), "metadata.json"));
    expect(meta.manifests).toEqual({ "1": "bbbb" }); expect(meta.buildId).toBe("2"); expect(meta.files[0].sha256).toHaveLength(64);
  });

  it("reports failed uploads (and does not leak secrets)", async () => {
    const { game, w } = setup();
    write(game, "a.dll", "AAA");
    const sec = env.svc.ctx.box.encrypt(JSON.stringify({ accessKeyId: "AKIAXXXX", secretAccessKey: "supersecret" }));
    const destId = env.svc.ctx.db.run("INSERT INTO destinations(name,type,config_json,secrets_enc,created_at) VALUES('s3','s3',?,?,?)",
      JSON.stringify({ endpoint: "https://127.0.0.1:9", bucket: "b", region: "us-east-1", prefix: "", forcePathStyle: true }), sec, "x").lastId;
    addJob("zip", "archive", { selection: { root: game }, destinationIds: [destId] });
    await publish(w.id, "1", { "1": "a" }); await publish(w.id, "2", { "1": "b" }); await drain();
    const run = runOf("zip");
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/private\/loopback/);       // SSRF guard blocks loopback endpoints unless explicitly allowed
    expect(run.log + run.error).not.toContain("supersecret");
  });
});

describe("decompile job", () => {
  it("fails clearly when the decompiler is not installed", async () => {
    const { game, w } = setup();
    write(game, "Managed/Assembly-CSharp.dll", "x");
    env.svc.ctx.settings.update({ tools: { ilspyCmdPath: "definitely-not-installed-ilspy" } });
    addJob("dec", "decompile", { selection: { root: game }, assemblies: ["Assembly-CSharp.dll"] });
    await publish(w.id, "1", { "1": "a" }); await publish(w.id, "2", { "1": "b" }); await drain();
    expect(runOf("dec")).toMatchObject({ status: "failed" });
    expect(runOf("dec").error).toMatch(/not found or not runnable.*dotnet tool install -g ilspycmd/s);
  });

  it("detects managed vs native PE files", async () => {
    const ver = dotnetDir && fs.readdirSync(dotnetDir).sort().at(-1);
    if (!ver) return;
    expect(await isManagedAssembly(path.join(dotnetDir!, ver, "System.Collections.dll"))).toBe(true);
    if (WIN) expect(await isManagedAssembly("C:/Windows/System32/kernel32.dll")).toBe(false);
  });

  it("strips token comments", () => {
    const src = "// Token: 0x06000001 RID: 1 RVA: 0x2050 File Offset: 0x250\npublic void A() { }\npublic int B; // Token: 0x04000002\n// keep me\n";
    const out = stripTokenComments(src);
    expect(out.text).toBe("public void A() { }\npublic int B;\n// keep me\n");
    expect(out.changed).toBe(2);
  });

  const ilspy = (() => { try { execFileSync("ilspycmd", ["--version"], { env: { ...process.env, DOTNET_ROLL_FORWARD: "Major" }, stdio: "pipe" }); return true; } catch { return false; } })();
  it.skipIf(!ilspy || !dotnetDir)("LIVE ilspycmd: exports a project without .sln or token comments, skips native DLLs, preserves inputs", async () => {
    const { game, w } = setup();
    const ver = fs.readdirSync(dotnetDir!).sort().at(-1)!;
    fs.mkdirSync(path.join(game, "Managed"), { recursive: true });
    fs.copyFileSync(path.join(dotnetDir!, ver, "System.Collections.dll"), path.join(game, "Managed/System.Collections.dll"));
    if (WIN) fs.copyFileSync("C:/Windows/System32/kernel32.dll", path.join(game, "Managed/kernel32.dll"));
    else fs.writeFileSync(path.join(game, "Managed/kernel32.dll"), Buffer.from([0x7f, 0x45, 0x4c, 0x46])); // not a PE => reported as native
    addJob("dec", "decompile", { selection: { root: game }, assemblies: ["System.Collections.dll", "kernel32.dll", "Missing.dll"], onExisting: "versioned" }, 1, { timeoutSec: 600 });
    await publish(w.id, "1", { "1": "a" }); await publish(w.id, "2", { "1": "b" }); await drain(120_000);
    const run = runOf("dec");
    expect(run.error).toBeNull();
    expect(run.status).toBe("succeeded");
    const res = JSON.parse(run.result_json).data;
    expect(res.outcomes.find((o: any) => o.assembly.endsWith("kernel32.dll")).status).toBe("native");
    expect(res.missingAssemblies).toEqual(["Missing.dll"]);
    const out = path.join(env.svc.ctx.settings.workDir(), "480", "dec-1");
    const proj = path.join(out, "src", "System.Collections");
    const all = fs.readdirSync(proj, { recursive: true }).map(String);
    expect(all.some((f) => f.endsWith(".csproj"))).toBe(true);
    expect(all.some((f) => f.endsWith(".sln"))).toBe(false);
    for (const f of all.filter((x) => x.endsWith(".cs"))) expect(fs.readFileSync(path.join(proj, f), "utf8")).not.toMatch(/\/\/\s*Token:/);
    const info = JSON.parse(fs.readFileSync(path.join(proj, "export-info.json"), "utf8"));
    expect(info.tool.version).toMatch(/^\d+\.\d+/); expect(info.settings.tokenComments).toMatch(/disabled/);
    expect(fs.existsSync(path.join(out, "input/Managed/System.Collections.dll"))).toBe(true);

    // identical input again: skipped, nothing overwritten
    env.svc.jobs.enqueueManual(1); await drain(60_000);
    expect(JSON.parse(runOf("dec").result_json).data.outcomes.find((o: any) => o.assembly.endsWith("System.Collections.dll")).status).toBe("skipped");
  }, 180_000);
});

describe("git job", () => {
  const gitCfg = (repo: string, over: any = {}) => ({ repoPath: repo, branch: "main", sources: [{ sourceJobId: 1, path: "files", dest: "Spacewar", mirror: true }], authorName: "Hound", authorEmail: "hound@example.com", ...over });

  async function twoJobs(repoOver: any = {}) {
    const s = setup();
    const repo = path.join(tmp, "repo");
    addJob("collect", "collect", { selection: { root: s.game } }, 1);
    addJob("git", "git", gitCfg(repo, repoOver), 2);
    return { ...s, repo };
  }

  it("commit message format and deterministic multi-manifest rule", () => {
    const ev: any = (m: Record<string, string>, ut: string | null = "2026-10-17T21:30:00.000Z") => ({ updateTime: ut, detectedAt: "2026-10-18T00:00:00.000Z", newBuild: "77", changes: { manifestIds: m } });
    expect(eventTimestamp(ev({}))).toBe("2026-10-17T21-30-00Z");
    expect(eventTimestamp(ev({}, null))).toBe("2026-10-18T00-00-00Z");
    expect(manifestToken(ev({ "5": "1234567890123456789" }))).toBe("1234567890123456789");
    expect(manifestToken(ev({ "20": "B", "3": "A", "100": "C" }))).toBe("A+B+C");           // ordered by depot id, not insertion/lexical
    expect(manifestToken(ev({ "1": "a", "2": "b", "3": "c", "4": "d", "5": "e" }))).toBe("a+b+c+2");
    expect(manifestToken(ev({}))).toBe("build-77");
    expect(commitSubject({ ...ev({ "5": "1234567890123456789" }) } as any)).toBe("Manifest 1234567890123456789 2026-10-17T21-30-00Z");
    expect(isSecretLike(".env")).toBe(true); expect(isSecretLike("a/id_rsa")).toBe(true); expect(isSecretLike("src/Foo.cs")).toBe(false);
  });

  it("creates a commit per update, never an empty one, with metadata and without secrets", async () => {
    const { game, w, repo } = await twoJobs();
    write(game, "A.dll", "v1"); write(game, ".env", "TOKEN=1"); write(game, "id_rsa", "key");
    await publish(w.id, "1", { "481": "1111" });
    const ev1 = await publish(w.id, "2", { "481": "2222" }, 1_792_000_200); await drain();
    expect(runOf("git")).toMatchObject({ status: "succeeded" });
    expect(git(repo, "log", "-1", "--format=%s")).toBe(`Manifest 2222 ${new Date(1_792_000_200 * 1000).toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-")}`);
    expect(git(repo, "log", "-1", "--format=%an <%ae>")).toBe("Hound <hound@example.com>");
    expect(git(repo, "log", "-1", "--format=%B")).toContain(`ManifestHound-Event: ${ev1}`);
    const tracked = git(repo, "ls-files").split("\n").sort();
    expect(tracked).toEqual(["Spacewar/A.dll", "Spacewar/manifesthound-metadata.json"]);   // no .env, no id_rsa
    const meta = JSON.parse(fs.readFileSync(path.join(repo, "Spacewar/manifesthound-metadata.json"), "utf8"));
    expect(meta).toMatchObject({ appId: 480, buildId: "2", manifestIds: { "481": "2222" }, eventId: ev1 });
    expect(meta.tools.git).toMatch(/git version/);

    // new update, files unchanged => no commit
    await publish(w.id, "3", { "481": "3333" }); await drain();
    expect(runOf("git").status).toBe("succeeded");
    expect(JSON.parse(runOf("git").result_json).data.commit.status).toBe("skipped");
    expect(git(repo, "rev-list", "--count", "HEAD")).toBe("1");

    // changed file => second commit
    write(game, "A.dll", "v2");
    await publish(w.id, "4", { "481": "4444" }); await drain();
    expect(git(repo, "rev-list", "--count", "HEAD")).toBe("2");
    expect(git(repo, "log", "-1", "--format=%s")).toMatch(/^Manifest 4444 /);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("retrying the same event is idempotent (no duplicate commit)", async () => {
    const { game, w, repo } = await twoJobs();
    write(game, "A.dll", "v1");
    await publish(w.id, "1", { "481": "1" }); await publish(w.id, "2", { "481": "2" }); await drain();
    const head = git(repo, "rev-parse", "HEAD");
    env.svc.ctx.db.run("UPDATE job_runs SET status='queued' WHERE job_name='git'");    // as after a crash before the result was saved
    await drain();
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
    expect(git(repo, "rev-list", "--count", "HEAD")).toBe("1");
    expect(JSON.parse(runOf("git").result_json).data.commit.status).toBe("reused");
  });

  it("leaves unrelated staged files out of the commit", async () => {
    const { game, w, repo } = await twoJobs();
    write(game, "A.dll", "v1");
    await publish(w.id, "1", { "481": "1" }); await publish(w.id, "2", { "481": "2" }); await drain();
    write(repo, "notes.txt", "mine"); git(repo, "add", "notes.txt");
    write(game, "A.dll", "v2");
    await publish(w.id, "3", { "481": "3" }); await drain();
    expect(git(repo, "show", "--name-only", "--format=", "HEAD").split("\n")).not.toContain("notes.txt");
    expect(git(repo, "diff", "--cached", "--name-only")).toBe("notes.txt");
  });

  it("pushes to the configured remote, reports push failures separately, and never force-pushes", async () => {
    const { game, w, repo } = await twoJobs();
    const remote = path.join(tmp, "remote.git");
    execFileSync("git", ["init", "--bare", "-b", "main", remote]);
    env.svc.ctx.db.run("UPDATE job_defs SET config_json=? WHERE name='git'", JSON.stringify({ ...gitCfg(repo), push: true, remoteUrl: remote.replace(/\\/g, "/") }));
    write(game, "A.dll", "v1");
    await publish(w.id, "1", { "481": "1" }); await publish(w.id, "2", { "481": "2" }); await drain();
    expect(runOf("git").status).toBe("succeeded");
    expect(JSON.parse(runOf("git").result_json).data.push.status).toBe("pushed");
    expect(git(remote, "rev-parse", "main")).toBe(git(repo, "rev-parse", "HEAD"));

    // someone else pushes to the remote -> our push is rejected (non-fast-forward), commit stays local & safe
    const other = path.join(tmp, "other"); execFileSync("git", ["clone", remote, other], { stdio: "pipe" });
    write(other, "x.txt", "x"); git(other, "add", "."); git(other, "-c", "user.name=o", "-c", "user.email=o@o", "commit", "-m", "other"); git(other, "push", "origin", "main");
    write(game, "A.dll", "v2");
    await publish(w.id, "3", { "481": "3" }); await drain();
    const run = runOf("git");
    expect(run.status).toBe("failed");
    const data = JSON.parse(run.result_json).data;
    expect(data.commit.status).toBe("created");
    expect(data.push.status).toBe("failed");
    expect(git(repo, "rev-list", "--count", "HEAD")).toBe("2");
    expect(git(remote, "log", "-1", "--format=%s")).toBe("other"); // remote history not rewritten
  });

  it("works locally with no remote and refuses to commit inside another repository", async () => {
    const { game, w } = await twoJobs();
    write(game, "A.dll", "v1");
    const outer = path.join(tmp, "outer"); fs.mkdirSync(outer); git(outer, "init", "-b", "main");
    env.svc.ctx.db.run("UPDATE job_defs SET config_json=? WHERE name='git'", JSON.stringify(gitCfg(path.join(outer, "inner"), { init: false })));
    fs.mkdirSync(path.join(outer, "inner"));
    await publish(w.id, "1", { "481": "1" }); await publish(w.id, "2", { "481": "2" }); await drain();
    expect(runOf("git").status).toBe("failed");
    expect(runOf("git").error).toMatch(/not a git repository|inside another repository/);
  });
});

describe("git job: spread layout", () => {
  it("puts each exported assembly folder at the repo root and prunes only inside them", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-spread-"));
    env = makeEnv();
    env.svc.ctx.settings.update({ paths: { allowedRoots: [tmp] } });
    const w = env.svc.watches.create({ appId: 480, followMode: "all" }, "Spacewar");
    const exp = path.join(tmp, "exports"); // stands in for the decompile job's src/ folder
    write(exp, "Assembly-CSharp/Game.cs", "class Game {}"); write(exp, "Assembly-CSharp/Old.cs", "class Old {}"); write(exp, "PhotonUnityNetworking/Net.cs", "class Net {}");
    const repo = path.join(tmp, "repo");
    write(repo, "README.md", "mine"); write(repo, "Unrelated/keep.txt", "keep");
    const cfg = { repoPath: repo, sources: [{ path: exp, dest: "", mirror: true }] };
    env.svc.ctx.db.run("INSERT INTO job_defs(name,type,ord,max_retries,timeout_sec,config_json,created_at,updated_at) VALUES('git','git',1,0,60,?,'x','x')", JSON.stringify(cfg));
    await publish(w.id, "1", { "1": "a" }); await publish(w.id, "2", { "1": "b" }); await drain();
    expect(runOf("git").error).toBeNull();
    expect(git(repo, "ls-files").split("\n").sort()).toEqual(["Assembly-CSharp/Game.cs", "Assembly-CSharp/Old.cs", "PhotonUnityNetworking/Net.cs", "manifesthound-metadata.json"]);
    // README and Unrelated stay untracked and untouched
    write(repo, "Unrelated/keep.txt", "keep");
    fs.rmSync(path.join(exp, "Assembly-CSharp/Old.cs")); write(exp, "Assembly-CSharp/Game.cs", "class Game2 {}");
    await publish(w.id, "3", { "1": "c" }); await drain();
    expect(runOf("git").status).toBe("succeeded");
    expect(git(repo, "ls-files").split("\n").sort()).toEqual(["Assembly-CSharp/Game.cs", "PhotonUnityNetworking/Net.cs", "manifesthound-metadata.json"]);
    expect(fs.existsSync(path.join(repo, "Unrelated/keep.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe("mine");
  }, 60_000);
});
