import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/web/server.js";
import { AuthService } from "../src/web/auth.js";
import { HOOK_URL, makeEnv, type Env } from "./helpers.js";
import { redact, redactString } from "../src/util/redact.js";
import { assertSafeUrl, isPrivateIp } from "../src/util/ssrf.js";
import { SecretBox } from "../src/util/crypto.js";

let env: Env;
afterEach(async () => { await env?.cleanup(); });

async function client() {
  env = makeEnv();
  const app = createApp(env.svc, new AuthService(env.svc.ctx));
  const agent = request.agent(app);
  return { app, agent, login: async () => (await agent.post("/api/login").send({ password: "test-password-123" })).body.csrf as string };
}

describe("dashboard authentication", () => {
  it("rejects unauthenticated API access and bad passwords", async () => {
    const { app, agent } = await client();
    expect((await request(app).get("/api/watches")).status).toBe(401);
    expect((await request(app).get("/api/diagnostics/export")).status).toBe(401);
    expect((await agent.post("/api/login").send({ password: "wrong" })).status).toBe(401);
    expect((await request(app).get("/health")).status).toBe(200);
    expect((await request(app).get("/api/session")).body.authenticated).toBe(false);
  });
  it("locks out repeated failures", async () => {
    const { agent } = await client();
    for (let i = 0; i < 5; i++) await agent.post("/api/login").send({ password: "nope" });
    expect((await agent.post("/api/login").send({ password: "test-password-123" })).status).toBe(429);
  });
  it("requires the CSRF token and same-origin for state changes", async () => {
    const { agent, login } = await client();
    const csrf = await login();
    expect((await agent.get("/api/watches")).status).toBe(200);
    expect((await agent.post("/api/watches").send({ appId: 480 })).status).toBe(403);
    expect((await agent.post("/api/watches").set("x-csrf-token", "bad").send({ appId: 480 })).status).toBe(403);
    expect((await agent.post("/api/watches").set("x-csrf-token", csrf).set("Origin", "http://evil.example").send({ appId: 480 })).status).toBe(403);
  });
  it("blocks foreign Host headers on loopback (DNS rebinding)", async () => {
    const { app } = await client();
    expect((await request(app).get("/health").set("Host", "evil.example")).status).toBe(400);
    expect((await request(app).get("/health").set("Host", "localhost:4019")).status).toBe(200);
  });
  it("sets security headers and an HttpOnly SameSite=Strict cookie", async () => {
    const { agent } = await client();
    const res = await agent.post("/api/login").send({ password: "test-password-123" });
    expect(res.headers["set-cookie"][0]).toMatch(/HttpOnly/i);
    expect(res.headers["set-cookie"][0]).toMatch(/SameSite=Strict/i);
    expect(res.headers["content-security-policy"]).toContain("script-src 'self'");
  });
  it("changing the admin password is blocked when it comes from the environment", async () => {
    const { agent, login } = await client();
    const csrf = await login();
    const r = await agent.post("/api/auth/password").set("x-csrf-token", csrf).send({ current: "test-password-123", next: "another-long-password" });
    expect(r.status).toBe(400);
  });
});

describe("secret handling", () => {
  it("never returns webhook URLs, and diagnostics/exports are redacted", async () => {
    const { agent, login } = await client();
    const csrf = await login();
    const created = await agent.post("/api/webhooks").set("x-csrf-token", csrf).send({ name: "main", url: HOOK_URL });
    expect(created.status).toBe(201);
    const list = await agent.get("/api/webhooks");
    expect(JSON.stringify(list.body)).not.toContain("abcDEF_ghi-JKL".slice(0, 8) + "_ghi-JKL".slice(0, 0) + "xxxx");
    expect(JSON.stringify(list.body)).not.toContain(HOOK_URL);
    expect(JSON.stringify(list.body)).not.toContain("123456789012345678");
    // stored encrypted at rest
    const raw = env.svc.ctx.db.get("SELECT url_enc FROM webhooks")!.url_enc as string;
    expect(raw.startsWith("v1:")).toBe(true); expect(raw).not.toContain("discord");
    env.svc.ctx.logger.write("error", "test", `failed posting to ${HOOK_URL}`, { password: "hunter2", note: `Authorization: Bearer abc.def` });
    const settings = await agent.get("/api/settings");
    expect(JSON.stringify(settings.body)).not.toContain(HOOK_URL);
    const logs = JSON.stringify((await agent.get("/api/logs")).body);
    expect(logs).not.toContain("hunter2"); expect(logs).not.toContain("abcDEF_ghi-JKL");
  });
  it("rejects non-Discord webhook URLs", async () => {
    const { agent, login } = await client();
    const csrf = await login();
    const r = await agent.post("/api/webhooks").set("x-csrf-token", csrf).send({ name: "x", url: "https://example.com/hook" });
    expect(r.status).toBe(400);
  });
  it("redaction helpers mask secrets in objects and strings", () => {
    expect(redact({ a: 1, steamPassword: "x", nested: { refreshToken: "t", ok: "fine" } })).toEqual({ a: 1, steamPassword: "[REDACTED]", nested: { refreshToken: "[REDACTED]", ok: "fine" } });
    expect(redactString("hit https://discord.com/api/webhooks/1/abc and https://user:pw@host/x")).toBe("hit [REDACTED_WEBHOOK] and https://user:[REDACTED]@host/x");
  });
  it("SecretBox round-trips and detects tampering", () => {
    const b = new SecretBox(Buffer.alloc(32, 7));
    const c = b.encrypt("secret"); expect(c).not.toContain("secret"); expect(b.decrypt(c)).toBe("secret");
    expect(b.encrypt("secret")).not.toBe(c);
    expect(() => b.decrypt(c.slice(0, -4) + "AAAA")).toThrow();
  });
});

describe("SSRF protection", () => {
  it("blocks private/loopback/link-local targets and non-HTTPS", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.20.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1"]) expect(isPrivateIp(ip)).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    await expect(assertSafeUrl("https://169.254.169.254/latest")).rejects.toThrow(/private/);
    await expect(assertSafeUrl("http://example.com")).rejects.toThrow(/scheme/);
    await expect(assertSafeUrl("https://u:p@example.com")).rejects.toThrow(/Credentials/);
    await expect(assertSafeUrl("https://localhost/x")).rejects.toThrow(/private/);
    await expect(assertSafeUrl("http://127.0.0.1:8080/x", { allowPrivate: true, protocols: ["http:"] })).resolves.toBeInstanceOf(URL);
  });
});

describe("management API", () => {
  it("watch lifecycle: create, edit, pause, resume, delete requires confirmation", async () => {
    const { agent, login } = await client();
    const csrf = await login();
    const h = (r: any) => r.set("x-csrf-token", csrf);
    env.source.set(480, "1", { "1": "a" });
    const c = await h(agent.post("/api/watches")).send({ appId: 480, name: "Spacewar", followMode: "build" });
    expect(c.status).toBe(201);
    const id = c.body.id;
    expect((await h(agent.patch(`/api/watches/${id}`)).send({ intervalSec: 5 })).status).toBe(400);
    expect((await h(agent.patch(`/api/watches/${id}`)).send({ intervalSec: 120 })).body.intervalSec).toBe(120);
    expect((await h(agent.post(`/api/watches/${id}/pause`)).send()).body.status).toBe("paused");
    expect((await h(agent.post(`/api/watches/${id}/resume`)).send()).body.enabled).toBe(true);
    expect((await h(agent.post(`/api/watches/${id}/check`)).send()).body).toMatchObject({ ok: true });
    expect((await h(agent.delete(`/api/watches/${id}`))).status).toBe(400);
    expect((await h(agent.delete(`/api/watches/${id}?confirm=yes&deleteHistory=1`))).status).toBe(200);
    expect((await agent.get("/api/watches")).body).toEqual([]);
    expect((await agent.get("/api/events")).body.total).toBe(0);
  });
  it("template preview renders realistic sample data without sending", async () => {
    const { agent, login } = await client();
    const csrf = await login();
    const r = await agent.post("/api/templates/preview").set("x-csrf-token", csrf).send({ template: "{game_name} updated {date:YYYY-MM-DD} {manifest_ids}", notify: { timezone: "UTC" } });
    expect(r.status).toBe(200);
    expect(r.body.text).toMatch(/^Example Game updated \d{4}-\d{2}-\d{2} 481: 2222222222222222222\n482: 4444444444444444444$/);
    expect(env.sent).toHaveLength(0);
    const bad = await agent.post("/api/templates/preview").set("x-csrf-token", csrf).send({ template: "{nope}" });
    expect(bad.body.warnings[0]).toMatch(/Unknown variable/);
  });
  it("history search finds events by manifest and build, and exposes details", async () => {
    const { agent, login } = await client();
    await login();
    const w = env.svc.watches.create({ appId: 480, followMode: "all" }, "Spacewar");
    env.source.set(480, "10", { "1": "aaaa" }); await env.svc.monitor.check(w.id);
    env.source.set(480, "11", { "1": "bbbb4242" }); const r = await env.svc.monitor.check(w.id);
    const found = await agent.get("/api/events?q=bbbb4242");
    expect(found.body.items.map((e: any) => e.id)).toEqual([r.eventId]);
    expect((await agent.get("/api/events?q=zzzz")).body.total).toBe(0);
    expect((await agent.get(`/api/events/${r.eventId}`)).body.changes.depots[0]).toMatchObject({ to: "bbbb4242", from: "aaaa" });
  });
});
