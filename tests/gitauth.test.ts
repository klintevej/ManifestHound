import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { makeEnv, waitFor, type Env } from "./helpers.js";
import { createApp } from "../src/web/server.js";
import { AuthService } from "../src/web/auth.js";
import { gitAuthEnv } from "../src/jobs/git.js";

let env: Env;
let tmp: string;
afterEach(async () => { await env?.cleanup(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

describe("git authentication", () => {
  it("scopes the Authorization header to the remote's own origin (PAT and password)", () => {
    const pat = gitAuthEnv("https://github.com/me/repo.git", { username: "", secret: "ghp_abc" });
    expect(pat.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraHeader");
    expect(Buffer.from(pat.GIT_CONFIG_VALUE_0!.replace("Authorization: Basic ", ""), "base64").toString()).toBe("x-access-token:ghp_abc");
    const pw = gitAuthEnv("https://git.example.org:8443/a/b.git", { username: "alice", secret: "pa:ss" });
    expect(pw.GIT_CONFIG_KEY_0).toBe("http.https://git.example.org:8443/.extraHeader");
    expect(Buffer.from(pw.GIT_CONFIG_VALUE_0!.replace("Authorization: Basic ", ""), "base64").toString()).toBe("alice:pa:ss");
  });
  it("refuses credentials for non-https remotes", () => {
    for (const u of ["git@github.com:me/repo.git", "ssh://git@host/x.git", "http://host/x.git", "/srv/repo.git"]) expect(() => gitAuthEnv(u, { username: "u", secret: "s" })).toThrow(/https/);
  });

  async function client() {
    env = makeEnv();
    const agent = request.agent(createApp(env.svc, new AuthService(env.svc.ctx)));
    const csrf = (await agent.post("/api/login").send({ password: "test-password-123" })).body.csrf as string;
    return { agent, csrf };
  }

  it("credential API stores secrets encrypted and never returns them", async () => {
    const { agent, csrf } = await client();
    const mk = await agent.post("/api/git/credentials").set("x-csrf-token", csrf).send({ name: "gh", kind: "pat", username: "", secret: "ghp_SUPERSECRET" });
    expect(mk.status).toBe(201);
    expect(JSON.stringify(mk.body)).not.toContain("SUPERSECRET");
    expect(JSON.stringify((await agent.get("/api/git/credentials")).body)).not.toContain("SUPERSECRET");
    const raw = env.svc.ctx.db.get("SELECT secret_enc FROM git_credentials")!.secret_enc as string;
    expect(raw.startsWith("v1:")).toBe(true); expect(raw).not.toContain("SUPERSECRET");
    // update without a secret keeps the old one
    await agent.put(`/api/git/credentials/${mk.body.id}`).set("x-csrf-token", csrf).send({ name: "gh2", kind: "pat", username: "me" });
    expect(env.svc.ctx.box.decrypt(env.svc.ctx.db.get("SELECT secret_enc FROM git_credentials")!.secret_enc)).toBe("ghp_SUPERSECRET");
    // validation
    expect((await agent.post("/api/git/credentials").set("x-csrf-token", csrf).send({ name: "p", kind: "password", username: "", secret: "x" })).status).toBe(400);
    expect((await agent.post("/api/git/credentials").set("x-csrf-token", csrf).send({ name: "n", kind: "pat" })).status).toBe(400);
  });

  it("validates the commit identity setting", async () => {
    const { agent, csrf } = await client();
    expect((await agent.put("/api/settings").set("x-csrf-token", csrf).send({ git: { authorEmail: "not an email" } })).status).toBe(400);
    expect((await agent.put("/api/settings").set("x-csrf-token", csrf).send({ git: { authorName: " ", authorEmail: "a@b.c" } })).status).toBe(400);
    const ok = await agent.put("/api/settings").set("x-csrf-token", csrf).send({ git: { authorName: "Bot", authorEmail: "123+bot@users.noreply.github.com" } });
    expect(ok.status).toBe(200);
  });

  it("a credential cannot be deleted while a job uses it, and local remotes reject credentials", async () => {
    const { agent, csrf } = await client();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-ga-"));
    const game = path.join(tmp, "game"); fs.mkdirSync(game); fs.writeFileSync(path.join(game, "a.txt"), "1");
    env.svc.ctx.settings.update({ paths: { allowedRoots: [tmp] } });
    const cred = (await agent.post("/api/git/credentials").set("x-csrf-token", csrf).send({ name: "gh", kind: "pat", secret: "S3CRET-PAT-VALUE" })).body.id;
    const job = await agent.post("/api/jobs").set("x-csrf-token", csrf).send({ name: "g", type: "git", config: {
      repoPath: path.join(tmp, "repo"), credentialId: cred, push: true, remoteUrl: path.join(tmp, "r.git").split(path.sep).join("/"), sources: [{ path: game, dest: "G" }] } });
    expect(job.status).toBe(201);
    expect((await agent.delete(`/api/git/credentials/${cred}`).set("x-csrf-token", csrf)).status).toBe(409);

    const w = env.svc.watches.create({ appId: 480, followMode: "all" }, "S");
    env.source.set(480, "1", { "1": "a" }); await env.svc.monitor.check(w.id);
    env.source.set(480, "2", { "1": "b" }); await env.svc.monitor.check(w.id);
    const db = env.svc.ctx.db;
    await waitFor(async () => { await env.svc.jobs.tick(); return !db.get("SELECT 1 FROM job_runs WHERE status IN ('queued','running')"); }, 30_000);
    const run = db.get("SELECT status,error,log FROM job_runs")!;
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/only works with https/);
    expect(run.log + run.error).not.toContain("S3CRET-PAT-VALUE");
  }, 60_000);
});
