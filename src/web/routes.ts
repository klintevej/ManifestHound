import { Router } from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { z } from "zod";
import type { Services } from "../services.js";
import type { AuthService } from "./auth.js";
import { createManualEvent, getEventDetail, rowToEvent, type EventRecord } from "../events.js";
import { NotifySchema, rowToWatch } from "../watches.js";
import { searchGames, storeAppName } from "../steam/store.js";
import { buildPayload, buildTemplateContext, sendWebhook, validateWebhookUrl } from "../notify/discord.js";
import { render } from "../notify/template.js";
import { JOB_TYPES, rowToJobDef, validateConfig, type JobType } from "../jobs/types.js";
import { DEST_TYPES, SECRET_FIELDS, createProvider, validateDestinationConfig, type DestRow, type DestType } from "../jobs/uploads.js";
import { parseJson, resolveInsideRoots, UserError, nowIso } from "../util/misc.js";
import { redact } from "../util/redact.js";
import { runProc, cleanOutput, resolveTool } from "../util/proc.js";
import { writeNetworkConfig } from "../config.js";
import { assertSafeUrl } from "../util/ssrf.js";
import { gitAuthEnv, loadGitCredential } from "../jobs/git.js";
import { TEMPLATE_HELP } from "../notify/help.js";

const require = createRequire(import.meta.url);
const num = (v: unknown, name = "id") => { const n = Number(v); if (!Number.isInteger(n) || n < 0) throw new UserError(`Invalid ${name}`); return n; };

function sampleEvent(name = "Example Game", appId = 480): EventRecord {
  const now = new Date();
  return {
    id: "00000000-0000-4000-8000-000000000000", watchId: null, appId, gameName: name, kind: "update", detectedAt: now.toISOString(),
    updateTime: new Date(now.getTime() - 90_000).toISOString(), prevBuild: "12345678", newBuild: "12349999",
    changes: {
      buildChange: { from: "12345678", to: "12349999" }, rollback: false, trigger: ["build", "depot"],
      depots: [
        { depotId: "481", change: "changed", from: "1111111111111111111", to: "2222222222222222222", tracked: true },
        { depotId: "482", change: "changed", from: "3333333333333333333", to: "4444444444444444444", tracked: true },
      ],
      manifestIds: { "481": "2222222222222222222", "482": "4444444444444444444" },
    },
  };
}

export function apiRouter(svc: Services, auth: AuthService) {
  const { ctx } = svc;
  const db = ctx.db;
  const r = Router();

  // ------------------------------------------------------------------ overview / status
  r.get("/overview", (_req, res) => {
    const watches = svc.watches.list();
    const recentEvents = db.all("SELECT id, game_name, app_id, kind, detected_at, update_time, new_build FROM events WHERE kind!='baseline' ORDER BY detected_at DESC LIMIT 8");
    const recentNotifs = db.all(`SELECT n.id, n.status, n.attempts, n.last_error, n.delivered_at, n.created_at, e.game_name, e.id AS event_id FROM notifications n JOIN events e ON e.id=n.event_id ORDER BY n.id DESC LIMIT 8`);
    const active = db.all("SELECT id, event_id, job_name, status, started_at FROM job_runs WHERE status IN ('running','queued') ORDER BY id DESC LIMIT 20");
    const failedJobs = db.all("SELECT id, event_id, job_name, error, finished_at FROM job_runs WHERE status='failed' ORDER BY finished_at DESC LIMIT 10");
    const failedNotifs = db.all("SELECT n.id, n.event_id, n.last_error, e.game_name FROM notifications n JOIN events e ON e.id=n.event_id WHERE n.status='failed' ORDER BY n.id DESC LIMIT 10");
    res.json({
      counts: { watches: watches.length, enabled: watches.filter((w) => w.enabled).length, erroring: watches.filter((w) => w.enabled && w.status === "error").length },
      health: watches.length === 0 ? "idle" : watches.some((w) => w.enabled && w.consecutiveFailures >= 3) ? "degraded" : "ok",
      recentEvents, recentNotifs, active, failed: { jobs: failedJobs, notifications: failedNotifs },
      games: watches.map((w) => ({ id: w.id, name: w.name, appId: w.appId, status: w.status, lastSuccessAt: w.lastSuccessAt, lastError: w.lastError })),
    });
  });

  // ------------------------------------------------------------------ steam metadata
  r.get("/steam/search", async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (q.length < 2) return void res.json({ results: [] });
    if (/^\d+$/.test(q)) {
      const name = await storeAppName(Number(q)).catch(() => null);
      return void res.json({ results: [{ appId: Number(q), name: name ?? `App ${q}`, iconUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${q}/header.jpg` }], note: "Name and image only. Builds and manifests come from Steam after the first check." });
    }
    try { res.json({ results: await searchGames(q, ctx.settings.get().steam.requestTimeoutMs), note: "Name and image only. Builds and manifests come from Steam after the first check." }); }
    catch (e) { throw new UserError(`Steam Store search failed: ${(e as Error).message}`, 502); }
  });

  // ------------------------------------------------------------------ watches
  r.get("/watches", (_req, res) => {
    const states = new Map(db.all("SELECT * FROM watch_state").map((s) => [s.watch_id, s]));
    res.json(svc.watches.list().map((w) => {
      const s = states.get(w.id);
      return { ...w, buildId: s?.build_id ?? null, manifests: parseJson(s?.depots_json, {}), accountName: w.accountId ? db.get("SELECT name FROM accounts WHERE id=?", w.accountId)?.name : null };
    }));
  });
  r.post("/watches", async (req, res) => {
    const name = req.body?.name ? null : await storeAppName(Number(req.body?.appId)).catch(() => null);
    const w = svc.watches.create(req.body, name);
    void svc.monitor.check(w.id);
    res.status(201).json(w);
  });
  r.patch("/watches/:id", (req, res) => res.json(svc.watches.update(num(req.params.id), req.body ?? {})));
  r.delete("/watches/:id", (req, res) => {
    if (req.query.confirm !== "yes") throw new UserError("Confirmation required (?confirm=yes)");
    svc.watches.remove(num(req.params.id), req.query.deleteHistory === "1");
    res.json({ ok: true });
  });
  r.post("/watches/:id/check", async (req, res) => res.json(await svc.monitor.check(num(req.params.id))));
  r.post("/watches/:id/pull", async (req, res) => {
    const w = svc.watches.get(num(req.params.id));
    if (!w) throw new UserError("Game not found", 404);
    await svc.monitor.check(w.id); // refresh the known build first; a failed check is fine if a build is already recorded
    res.status(202).json({ eventId: createManualEvent(ctx, w) });
  });
  r.post("/watches/:id/pause", (req, res) => res.json(svc.watches.update(num(req.params.id), { enabled: false })));
  r.post("/watches/:id/resume", (req, res) => res.json(svc.watches.update(num(req.params.id), { enabled: true })));

  // ------------------------------------------------------------------ events
  r.get("/events", (req, res) => {
    const q = String(req.query.q ?? "").trim();
    const limit = Math.min(200, Number(req.query.limit) || 50), offset = Number(req.query.offset) || 0;
    const where: string[] = ["1=1"]; const p: any[] = [];
    if (req.query.watchId) { where.push("e.watch_id=?"); p.push(num(req.query.watchId)); }
    if (req.query.kind) { where.push("e.kind=?"); p.push(String(req.query.kind)); }
    if (q) { where.push("(e.game_name LIKE ? OR CAST(e.app_id AS TEXT)=? OR e.new_build=? OR e.prev_build=? OR e.changes_json LIKE ?)"); p.push(`%${q}%`, q, q, q, `%${q.replace(/[%_]/g, "")}%`); }
    const rows = db.all(
      `SELECT e.*, (SELECT group_concat(status) FROM notifications WHERE event_id=e.id) AS notif_status,
              (SELECT group_concat(status) FROM job_runs WHERE event_id=e.id) AS job_status
       FROM events e WHERE ${where.join(" AND ")} ORDER BY e.detected_at DESC LIMIT ? OFFSET ?`, ...p, limit, offset);
    const total = db.get(`SELECT COUNT(*) c FROM events e WHERE ${where.join(" AND ")}`, ...p)!.c;
    res.json({ total, items: rows.map((x) => ({ ...rowToEvent(x), notifStatus: x.notif_status, jobStatus: x.job_status })) });
  });
  r.get("/events/:id", (req, res) => {
    const d = getEventDetail(ctx, String(req.params.id));
    if (!d) throw new UserError("Event not found", 404);
    res.json(d);
  });
  r.post("/notifications/:id/retry", (req, res) => {
    if (!svc.notifier.retry(num(req.params.id))) throw new UserError("Notification cannot be retried", 409);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------------ webhooks + templates
  const maskHook = (h: any) => ({ id: h.id, name: h.name, username: h.username, avatarUrl: h.avatar_url, urlHint: "https://discord.com/api/webhooks/..." + ctx.box.decrypt(h.url_enc).slice(-6), createdAt: h.created_at });
  r.get("/webhooks", (_req, res) => res.json(db.all("SELECT * FROM webhooks ORDER BY name").map(maskHook)));
  r.post("/webhooks", async (req, res) => {
    const b = z.object({ name: z.string().trim().min(1).max(80), url: z.string(), username: z.string().max(80).nullish(), avatarUrl: z.string().url().nullish() }).parse(req.body);
    await validateWebhookUrl(b.url, ctx.settings.get().notifications.allowCustomWebhookHosts);
    if (db.get("SELECT 1 FROM webhooks WHERE name=?", b.name)) throw new UserError("A webhook with this name exists", 409);
    const id = db.run("INSERT INTO webhooks(name,url_enc,username,avatar_url,created_at) VALUES(?,?,?,?,?)", b.name, ctx.box.encrypt(b.url), b.username ?? null, b.avatarUrl ?? null, nowIso()).lastId;
    if (ctx.settings.get().notifications.defaultWebhookId == null) ctx.settings.update({ notifications: { defaultWebhookId: id } });
    res.status(201).json(maskHook(db.get("SELECT * FROM webhooks WHERE id=?", id)));
  });
  r.patch("/webhooks/:id", async (req, res) => {
    const id = num(req.params.id);
    const cur = db.get("SELECT * FROM webhooks WHERE id=?", id);
    if (!cur) throw new UserError("Webhook not found", 404);
    const b = z.object({ name: z.string().trim().min(1).max(80).optional(), url: z.string().optional(), username: z.string().max(80).nullish(), avatarUrl: z.string().url().nullish() }).parse(req.body);
    if (b.url) await validateWebhookUrl(b.url, ctx.settings.get().notifications.allowCustomWebhookHosts);
    db.run("UPDATE webhooks SET name=?, url_enc=?, username=?, avatar_url=? WHERE id=?", b.name ?? cur.name, b.url ? ctx.box.encrypt(b.url) : cur.url_enc,
      b.username === undefined ? cur.username : b.username, b.avatarUrl === undefined ? cur.avatar_url : b.avatarUrl, id);
    res.json(maskHook(db.get("SELECT * FROM webhooks WHERE id=?", id)));
  });
  r.delete("/webhooks/:id", (req, res) => {
    const id = num(req.params.id);
    db.tx(() => {
      db.run("DELETE FROM webhooks WHERE id=?", id);
      if (ctx.settings.get().notifications.defaultWebhookId === id) ctx.settings.update({ notifications: { defaultWebhookId: null } });
    });
    res.json({ ok: true });
  });
  r.post("/webhooks/:id/test", async (req, res) => {
    const hook = db.get("SELECT * FROM webhooks WHERE id=?", num(req.params.id));
    if (!hook) throw new UserError("Webhook not found", 404);
    const notify = NotifySchema.parse({ ...(req.body?.notify ?? {}) });
    const url = ctx.box.decrypt(hook.url_enc);
    await validateWebhookUrl(url, ctx.settings.get().notifications.allowCustomWebhookHosts);
    const ev = sampleEvent("ManifestHound test", 480);
    const payload = buildPayload(ctx, ev, { notify }, hook as any, `**ManifestHound test notification**\n` + (req.body?.template ? render(String(req.body.template), buildTemplateContext(ctx, ev, { notify })).text : "Webhook is working."));
    res.json(await sendWebhook(url, payload, 15000));
  });
  r.post("/templates/preview", (req, res) => {
    const b = z.object({ template: z.string().max(4000).optional(), watchId: z.number().int().optional(), notify: z.any().optional(), sample: z.object({ gameName: z.string().optional(), appId: z.number().optional() }).optional() }).parse(req.body ?? {});
    const wRow = b.watchId ? db.get("SELECT * FROM watches WHERE id=?", b.watchId) : null;
    const notify = NotifySchema.parse({ ...(wRow ? rowToWatch(wRow).notify : {}), ...(b.notify ?? {}) });
    const ev = sampleEvent(b.sample?.gameName ?? wRow?.name ?? "Example Game", b.sample?.appId ?? wRow?.app_id ?? 480);
    const tpl = b.template ?? notify.template ?? ctx.settings.get().notifications.template;
    const out = render(tpl, buildTemplateContext(ctx, ev, { notify }));
    res.json({ text: out.text, warnings: out.warnings, length: out.text.length, payload: buildPayload(ctx, ev, { notify }, { username: null, avatar_url: null }, out.text) });
  });
  r.get("/templates/help", (_req, res) => res.json(TEMPLATE_HELP));

  // ------------------------------------------------------------------ jobs
  const maskJob = (row: any) => {
    const d = rowToJobDef(ctx, row);
    const last = db.get("SELECT status, finished_at FROM job_runs WHERE job_id=? ORDER BY id DESC LIMIT 1", d.id);
    return { ...d, secrets: undefined, secretsSet: Object.keys(d.secrets), lastStatus: last?.status ?? null, lastFinishedAt: last?.finished_at ?? null };
  };
  const JobBody = z.object({
    watchId: z.number().int().nullable().default(null), name: z.string().trim().min(1).max(100), description: z.string().max(500).nullish(),
    type: z.enum(JOB_TYPES), enabled: z.boolean().default(true), ord: z.number().int().min(0).max(1000).default(10),
    depotFilter: z.array(z.string().regex(/^\d+$/)).default([]), timeoutSec: z.number().int().min(5).max(86400 * 2).default(1800),
    maxRetries: z.number().int().min(0).max(10).default(1), stopOnFail: z.boolean().default(false), outputDir: z.string().nullish(),
    config: z.record(z.string(), z.any()).default({}), secrets: z.record(z.string(), z.string()).optional(),
  });
  const ALLOWED_SECRETS: Record<JobType, string[]> = { depotdownload: [], collect: [], report: [], archive: [], decompile: [], git: [] };
  const checkJob = (b: z.infer<typeof JobBody>) => {
    const cfg = validateConfig(b.type, b.config);
    const roots = ctx.settings.roots(), work = ctx.settings.workDir();
    if (b.outputDir) resolveInsideRoots(b.outputDir, roots, work);
    if (cfg.selection?.root) resolveInsideRoots(cfg.selection.root, roots, work);
    if (b.type === "git" && cfg.repoPath) resolveInsideRoots(cfg.repoPath, roots, work);
    if (b.watchId != null && !svc.watches.get(b.watchId)) throw new UserError("Unknown game");
    for (const k of Object.keys(b.secrets ?? {})) if (!ALLOWED_SECRETS[b.type].includes(k)) throw new UserError(`Unknown secret "${k}" for ${b.type} jobs`);
    return cfg;
  };
  r.get("/jobs", (_req, res) => res.json(db.all("SELECT * FROM job_defs ORDER BY ord, id").map(maskJob)));
  const insertJob = (b: z.infer<typeof JobBody>) => {
    const cfg = checkJob(b);
    const sec = b.secrets && Object.keys(b.secrets).length ? ctx.box.encrypt(JSON.stringify(b.secrets)) : null;
    const id = db.run(`INSERT INTO job_defs(watch_id,name,description,type,enabled,ord,depot_filter,timeout_sec,max_retries,stop_on_fail,output_dir,config_json,secrets_enc,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, b.watchId, b.name, b.description ?? null, b.type, b.enabled ? 1 : 0, b.ord, JSON.stringify(b.depotFilter), b.timeoutSec,
      b.maxRetries, b.stopOnFail ? 1 : 0, b.outputDir ?? null, JSON.stringify(cfg), sec, nowIso(), nowIso()).lastId;
    return id;
  };
  r.post("/jobs", (req, res) => {
    const id = insertJob(JobBody.parse(req.body));
    res.status(201).json(maskJob(db.get("SELECT * FROM job_defs WHERE id=?", id)));
  });

  // One-click "Archive" setup: download (DepotDownloader) -> decompile (ILSpy) -> commit and push (Git), chained by source job.
  const ArchiveBody = z.object({
    watchId: z.number().int(),
    os: z.enum(["", "windows", "linux", "macos"]).default(""),
    steamUsername: z.string().regex(/^[\w.-]*$/).default(""),
    downloadFiles: z.array(z.string().min(1)).default(["**/*_Data/Managed/*.dll"]),
    assemblies: z.array(z.string().min(1)).min(1).default(["*_Data/Managed/*.dll"]),
    excludeAssemblies: z.array(z.string().min(1)).default([]),
    languageVersion: z.string().regex(/^(CSharp\d+(_\d+)?|Preview|Latest)$/).default("Latest"),
    repoPath: z.string().default(""),
    branch: z.string().regex(/^[\w][\w./-]*$/).default("main"),
    remoteUrl: z.string().default(""),
    push: z.boolean().default(false),
    credentialId: z.number().int().nullable().default(null),
  });
  r.post("/presets/archive", (req, res) => {
    const b = ArchiveBody.parse(req.body);
    const w = svc.watches.get(b.watchId);
    if (!w) throw new UserError("Unknown game");
    const repoPath = b.repoPath.trim() || path.join(ctx.settings.workDir(), "repos", String(w.appId));
    if (b.push && !b.remoteUrl) throw new UserError("Push needs a remote URL");
    const tag = `${w.name}`;
    const common = { watchId: w.id, enabled: true, depotFilter: [], secrets: undefined, outputDir: null as string | null, description: "Created by the Archive preset" };
    const ids = db.tx(() => {
      const dl = insertJob({ ...common, name: `Archive 1: download ${tag}`, type: "depotdownload", ord: 10, timeoutSec: 6 * 3600, maxRetries: 2, stopOnFail: true,
        config: { os: b.os, username: b.steamUsername, files: b.downloadFiles } });
      const dc = insertJob({ ...common, name: `Archive 2: decompile ${tag}`, type: "decompile", ord: 20, timeoutSec: 3600, maxRetries: 1, stopOnFail: true,
        config: { selection: { sourceJobId: dl, exclude: b.excludeAssemblies }, assemblies: b.assemblies, languageVersion: b.languageVersion, onExisting: "overwrite", copyInputs: false } });
      const gt = insertJob({ ...common, name: `Archive 3: commit and push ${tag}`, type: "git", ord: 30, timeoutSec: 1800, maxRetries: 2, stopOnFail: false,
        config: { repoPath, branch: b.branch, remoteUrl: b.remoteUrl, push: b.push, credentialId: b.credentialId, sources: [{ sourceJobId: dc, path: "src", dest: "", mirror: true }] } });
      return { download: dl, decompile: dc, git: gt };
    });
    res.status(201).json({ ids, repoPath: path.relative(ctx.settings.workDir(), repoPath).split(path.sep).join("/") });
  });
  r.put("/jobs/:id", (req, res) => {
    const id = num(req.params.id);
    const cur = db.get("SELECT * FROM job_defs WHERE id=?", id);
    if (!cur) throw new UserError("Job not found", 404);
    const b = JobBody.parse(req.body);
    const cfg = checkJob(b);
    let secrets = rowToJobDef(ctx, cur).secrets;
    for (const [k, v] of Object.entries(b.secrets ?? {})) { if (v === "") delete secrets[k]; else secrets[k] = v; }
    const sec = Object.keys(secrets).length ? ctx.box.encrypt(JSON.stringify(secrets)) : null;
    db.run(`UPDATE job_defs SET watch_id=?,name=?,description=?,type=?,enabled=?,ord=?,depot_filter=?,timeout_sec=?,max_retries=?,stop_on_fail=?,output_dir=?,config_json=?,secrets_enc=?,updated_at=? WHERE id=?`,
      b.watchId, b.name, b.description ?? null, b.type, b.enabled ? 1 : 0, b.ord, JSON.stringify(b.depotFilter), b.timeoutSec, b.maxRetries, b.stopOnFail ? 1 : 0, b.outputDir ?? null, JSON.stringify(cfg), sec, nowIso(), id);
    res.json(maskJob(db.get("SELECT * FROM job_defs WHERE id=?", id)));
  });
  r.delete("/jobs/:id", (req, res) => {
    if (req.query.confirm !== "yes") throw new UserError("Confirmation required (?confirm=yes)");
    const id = num(req.params.id);
    db.tx(() => { db.run("DELETE FROM job_defs WHERE id=?", id); db.run("DELETE FROM file_snapshots WHERE job_id=?", id); db.run("UPDATE job_runs SET status='cancelled' WHERE job_id=? AND status='queued'", id); });
    res.json({ ok: true });
  });
  r.post("/jobs/:id/run", (req, res) => res.status(202).json({ runId: svc.jobs.enqueueManual(num(req.params.id), req.body?.eventId) }));
  r.get("/job-runs", (req, res) => {
    const st = String(req.query.status ?? "");
    const rows = db.all(`SELECT id,event_id,job_id,job_name,status,attempts,manual,started_at,finished_at,error FROM job_runs ${st ? "WHERE status=?" : ""} ORDER BY id DESC LIMIT 100`, ...(st ? [st] : []));
    res.json(rows);
  });
  r.get("/job-runs/:id", (req, res) => {
    const row = db.get("SELECT * FROM job_runs WHERE id=?", num(req.params.id));
    if (!row) throw new UserError("Run not found", 404);
    res.json({ ...row, result: parseJson(row.result_json, null), result_json: undefined });
  });
  r.post("/job-runs/:id/rerun", (req, res) => {
    const row = db.get("SELECT * FROM job_runs WHERE id=?", num(req.params.id));
    if (!row) throw new UserError("Run not found", 404);
    res.status(202).json({ runId: svc.jobs.enqueueManual(row.job_id, row.event_id) });
  });
  r.post("/job-runs/:id/cancel", (req, res) => res.json({ ok: svc.jobs.cancel(num(req.params.id)) }));

  // ------------------------------------------------------------------ upload destinations
  const maskDest = (d: any) => ({ id: d.id, name: d.name, type: d.type, config: parseJson(d.config_json, {}), allowPrivate: !!d.allow_private,
    secretsSet: d.secrets_enc ? Object.keys(JSON.parse(ctx.box.decrypt(d.secrets_enc))) : [] });
  const DestBody = z.object({ name: z.string().trim().min(1).max(80), type: z.enum(DEST_TYPES as [DestType, ...DestType[]]), config: z.record(z.string(), z.any()).default({}),
    secrets: z.record(z.string(), z.string()).optional(), allowPrivate: z.boolean().default(false) });
  r.get("/destinations", (_req, res) => res.json(db.all("SELECT * FROM destinations ORDER BY name").map(maskDest)));
  r.post("/destinations", (req, res) => {
    const b = DestBody.parse(req.body);
    const cfg = validateDestinationConfig(b.type, b.config);
    const sec = Object.fromEntries(Object.entries(b.secrets ?? {}).filter(([k, v]) => SECRET_FIELDS[b.type].includes(k) && v));
    const id = db.run("INSERT INTO destinations(name,type,config_json,secrets_enc,allow_private,created_at) VALUES(?,?,?,?,?,?)", b.name, b.type, JSON.stringify(cfg),
      Object.keys(sec).length ? ctx.box.encrypt(JSON.stringify(sec)) : null, b.allowPrivate ? 1 : 0, nowIso()).lastId;
    res.status(201).json(maskDest(db.get("SELECT * FROM destinations WHERE id=?", id)));
  });
  r.put("/destinations/:id", (req, res) => {
    const id = num(req.params.id);
    const cur = db.get("SELECT * FROM destinations WHERE id=?", id);
    if (!cur) throw new UserError("Destination not found", 404);
    const b = DestBody.parse(req.body);
    if (b.type !== cur.type) throw new UserError("Destination type cannot change; create a new destination");
    const cfg = validateDestinationConfig(b.type, b.config);
    const sec: Record<string, string> = cur.secrets_enc ? JSON.parse(ctx.box.decrypt(cur.secrets_enc)) : {};
    for (const [k, v] of Object.entries(b.secrets ?? {})) { if (!SECRET_FIELDS[b.type].includes(k)) continue; if (v === "") delete sec[k]; else sec[k] = v; }
    db.run("UPDATE destinations SET name=?, config_json=?, secrets_enc=?, allow_private=? WHERE id=?", b.name, JSON.stringify(cfg), Object.keys(sec).length ? ctx.box.encrypt(JSON.stringify(sec)) : null, b.allowPrivate ? 1 : 0, id);
    res.json(maskDest(db.get("SELECT * FROM destinations WHERE id=?", id)));
  });
  r.delete("/destinations/:id", (req, res) => { db.run("DELETE FROM destinations WHERE id=?", num(req.params.id)); res.json({ ok: true }); });
  r.post("/destinations/:id/test", async (req, res) => {
    const row = db.get("SELECT * FROM destinations WHERE id=?", num(req.params.id)) as DestRow | undefined;
    if (!row) throw new UserError("Destination not found", 404);
    const tmpDir = path.join(ctx.settings.workDir(), ".tmp");
    await fsp.mkdir(tmpDir, { recursive: true });
    const f = path.join(tmpDir, "manifesthound-test.txt");
    await fsp.writeFile(f, `ManifestHound upload test ${nowIso()}\n`);
    try { res.json({ ok: true, ...(await createProvider(ctx, row).upload(f, "manifesthound-test.txt", { signal: AbortSignal.timeout(60_000), log: () => {} })) }); }
    catch (e) { res.json({ ok: false, error: cleanOutput((e as Error).message) }); }
    finally { await fsp.rm(f, { force: true }); }
  });

  // ------------------------------------------------------------------ steam accounts
  const sa = () => { if (!svc.steamAuth) throw new UserError("Steam is not enabled in this instance", 503); return svc.steamAuth; };
  r.get("/accounts", (_req, res) => {
    svc.steamAuth?.refreshStatuses();
    res.json(db.all("SELECT id,name,username,steam_id,status,status_detail,last_validated_at,created_at FROM accounts ORDER BY name"));
  });
  r.post("/accounts/login", async (req, res) => res.json(await sa().start(req.body ?? {})));
  r.post("/accounts/login/:pid/code", async (req, res) => res.json(await sa().submitCode(String(req.params.pid), String(req.body?.code ?? ""))));
  r.get("/accounts/login/:pid", (req, res) => res.json(sa().status(String(req.params.pid))));
  r.delete("/accounts/login/:pid", (req, res) => { sa().cancel(String(req.params.pid)); res.json({ ok: true }); });
  r.delete("/accounts/:id", (req, res) => {
    if (req.query.confirm !== "yes") throw new UserError("Confirmation required (?confirm=yes)");
    const id = num(req.params.id);
    svc.steam?.drop(id);
    db.tx(() => { db.run("UPDATE watches SET account_id=NULL WHERE account_id=?", id); db.run("DELETE FROM accounts WHERE id=?", id); });
    res.json({ ok: true });
  });

  // ------------------------------------------------------------------ settings / network / security
  r.get("/settings", (_req, res) => res.json({
    settings: ctx.settings.get(),
    paths: { dataDir: "<data>", workDir: ctx.settings.get().paths.workDir || "<data>/work" },
    network: { host: ctx.boot.host, port: ctx.boot.port, allowRemote: ctx.boot.allowRemote },
    passwordFromEnv: !!ctx.boot.adminPassword,
  }));
  r.put("/settings", (req, res) => {
    const s = ctx.settings.update(req.body ?? {});
    ctx.logger.level = s.logging.level; ctx.logger.retentionDays = s.logging.retentionDays;
    res.json(s);
  });
  r.put("/network", (req, res) => {
    const b = z.object({ host: z.string().min(1), port: z.number().int().min(1).max(65535), allowRemote: z.boolean().default(false) }).parse(req.body);
    if (!["127.0.0.1", "::1", "localhost"].includes(b.host) && !b.allowRemote) throw new UserError("Binding to a non-loopback address requires allowRemote=true (see docs/SECURITY.md)");
    writeNetworkConfig(ctx.boot.configFile, b);
    res.json({ ok: true, restartRequired: true });
  });
  r.post("/auth/password", (req, res) => { auth.changePassword(String(req.body?.current ?? ""), String(req.body?.next ?? "")); res.json({ ok: true, note: "All sessions were signed out." }); });

  // ------------------------------------------------------------------ git browser
  const gitJobs = () => db.all("SELECT * FROM job_defs WHERE type='git'").map((row) => rowToJobDef(ctx, row));
  r.get("/git/repos", async (_req, res) => {
    const out = [];
    for (const j of gitJobs()) {
      const cfg = j.config;
      const info: any = { jobId: j.id, jobName: j.name, repoPath: cfg.repoPath, branch: cfg.branch, remote: cfg.remoteUrl ? cfg.remoteName : null, push: cfg.push, exists: false };
      try {
        const repo = resolveInsideRoots(cfg.repoPath, ctx.settings.roots(), ctx.settings.workDir());
        if (fs.existsSync(path.join(repo, ".git"))) {
          info.exists = true;
          const g = (args: string[]) => runProc(ctx.settings.get().git.gitPath, args, { cwd: repo, timeoutMs: 15000, env: { GIT_TERMINAL_PROMPT: "0" } });
          const ahead = await g(["rev-list", "--count", "@{u}..HEAD"]);
          info.ahead = ahead.code === 0 ? Number(ahead.stdout.trim()) : null;
          info.upstream = ahead.code === 0;
          info.head = (await g(["rev-parse", "--short", "HEAD"])).stdout.trim() || null;
        }
      } catch (e) { info.error = (e as Error).message; }
      out.push(info);
    }
    res.json(out);
  });
  r.get("/git/commits", async (req, res) => {
    const j = gitJobs().find((x) => x.id === num(req.query.jobId, "jobId"));
    if (!j) throw new UserError("Git job not found", 404);
    const repo = resolveInsideRoots(j.config.repoPath, ctx.settings.roots(), ctx.settings.workDir());
    if (!fs.existsSync(path.join(repo, ".git"))) return void res.json([]);
    const r2 = await runProc(ctx.settings.get().git.gitPath, ["log", "-n", "50", "--format=%H%x1f%an%x1f%aI%x1f%s%x1f%(trailers:key=ManifestHound-Event,valueonly,separator=%x2c)%x1e"], { cwd: repo, timeoutMs: 15000 });
    const unpushed = new Set((await runProc(ctx.settings.get().git.gitPath, ["rev-list", "@{u}..HEAD"], { cwd: repo, timeoutMs: 15000 })).stdout.split(/\s+/).filter(Boolean));
    const hasUp = (await runProc(ctx.settings.get().git.gitPath, ["rev-parse", "@{u}"], { cwd: repo, timeoutMs: 15000 })).code === 0;
    res.json(r2.stdout.split("\x1e").map((s) => s.trim()).filter(Boolean).map((l) => {
      const [sha, author, date, subject, ev] = l.split("\x1f");
      return { sha, author, date, subject, eventId: ev?.trim() || null, pushed: hasUp ? !unpushed.has(sha) : null };
    }));
  });

  // ------------------------------------------------------------------ git credentials (PAT or account password)
  const maskCred = (c: any) => ({ id: c.id, name: c.name, kind: c.kind, username: c.username, hasSecret: true });
  const CredBody = z.object({ name: z.string().trim().min(1).max(80), kind: z.enum(["pat", "password"]), username: z.string().trim().max(200).default(""), secret: z.string().max(4000).optional() });
  r.get("/git/credentials", (_req, res) => res.json(db.all("SELECT * FROM git_credentials ORDER BY name").map(maskCred)));
  r.post("/git/credentials", (req, res) => {
    const b = CredBody.parse(req.body);
    if (!b.secret) throw new UserError("A token or password is required");
    if (b.kind === "password" && !b.username) throw new UserError("A username is required for account-password credentials");
    if (db.get("SELECT 1 FROM git_credentials WHERE name=?", b.name)) throw new UserError("A credential with this name exists", 409);
    const id = db.run("INSERT INTO git_credentials(name,kind,username,secret_enc,created_at) VALUES(?,?,?,?,?)", b.name, b.kind, b.username, ctx.box.encrypt(b.secret), nowIso()).lastId;
    res.status(201).json(maskCred(db.get("SELECT * FROM git_credentials WHERE id=?", id)));
  });
  r.put("/git/credentials/:id", (req, res) => {
    const id = num(req.params.id);
    const cur = db.get("SELECT * FROM git_credentials WHERE id=?", id);
    if (!cur) throw new UserError("Credential not found", 404);
    const b = CredBody.parse(req.body);
    if (b.kind === "password" && !b.username) throw new UserError("A username is required for account-password credentials");
    db.run("UPDATE git_credentials SET name=?, kind=?, username=?, secret_enc=? WHERE id=?", b.name, b.kind, b.username, b.secret ? ctx.box.encrypt(b.secret) : cur.secret_enc, id);
    res.json(maskCred(db.get("SELECT * FROM git_credentials WHERE id=?", id)));
  });
  r.delete("/git/credentials/:id", (req, res) => {
    const id = num(req.params.id);
    const users = gitJobs().filter((j) => j.config.credentialId === id).map((j) => j.name);
    if (users.length) throw new UserError(`Still used by git job(s): ${users.join(", ")}`, 409);
    db.run("DELETE FROM git_credentials WHERE id=?", id);
    res.json({ ok: true });
  });
  r.post("/git/credentials/:id/test", async (req, res) => {
    const cred = loadGitCredential(ctx, num(req.params.id));
    if (!cred) throw new UserError("Credential not found", 404);
    const b = z.object({ url: z.string(), allowPrivate: z.boolean().default(false) }).parse(req.body);
    await assertSafeUrl(b.url, { protocols: ["https:"], allowPrivate: b.allowPrivate });
    const x = await runProc(ctx.settings.get().git.gitPath, ["ls-remote", "--heads", b.url], { env: { GIT_TERMINAL_PROMPT: "0", ...gitAuthEnv(b.url, cred) }, timeoutMs: 30000 });
    res.json(x.missing ? { ok: false, error: "git executable not found" } : x.code === 0 ? { ok: true, branches: x.stdout.split(String.fromCharCode(10)).filter(Boolean).length } : { ok: false, error: cleanOutput(x.stderr || x.stdout, 400) });
  });

  // ------------------------------------------------------------------ diagnostics
  r.get("/diagnostics", async (_req, res) => res.json(await diagnostics()));
  r.get("/logs", (req, res) => res.json(ctx.logger.recent(Number(req.query.n) || 200, (req.query.level as any) || "debug")));
  r.get("/diagnostics/export", async (_req, res) => {
    const yazl = require("yazl");
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify(redact(await diagnostics()), null, 2)), "diagnostics.json");
    zip.addBuffer(Buffer.from(JSON.stringify(redact(ctx.settings.get()), null, 2)), "settings.json");
    if (ctx.logger.dir) {
      for (const f of fs.readdirSync(ctx.logger.dir).filter((x) => x.endsWith(".log")).slice(-7)) {
        // Lines were redacted when written; redact again defensively.
        const { redactString } = await import("../util/redact.js");
        zip.addBuffer(Buffer.from(redactString(fs.readFileSync(path.join(ctx.logger.dir, f), "utf8"))), `logs/${f}`);
      }
    }
    zip.end();
    res.set({ "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="manifesthound-diagnostics-${nowIso().replace(/[:.]/g, "-")}.zip"` });
    zip.outputStream.pipe(res);
  });

  async function diagnostics() {
    const probe = async (cmd: string, args: string[]) => {
      const x = await runProc(cmd, args, { timeoutMs: 15000, env: { DOTNET_ROLL_FORWARD: "Major" } }).catch((e) => ({ code: -1, stdout: "", stderr: String(e), missing: false }));
      return x.missing ? { ok: false, detail: "not found" } : { ok: x.code === 0, detail: cleanOutput(x.stdout || x.stderr, 200).split(/\r?\n/)[0] };
    };
    const s = ctx.settings.get();
    const dbFile = path.join(ctx.boot.dataDir, "manifesthound.db");
    return {
      app: { version: "1.0.0", node: process.version, platform: `${os.platform()} ${os.release()}`, pid: process.pid, uptimeSec: Math.round((Date.now() - svc.startedAt) / 1000) },
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      paths: { dataDir: ctx.boot.dataDir, workDir: ctx.settings.workDir(), db: dbFile, dbSizeKb: fs.existsSync(dbFile) ? Math.round(fs.statSync(dbFile).size / 1024) : 0 },
      schemaVersion: db.get("SELECT MAX(version) v FROM schema_migrations")?.v,
      queues: {
        jobsQueued: db.get("SELECT COUNT(*) c FROM job_runs WHERE status='queued'")!.c, jobsRunning: svc.jobs.activeRunIds().length,
        notificationsPending: db.get("SELECT COUNT(*) c FROM notifications WHERE status IN ('pending','sending')")!.c,
      },
      counts: { watches: db.get("SELECT COUNT(*) c FROM watches")!.c, events: db.get("SELECT COUNT(*) c FROM events")!.c },
      tools: { git: await probe(s.git.gitPath, ["--version"]), ilspycmd: await probe(resolveTool(s.tools.ilspyCmdPath), ["--version"]) },
      accounts: db.all("SELECT name,status,status_detail,last_validated_at FROM accounts"),
      watchErrors: db.all("SELECT app_id,name,last_error,consecutive_failures,last_check_at FROM watches WHERE last_error IS NOT NULL"),
      recentLogs: ctx.logger.recent(100, "warn"),
    };
  }

  return r;
}
