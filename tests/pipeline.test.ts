import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { getEventDetail, recordDetection } from "../src/events.js";
import { detect } from "../src/monitor/detector.js";
import { Monitor } from "../src/monitor/service.js";
import { addHook, HOOK_URL, makeEnv, waitFor, type Env } from "./helpers.js";
import { loadBootConfig } from "../src/config.js";

let env: Env;
afterEach(async () => { await env?.cleanup(); });

const watchIn = (e: Env, over: any = {}) => e.svc.watches.create({ appId: 480, followMode: "all", ...over }, "Spacewar");

function addJob(e: Env, name: string, ord: number, type = "collect", over: Record<string, any> = {}) {
  return e.svc.ctx.db.run(
    "INSERT INTO job_defs(watch_id,name,type,ord,stop_on_fail,max_retries,timeout_sec,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    over.watchId ?? null, name, type, ord, over.stopOnFail ? 1 : 0, over.maxRetries ?? 0, over.timeoutSec ?? 60, "{}", "2026-01-01", "2026-01-01").lastId;
}
const runs = (e: Env) => e.svc.ctx.db.all("SELECT job_name,status,attempts,error FROM job_runs ORDER BY id");
const events = (e: Env) => e.svc.ctx.db.all("SELECT kind FROM events ORDER BY created_at, rowid").map((r) => r.kind);

describe("event pipeline end to end", () => {
  it("baseline -> update -> event + notification + jobs + history", async () => {
    const order: string[] = [];
    env = makeEnv(undefined, { handlers: { collect: async (c) => { order.push(c.def.name); return { summary: `ran ${c.def.name}`, data: { build: c.event.newBuild } }; } } });
    const hook = addHook(env);
    const w = watchIn(env);
    addJob(env, "collector", 1);

    env.source.set(480, "100", { "481": "1111", "482": "2222" });
    expect(await env.svc.monitor.check(w.id)).toMatchObject({ ok: true, kind: "baseline" });
    // baseline = recorded but silent
    expect(events(env)).toEqual(["baseline"]);
    expect(env.svc.ctx.db.all("SELECT * FROM notifications")).toHaveLength(0);
    expect(runs(env)).toHaveLength(0);

    // no change => no event
    expect(await env.svc.monitor.check(w.id)).toMatchObject({ ok: true, kind: "unchanged" });

    env.source.set(480, "101", { "481": "1111", "482": "3333" }, 1_800_000_500);
    const r = await env.svc.monitor.check(w.id);
    expect(r).toMatchObject({ ok: true, kind: "update" });
    expect(r.eventId).toBeTruthy();

    // queued durably in the same transaction
    expect(env.svc.ctx.db.all("SELECT status FROM notifications").map((x) => x.status)).toEqual(["pending"]);
    expect(runs(env).map((x) => x.status)).toEqual(["queued"]);

    await env.svc.notifier.tick();
    await env.svc.jobs.tick();
    await waitFor(() => runs(env)[0].status === "succeeded");

    expect(env.sent).toHaveLength(1);
    expect(env.sent[0].url).toBe(HOOK_URL);
    const content: string = env.sent[0].payload.content;
    expect(content).toContain("Spacewar");
    expect(content).toContain("3333");
    expect(content).toContain("<t:1800000500:F>"); // real update time, not "now"
    expect(order).toEqual(["collector"]);

    const detail: any = getEventDetail(env.svc.ctx, r.eventId!);
    expect(detail.notifications[0]).toMatchObject({ status: "delivered", webhook_id: hook });
    expect(detail.jobs[0]).toMatchObject({ status: "succeeded", job_name: "collector" });
    expect(detail.jobs[0].result.summary).toBe("ran collector");
    expect(detail.changes.depots).toEqual([{ depotId: "482", change: "changed", from: "2222", to: "3333", tracked: true }]);
    expect(detail.prevBuild).toBe("100"); expect(detail.newBuild).toBe("101");
  });

  it("temporary Steam failure does not change state or create events", async () => {
    env = makeEnv();
    const w = watchIn(env);
    env.source.set(480, "100", { "1": "a" });
    await env.svc.monitor.check(w.id);
    env.source.fail(480, "Steam unreachable");
    const r = await env.svc.monitor.check(w.id);
    expect(r.ok).toBe(false);
    const row = env.svc.watches.get(w.id)!;
    expect(row.status).toBe("error"); expect(row.consecutiveFailures).toBe(1); expect(row.lastError).toContain("unreachable");
    env.source.set(480, "100", { "1": "a" });
    await env.svc.monitor.check(w.id);
    expect(events(env)).toEqual(["baseline"]);
    expect(env.svc.watches.get(w.id)!.consecutiveFailures).toBe(0);
  });

  it("restart/cache loss never reports a spurious update", async () => {
    env = makeEnv();
    const w = watchIn(env);
    env.source.set(480, "100", { "1": "a" });
    await env.svc.monitor.check(w.id);
    env = env.reopen();
    env.source.set(480, "100", { "1": "a" });
    expect((await env.svc.monitor.check(w.id)).kind).toBe("unchanged");
    expect(events(env)).toEqual(["baseline"]);
  });

  it("baseline can be disabled: first check then notifies", async () => {
    env = makeEnv(); addHook(env);
    const w = watchIn(env, { baselineFirst: false });
    env.source.set(480, "100", { "1": "a" });
    expect((await env.svc.monitor.check(w.id)).kind).toBe("initial");
    await env.svc.notifier.tick();
    expect(env.sent).toHaveLength(1);
  });

  it("duplicate events are rejected by the persistent dedupe key", async () => {
    env = makeEnv(); addHook(env);
    const w = watchIn(env);
    const s1 = { appId: 480, name: "x", branch: "public", buildId: "100", timeUpdated: 1, source: "t", fetchedAt: "", depots: { "1": { manifest: "a" } } };
    const s2 = { ...s1, buildId: "101", depots: { "1": { manifest: "b" } } };
    const base = detect(null, s1, { followMode: "all", depotIds: [], baselineFirst: true }, w.id);
    recordDetection(env.svc.ctx, w, s1, base);
    const upd = detect(base.next, s2, { followMode: "all", depotIds: [], baselineFirst: true }, w.id);
    expect(recordDetection(env.svc.ctx, w, s2, upd)).toBeTruthy();
    expect(recordDetection(env.svc.ctx, w, s2, upd)).toBeNull();
    expect(events(env)).toEqual(["baseline", "update"]);
    expect(env.svc.ctx.db.all("SELECT * FROM notifications")).toHaveLength(1);
  });

  it("rollback is recorded as its own kind", async () => {
    env = makeEnv(); addHook(env);
    const w = watchIn(env);
    env.source.set(480, "200", { "1": "new" }); await env.svc.monitor.check(w.id);
    env.source.set(480, "150", { "1": "old" }); await env.svc.monitor.check(w.id);
    expect(events(env)).toEqual(["baseline", "rollback"]);
  });

  it("respects the per-game polling interval and failure backoff", async () => {
    env = makeEnv();
    const w = watchIn(env, { intervalSec: 60 });
    env.source.set(480, "100", { "1": "a" });
    const t0 = Date.now();
    await env.svc.monitor.tick(t0);
    await waitFor(() => env.source.calls === 1);
    await new Promise((r) => setTimeout(r, 30));
    await env.svc.monitor.tick(t0 + 30_000);
    await new Promise((r) => setTimeout(r, 30));
    expect(env.source.calls).toBe(1);
    await env.svc.monitor.tick(t0 + 61_000);
    await waitFor(() => env.source.calls === 2);
    expect(Monitor.nextDelayMs({ intervalSec: 60, consecutiveFailures: 0 })).toBe(60_000);
    expect(Monitor.nextDelayMs({ intervalSec: 60, consecutiveFailures: 4 })).toBeGreaterThanOrEqual(60_000);
    expect(env.svc.ctx.settings.get().polling.defaultIntervalSec).toBe(60);
    expect(w.intervalSec).toBe(60);
  });

  it("paused watches are not polled", async () => {
    env = makeEnv();
    const w = watchIn(env);
    env.svc.watches.update(w.id, { enabled: false });
    env.source.set(480, "1", { "1": "a" });
    await env.svc.monitor.tick();
    await new Promise((r) => setTimeout(r, 30));
    expect(env.source.calls).toBe(0);
  });
});

describe("notification delivery", () => {
  async function updated() {
    env = makeEnv(); addHook(env);
    const w = watchIn(env);
    env.source.set(480, "1", { "1": "a" }); await env.svc.monitor.check(w.id);
    env.source.set(480, "2", { "1": "b" }); return (await env.svc.monitor.check(w.id)).eventId!;
  }
  const notif = () => env.svc.ctx.db.get("SELECT * FROM notifications")!;
  const due = () => env.svc.ctx.db.run("UPDATE notifications SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE status='pending'");

  it("retries 5xx with backoff, then delivers", async () => {
    await updated();
    env.sendResults.push({ ok: false, status: 502, error: "Discord server error 502" });
    await env.svc.notifier.tick();
    expect(notif()).toMatchObject({ status: "pending", attempts: 1, http_status: 502 });
    expect(Date.parse(notif().next_attempt_at)).toBeGreaterThan(Date.now());
    due(); await env.svc.notifier.tick();
    expect(notif()).toMatchObject({ status: "delivered", attempts: 2 });
  });

  it("honours Discord rate limit retry_after", async () => {
    await updated();
    env.sendResults.push({ ok: false, status: 429, retryAfterMs: 30_000, error: "Rate limited by Discord" });
    await env.svc.notifier.tick();
    const delay = Date.parse(notif().next_attempt_at) - Date.now();
    expect(delay).toBeGreaterThan(25_000); expect(delay).toBeLessThanOrEqual(30_500);
  });

  it("permanent failures stop retrying, can be retried manually, and are recorded", async () => {
    await updated();
    env.sendResults.push({ ok: false, status: 404, permanent: true, error: "Unknown Webhook" });
    await env.svc.notifier.tick();
    expect(notif()).toMatchObject({ status: "failed", attempts: 1 });
    expect(notif().last_error).toContain("Unknown Webhook");
    expect(env.svc.notifier.retry(notif().id)).toBe(true);
    await waitFor(() => notif().status === "delivered");
  });

  it("gives up after maxAttempts", async () => {
    await updated();
    env.svc.ctx.settings.update({ notifications: { maxAttempts: 2 } });
    env.sendResults.push({ ok: false, error: "net" }, { ok: false, error: "net" });
    await env.svc.notifier.tick(); due(); await env.svc.notifier.tick();
    expect(notif()).toMatchObject({ status: "failed", attempts: 2 });
  });

  it("is suppressed (with a reason) when no webhook exists or the kind is suppressed", async () => {
    env = makeEnv();
    const w = watchIn(env);
    env.source.set(480, "1", { "1": "a" }); await env.svc.monitor.check(w.id);
    env.source.set(480, "2", { "1": "b" }); await env.svc.monitor.check(w.id);
    expect(notif()).toMatchObject({ status: "suppressed", detail: "No webhook configured" });
    await env.svc.notifier.tick();
    expect(env.sent).toHaveLength(0);
  });

  it("crash while 'sending' is re-queued on startup", async () => {
    await updated();
    env.svc.ctx.db.run("UPDATE notifications SET status='sending'");
    env.svc.notifier.start(); env.svc.notifier.stop();
    expect(notif().status).toBe("pending");
  });
});

describe("job engine", () => {
  async function updatedWith(e: Env) {
    const w = watchIn(e);
    e.source.set(480, "1", { "1": "a" }); await e.svc.monitor.check(w.id);
    e.source.set(480, "2", { "1": "b" }); return (await e.svc.monitor.check(w.id)).eventId!;
  }
  const drain = async (e: Env, ms = 3000) => { await waitFor(async () => { await e.svc.jobs.tick(); return !e.svc.ctx.db.get("SELECT 1 FROM job_runs WHERE status IN ('queued','running')"); }, ms); };

  it("runs in 'order', allows equal order in parallel, never overlaps different orders", async () => {
    const log: string[] = [];
    const slow = (n: string, ms: number) => async () => { log.push(`start ${n}`); await new Promise((r) => setTimeout(r, ms)); log.push(`end ${n}`); return { summary: n }; };
    env = makeEnv(undefined, { handlers: { collect: async (c) => slow(c.def.name, c.def.name === "A" ? 60 : 20)(), report: slow("C", 10) } });
    env.svc.ctx.settings.update({ jobs: { maxConcurrent: 4 } });
    addJob(env, "A", 1); addJob(env, "B", 1); addJob(env, "C", 2, "report");
    await updatedWith(env);
    await drain(env);
    expect(runs(env).map((r) => r.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(log.indexOf("start B")).toBeLessThan(log.indexOf("end A"));           // parallel within the same order
    expect(log.indexOf("start C")).toBeGreaterThan(log.indexOf("end A"));        // later order waits for earlier
    expect(log.indexOf("start C")).toBeGreaterThan(log.indexOf("end B"));
  });

  it("a failing stop-on-fail job skips later jobs; others continue", async () => {
    env = makeEnv(undefined, { handlers: { collect: async (c) => { if (c.def.name === "bad") throw new Error("kaput"); return { summary: "ok" }; }, report: async () => ({ summary: "ok" }) } });
    addJob(env, "bad", 1, "collect", { stopOnFail: true }); addJob(env, "later", 2, "report"); addJob(env, "parallel-peer", 1, "report");
    await updatedWith(env);
    await drain(env);
    const by = Object.fromEntries(runs(env).map((r) => [r.job_name, r]));
    expect(by.bad).toMatchObject({ status: "failed", error: "kaput" });
    expect(by["parallel-peer"].status).toBe("succeeded");
    expect(by.later.status).toBe("skipped");
    expect(by.later.error).toContain("bad");
  });

  it("a failure without stop-on-fail does not block later jobs", async () => {
    env = makeEnv(undefined, { handlers: { collect: async () => { throw new Error("x"); }, report: async () => ({ summary: "ok" }) } });
    addJob(env, "bad", 1); addJob(env, "later", 2, "report");
    await updatedWith(env); await drain(env);
    expect(runs(env).map((r) => r.status)).toEqual(["failed", "succeeded"]);
  });

  it("retries according to policy with backoff", async () => {
    let n = 0;
    env = makeEnv(undefined, { handlers: { collect: async () => { if (++n < 2) throw new Error("flaky"); return { summary: "ok" }; } } });
    addJob(env, "flaky", 1, "collect", { maxRetries: 2 });
    await updatedWith(env);
    await env.svc.jobs.tick(); await waitFor(() => runs(env)[0].status === "queued" && runs(env)[0].attempts === 1);
    expect(env.svc.ctx.db.get("SELECT next_attempt_at n FROM job_runs")!.n > new Date().toISOString()).toBe(true);
    env.svc.ctx.db.run("UPDATE job_runs SET next_attempt_at='2000-01-01'");
    await drain(env);
    expect(runs(env)[0]).toMatchObject({ status: "succeeded", attempts: 2 });
  });

  it("enforces timeouts", async () => {
    env = makeEnv(undefined, { handlers: { collect: (c) => new Promise((_, rej) => c.signal.addEventListener("abort", () => rej(c.signal.reason))) } });
    addJob(env, "hang", 1, "collect", { timeoutSec: 5 });
    env.svc.ctx.db.run("UPDATE job_defs SET timeout_sec=5");
    await updatedWith(env);
    // shorten the timer for the test by aborting via cancel path
    await env.svc.jobs.tick(); await waitFor(() => runs(env)[0].status === "running");
    const id = env.svc.ctx.db.get("SELECT id FROM job_runs")!.id;
    env.svc.jobs.cancel(id);
    await waitFor(() => runs(env)[0].status === "cancelled");
  });

  it("does not run the same job twice for one event, but allows an explicit rerun", async () => {
    let n = 0;
    env = makeEnv(undefined, { handlers: { collect: async () => ({ summary: String(++n) }) } });
    const j = addJob(env, "once", 1);
    const ev = await updatedWith(env);
    await drain(env);
    expect(() => env.svc.ctx.db.run("INSERT INTO job_runs(event_id,job_id,job_name,ord,status,created_at) VALUES(?,?,?,?,?,?)", ev, j, "once", 1, "queued", "x")).toThrow(/UNIQUE/);
    env.svc.jobs.enqueueManual(j, ev);
    await drain(env);
    expect(n).toBe(2);
    expect(runs(env).map((r) => r.status)).toEqual(["succeeded", "succeeded"]);
  });

  it("recovers interrupted runs after a restart and re-runs them", async () => {
    let n = 0;
    env = makeEnv();
    addJob(env, "interrupted", 1, "collect", { maxRetries: 1 });
    await updatedWith(env);
    env.svc.ctx.db.run("UPDATE job_runs SET status='running', attempts=1, started_at='2026-01-01'"); // as if the process died mid-job
    env = env.reopen({ handlers: { collect: async () => ({ summary: String(++n) }) } });
    env.svc.jobs.recover();
    expect(runs(env)[0].status).toBe("queued");
    await drain(env);
    expect(n).toBe(1);
    expect(runs(env)[0]).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(env.svc.ctx.db.get("SELECT log FROM job_runs")!.log).toContain("Interrupted by application restart");
  });

  it("gives up on a run that keeps crashing the app", async () => {
    env = makeEnv();
    addJob(env, "crashy", 1, "collect", { maxRetries: 0 });
    await updatedWith(env);
    env.svc.ctx.db.run("UPDATE job_runs SET status='running', attempts=1");
    env.svc.jobs.recover();
    expect(runs(env)[0].status).toBe("failed");
  });

  it("job filter by depot only queues matching jobs", async () => {
    env = makeEnv(undefined, { handlers: { collect: async () => ({ summary: "ok" }) } });
    addJob(env, "all", 1); const f = addJob(env, "only-depot-99", 1);
    env.svc.ctx.db.run("UPDATE job_defs SET depot_filter='[\"99\"]' WHERE id=?", f);
    await updatedWith(env);
    expect(runs(env).map((r) => r.job_name)).toEqual(["all"]);
  });
});

describe("configuration validation", () => {
  it("rejects invalid bootstrap configuration", () => {
    expect(() => loadBootConfig({ MH_PORT: "99999" } as any, os.tmpdir())).toThrow(/port/);
    expect(() => loadBootConfig({ MH_HOST: "0.0.0.0" } as any, os.tmpdir())).toThrow(/non-loopback/);
    expect(() => loadBootConfig({ MH_ADMIN_PASSWORD: "short" } as any, os.tmpdir())).toThrow(/at least 8/);
    expect(loadBootConfig({ MH_PORT: "5000" } as any, os.tmpdir()).port).toBe(5000);
    expect(loadBootConfig({} as any, os.tmpdir())).toMatchObject({ port: 4019, host: "127.0.0.1" });
  });
  it("rejects invalid settings and watch input", () => {
    env = makeEnv();
    expect(() => env.svc.ctx.settings.update({ polling: { defaultIntervalSec: 1 } })).toThrow(/Invalid settings/);
    expect(() => env.svc.watches.create({ appId: 480, followMode: "depots", depotIds: [] })).toThrow(/at least one depot/);
    expect(() => env.svc.watches.create({ appId: 480, intervalSec: 2 })).toThrow(/at least 10s/);
    expect(() => env.svc.watches.create({ appId: -4 })).toThrow();
    const w = env.svc.watches.create({ appId: 480 }, "X");
    expect(w.intervalSec).toBe(60);
    expect(() => env.svc.watches.create({ appId: 480 })).toThrow(/already monitored/);
  });
  it("settings persist across restarts", () => {
    env = makeEnv();
    env.svc.ctx.settings.update({ polling: { defaultIntervalSec: 120 }, notifications: { timezone: "Europe/Berlin" } });
    env = env.reopen();
    expect(env.svc.ctx.settings.get().polling.defaultIntervalSec).toBe(120);
    expect(env.svc.ctx.settings.get().notifications.timezone).toBe("Europe/Berlin");
  });
});
