import { z } from "zod";
import type { AppContext } from "./context.js";
import { UserError, nowIso, parseJson } from "./util/misc.js";
import { iconUrlFor } from "./steam/store.js";

export const NotifySchema = z.object({
  enabled: z.boolean().default(true),
  webhookId: z.number().int().nullable().default(null),   // null => global default webhook
  template: z.string().max(4000).nullable().default(null), // null => global default template
  username: z.string().max(80).nullable().default(null),
  avatarUrl: z.string().url().nullable().default(null),
  mentions: z.object({
    users: z.array(z.string().regex(/^\d{5,25}$/)).default([]),
    roles: z.array(z.string().regex(/^\d{5,25}$/)).default([]),
    everyone: z.boolean().default(false),
  }).prefault({}),
  include: z.object({           // used for embed fields
    gameName: z.boolean().default(true), appId: z.boolean().default(true), buildIds: z.boolean().default(true),
    depotIds: z.boolean().default(true), manifestIds: z.boolean().default(true),
    timestamps: z.boolean().default(true), links: z.boolean().default(true),
  }).prefault({}),
  suppressKinds: z.array(z.enum(["update", "rollback", "initial"])).default([]),
  timezone: z.string().nullable().default(null),
  timeMode: z.enum(["utc", "local"]).nullable().default(null),
  useEmbed: z.boolean().nullable().default(null),
  manifestFormat: z.string().max(200).nullable().default(null),
});
export type NotifyConfig = z.infer<typeof NotifySchema>;

export const WatchInputSchema = z.object({
  appId: z.coerce.number().int().positive().max(2_147_483_647),
  name: z.string().trim().max(200).optional(),
  followMode: z.enum(["build", "depots", "all"]).default("build"),
  depotIds: z.array(z.string().regex(/^\d+$/)).max(500).default([]),
  branch: z.string().trim().min(1).max(64).regex(/^[\w.\- ]+$/).default("public"),
  intervalSec: z.coerce.number().int().min(1).max(86400).optional(),
  enabled: z.boolean().default(true),
  baselineFirst: z.boolean().optional(),
  accountId: z.number().int().nullable().default(null),
  notify: NotifySchema.prefault({}),
});
export type WatchInput = z.infer<typeof WatchInputSchema>;

export interface Watch {
  id: number; appId: number; name: string; iconUrl: string | null; followMode: "build" | "depots" | "all"; depotIds: string[];
  branch: string; intervalSec: number; enabled: boolean; baselineFirst: boolean; accountId: number | null; status: string;
  lastCheckAt: string | null; lastSuccessAt: string | null; lastUpdateAt: string | null; lastError: string | null;
  consecutiveFailures: number; notify: NotifyConfig; createdAt: string;
}

export function rowToWatch(r: any): Watch {
  return {
    id: r.id, appId: r.app_id, name: r.name, iconUrl: r.icon_url, followMode: r.follow_mode, depotIds: parseJson(r.depot_ids, []),
    branch: r.branch, intervalSec: r.interval_sec, enabled: !!r.enabled, baselineFirst: !!r.baseline_first, accountId: r.account_id,
    status: r.enabled ? r.status : "paused", lastCheckAt: r.last_check_at, lastSuccessAt: r.last_success_at, lastUpdateAt: r.last_update_at,
    lastError: r.last_error, consecutiveFailures: r.consecutive_failures, notify: NotifySchema.parse(parseJson(r.notify_json, {})), createdAt: r.created_at,
  };
}

export class Watches {
  constructor(private ctx: AppContext) {}

  private validate(w: WatchInput) {
    if (w.followMode === "depots" && !w.depotIds.length) throw new UserError("Follow mode 'depots' requires at least one depot ID");
    const min = this.ctx.settings.get().polling.minIntervalSec;
    if (w.intervalSec !== undefined && w.intervalSec < min) throw new UserError(`Polling interval must be at least ${min}s (see Settings > Polling)`);
    if (w.accountId != null && !this.ctx.db.get("SELECT 1 FROM accounts WHERE id=?", w.accountId)) throw new UserError("Unknown account");
    if (w.notify.webhookId != null && !this.ctx.db.get("SELECT 1 FROM webhooks WHERE id=?", w.notify.webhookId)) throw new UserError("Unknown webhook");
  }

  list(): Watch[] { return this.ctx.db.all("SELECT * FROM watches ORDER BY name COLLATE NOCASE").map(rowToWatch); }
  get(id: number): Watch | null { const r = this.ctx.db.get("SELECT * FROM watches WHERE id=?", id); return r ? rowToWatch(r) : null; }

  create(input: unknown, resolvedName?: string | null): Watch {
    const p = WatchInputSchema.safeParse(input);
    if (!p.success) throw new UserError(p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const w = p.data;
    this.validate(w);
    const s = this.ctx.settings.get().polling;
    const dupe = this.ctx.db.get("SELECT id FROM watches WHERE app_id=? AND branch=? AND COALESCE(account_id,0)=COALESCE(?,0)", w.appId, w.branch, w.accountId);
    if (dupe) throw new UserError(`App ${w.appId} (${w.branch}) is already monitored with this account`, 409);
    const now = nowIso();
    const id = this.ctx.db.run(
      `INSERT INTO watches(app_id,name,icon_url,follow_mode,depot_ids,branch,interval_sec,enabled,baseline_first,account_id,notify_json,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      w.appId, w.name || resolvedName || `App ${w.appId}`, iconUrlFor(w.appId), w.followMode, JSON.stringify(w.depotIds), w.branch,
      w.intervalSec ?? s.defaultIntervalSec, w.enabled ? 1 : 0, (w.baselineFirst ?? s.baselineOnFirstCheck) ? 1 : 0, w.accountId,
      JSON.stringify(w.notify), now, now,
    ).lastId;
    this.ctx.bus.emit("watch:updated", id);
    return this.get(id)!;
  }

  update(id: number, patch: any): Watch {
    const cur = this.get(id);
    if (!cur) throw new UserError("Watch not found", 404);
    const merged = WatchInputSchema.safeParse({ ...cur, ...patch, notify: { ...cur.notify, ...(patch.notify ?? {}) } });
    if (!merged.success) throw new UserError(merged.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const w = merged.data;
    this.validate(w);
    this.ctx.db.run(
      `UPDATE watches SET name=?, follow_mode=?, depot_ids=?, branch=?, interval_sec=?, enabled=?, baseline_first=?, account_id=?, notify_json=?, updated_at=?,
       status=CASE WHEN ?=1 THEN CASE WHEN status='paused' THEN 'pending' ELSE status END ELSE 'paused' END WHERE id=?`,
      w.name || cur.name, w.followMode, JSON.stringify(w.depotIds), w.branch, w.intervalSec ?? cur.intervalSec, w.enabled ? 1 : 0,
      (w.baselineFirst ?? cur.baselineFirst) ? 1 : 0, w.accountId, JSON.stringify(w.notify), nowIso(), w.enabled ? 1 : 0, id,
    );
    // Changing branch invalidates stored state: the old branch's manifests are not comparable.
    if (w.branch !== cur.branch) this.ctx.db.run("DELETE FROM watch_state WHERE watch_id=?", id);
    this.ctx.bus.emit("watch:updated", id);
    return this.get(id)!;
  }

  remove(id: number, deleteHistory: boolean) {
    this.ctx.db.tx(() => {
      this.ctx.db.run("DELETE FROM watch_state WHERE watch_id=?", id);
      this.ctx.db.run("DELETE FROM job_defs WHERE watch_id=?", id);
      if (deleteHistory) {
        this.ctx.db.run("DELETE FROM job_runs WHERE event_id IN (SELECT id FROM events WHERE watch_id=?)", id);
        this.ctx.db.run("DELETE FROM notifications WHERE event_id IN (SELECT id FROM events WHERE watch_id=?)", id);
        this.ctx.db.run("DELETE FROM events WHERE watch_id=?", id);
      } else this.ctx.db.run("UPDATE events SET watch_id=NULL WHERE watch_id=?", id);
      this.ctx.db.run("DELETE FROM watches WHERE id=?", id);
    });
    this.ctx.bus.emit("watch:updated", id);
  }
}
