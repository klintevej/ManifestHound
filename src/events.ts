import { randomUUID } from "node:crypto";
import type { AppContext } from "./context.js";
import type { Detection, Changes } from "./monitor/detector.js";
import type { AppSnapshot } from "./steam/appinfo.js";
import type { Watch } from "./watches.js";
import { nowIso, parseJson, UserError } from "./util/misc.js";

export interface EventRecord {
  id: string; watchId: number | null; appId: number; gameName: string; kind: "baseline" | "initial" | "update" | "rollback" | "manual";
  detectedAt: string; updateTime: string | null; prevBuild: string | null; newBuild: string | null;
  changes: Changes & { branch?: string; source?: string };
}

export function rowToEvent(r: any): EventRecord {
  return {
    id: r.id, watchId: r.watch_id, appId: r.app_id, gameName: r.game_name, kind: r.kind, detectedAt: r.detected_at, updateTime: r.update_time,
    prevBuild: r.prev_build, newBuild: r.new_build, changes: parseJson(r.changes_json, { buildChange: null, depots: [], rollback: false, trigger: [], manifestIds: {} }),
  };
}

const EMPTY: Changes = { buildChange: null, depots: [], rollback: false, trigger: [], manifestIds: {} };

/**
 * Persist the new watch state AND the resulting event/notification/job rows in ONE transaction.
 * A crash can therefore never leave "state advanced but event lost" or an event without its queued work.
 * Returns the new event id, or null when nothing was recorded (unchanged, or duplicate dedupe key).
 */
export function recordDetection(ctx: AppContext, watch: Watch, snap: AppSnapshot, det: Detection, detectedAt = nowIso()): string | null {
  const db = ctx.db;
  return db.tx(() => {
    const prevBuildId: string | null = db.get("SELECT build_id FROM watch_state WHERE watch_id=?", watch.id)?.build_id ?? null;
    db.run(
      `INSERT INTO watch_state(watch_id,build_id,time_updated,depots_json,initialized_at,updated_at) VALUES(?,?,?,?,?,?)
       ON CONFLICT(watch_id) DO UPDATE SET build_id=excluded.build_id, time_updated=excluded.time_updated, depots_json=excluded.depots_json, updated_at=excluded.updated_at`,
      watch.id, det.next.buildId, det.next.timeUpdated, JSON.stringify(det.next.depots), detectedAt, detectedAt);
    if (det.type === "unchanged") return null;

    const changes = det.type === "baseline" ? EMPTY : det.changes;
    const prevBuild = prevBuildId;
    const id = randomUUID();
    const dedupe = det.type === "baseline" ? `baseline:${watch.id}:${detectedAt}` : det.type === "initial" ? `initial:${watch.id}:${det.next.buildId}:${snap.timeUpdated ?? ""}` : det.dedupeKey;
    const ins = db.run(
      `INSERT OR IGNORE INTO events(id,watch_id,app_id,game_name,kind,dedupe_key,detected_at,update_time,prev_build,new_build,changes_json,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, watch.id, watch.appId, watch.name, det.type, dedupe, detectedAt,
      snap.timeUpdated ? new Date(snap.timeUpdated * 1000).toISOString() : null,
      det.type === "baseline" ? null : prevBuild, det.next.buildId,
      JSON.stringify({ ...changes, branch: snap.branch, source: snap.source }), detectedAt);
    if (ins.changes === 0) return null; // duplicate event
    if (det.type === "baseline") return id;

    db.run("UPDATE watches SET last_update_at=? WHERE id=?", detectedAt, watch.id);

    // --- notifications
    const n = watch.notify;
    const webhookId = n.webhookId ?? ctx.settings.get().notifications.defaultWebhookId;
    const webhookOk = webhookId != null && db.get("SELECT 1 FROM webhooks WHERE id=?", webhookId);
    const suppress = !n.enabled ? "Notifications disabled for this game"
      : n.suppressKinds.includes(det.type as any) ? `Event kind "${det.type}" is suppressed for this game`
      : !webhookOk ? "No webhook configured" : null;
    db.run("INSERT INTO notifications(event_id,webhook_id,status,next_attempt_at,detail,created_at) VALUES(?,?,?,?,?,?)",
      id, webhookOk ? webhookId : null, suppress ? "suppressed" : "pending", suppress ? null : detectedAt, suppress, detectedAt);

    // --- post-update jobs
    const changed = new Set(changes.depots.map((d) => d.depotId));
    for (const j of db.all("SELECT * FROM job_defs WHERE enabled=1 AND (watch_id IS NULL OR watch_id=?) ORDER BY ord, id", watch.id)) {
      const filter: string[] = parseJson(j.depot_filter, []);
      if (filter.length && !filter.some((d) => changed.has(d))) continue;
      db.run("INSERT OR IGNORE INTO job_runs(event_id,job_id,job_name,ord,status,next_attempt_at,created_at) VALUES(?,?,?,?,?,?,?)",
        id, j.id, j.name, j.ord, "queued", detectedAt, detectedAt);
    }
    return id;
  });
}

export function getEventDetail(ctx: AppContext, id: string) {
  const r = ctx.db.get("SELECT * FROM events WHERE id=?", id);
  if (!r) return null;
  return {
    ...rowToEvent(r),
    notifications: ctx.db.all("SELECT id,webhook_id,status,attempts,next_attempt_at,last_error,http_status,delivered_at,detail,created_at FROM notifications WHERE event_id=? ORDER BY id", id),
    jobs: ctx.db.all("SELECT id,job_id,job_name,ord,status,attempts,manual,started_at,finished_at,log,error,result_json FROM job_runs WHERE event_id=? ORDER BY ord,id", id)
      .map((j) => ({ ...j, result: parseJson(j.result_json, null), result_json: undefined })),
  };
}

/**
 * "Pull now": record a manual event for the watch's CURRENT known build and queue every enabled job of that game,
 * in the normal order (download, decompile, push). No notification is sent. Idempotent per click via a fresh event id.
 */
export function createManualEvent(ctx: AppContext, watch: Watch): string {
  const st = ctx.db.get("SELECT * FROM watch_state WHERE watch_id=?", watch.id);
  if (!st) throw new UserError("No build recorded yet. Wait for the first successful check, then try again.", 409);
  const jobs = ctx.db.all("SELECT * FROM job_defs WHERE enabled=1 AND (watch_id IS NULL OR watch_id=?) ORDER BY ord, id", watch.id);
  if (!jobs.length) throw new UserError("This game has no enabled jobs. Create them with the Archive button on the Jobs page.", 409);
  const depots: Record<string, string> = parseJson(st.depots_json, {});
  const now = nowIso();
  const id = randomUUID();
  const changes: Changes = {
    buildChange: null, rollback: false, trigger: [], manifestIds: depots,
    depots: Object.entries(depots).map(([depotId, to]) => ({ depotId, change: "changed" as const, from: null, to, tracked: true })),
  };
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO events(id,watch_id,app_id,game_name,kind,dedupe_key,detected_at,update_time,prev_build,new_build,changes_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, watch.id, watch.appId, watch.name, "manual", "manual:" + id, now, st.time_updated ? new Date(st.time_updated * 1000).toISOString() : null, null, st.build_id,
      JSON.stringify({ ...changes, branch: watch.branch, source: "manual" }), now);
    for (const j of jobs) ctx.db.run("INSERT INTO job_runs(event_id,job_id,job_name,ord,status,next_attempt_at,created_at) VALUES(?,?,?,?,?,?,?)", id, j.id, j.name, j.ord, "queued", now, now);
  });
  ctx.bus.emit("event:created", id);
  return id;
}
