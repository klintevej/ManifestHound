import type { AppContext } from "../context.js";
import { rowToEvent, type EventRecord } from "../events.js";
import { rowToWatch } from "../watches.js";
import { buildPayload, sendWebhook, validateWebhookUrl, type SendResult } from "./discord.js";
import { backoffMs, nowIso } from "../util/misc.js";

export type Sender = (url: string, payload: unknown) => Promise<SendResult>;

/** Delivers queued notifications with retry/backoff. Rows survive restarts; interrupted sends are re-queued (at-least-once). */
export class NotificationWorker {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private log;
  constructor(private ctx: AppContext, private send: Sender = (u, p) => sendWebhook(u, p)) {
    this.log = ctx.logger.child("notify");
  }

  start() {
    this.ctx.db.run("UPDATE notifications SET status='pending' WHERE status='sending'");
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref?.();
    this.ctx.bus.on("event:created", () => void this.tick());
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  async tick(now = new Date()) {
    if (this.busy) return;
    this.busy = true;
    try {
      const due = this.ctx.db.all("SELECT id FROM notifications WHERE status='pending' AND next_attempt_at<=? ORDER BY id LIMIT 10", now.toISOString());
      for (const n of due) await this.deliver(n.id);
    } finally { this.busy = false; }
  }

  async deliver(id: number): Promise<void> {
    const db = this.ctx.db;
    const claimed = db.run("UPDATE notifications SET status='sending', attempts=attempts+1 WHERE id=? AND status='pending'", id);
    if (!claimed.changes) return;
    const n = db.get("SELECT * FROM notifications WHERE id=?", id)!;
    const fail = (error: string, permanent: boolean, delayMs?: number, status?: number) => {
      const max = this.ctx.settings.get().notifications.maxAttempts;
      const giveUp = permanent || n.attempts >= max;
      db.run("UPDATE notifications SET status=?, last_error=?, http_status=?, next_attempt_at=? WHERE id=?",
        giveUp ? "failed" : "pending", error, status ?? null, giveUp ? null : new Date(Date.now() + (delayMs ?? backoffMs(n.attempts, 2000, 10 * 60_000))).toISOString(), id);
      this.log[giveUp ? "error" : "warn"]("Notification delivery failed", { id, attempt: n.attempts, error, giveUp });
      this.ctx.bus.emit("notification:updated", id);
    };
    try {
      const evRow = db.get("SELECT * FROM events WHERE id=?", n.event_id);
      const hook = n.webhook_id != null ? db.get("SELECT * FROM webhooks WHERE id=?", n.webhook_id) : null;
      if (!evRow || !hook) return fail("Event or webhook no longer exists", true);
      const ev: EventRecord = rowToEvent(evRow);
      const wRow = ev.watchId != null ? db.get("SELECT * FROM watches WHERE id=?", ev.watchId) : null;
      const watch = wRow ? rowToWatch(wRow) : { notify: rowToWatch({ notify_json: "{}", depot_ids: "[]", enabled: 1 }).notify };
      const url = this.ctx.box.decrypt(hook.url_enc);
      await validateWebhookUrl(url, this.ctx.settings.get().notifications.allowCustomWebhookHosts);
      const r = await this.send(url, buildPayload(this.ctx, ev, watch, hook as any));
      if (r.ok) {
        db.run("UPDATE notifications SET status='delivered', delivered_at=?, http_status=?, last_error=NULL, next_attempt_at=NULL WHERE id=?", nowIso(), r.status ?? null, id);
        this.log.info("Notification delivered", { id, eventId: n.event_id });
        this.ctx.bus.emit("notification:updated", id);
      } else fail(r.error ?? "Unknown error", !!r.permanent, r.retryAfterMs, r.status);
    } catch (e) {
      fail((e as Error).message, false);
    }
  }

  /** Manual retry from the UI: resets a failed/suppressed row. */
  retry(id: number): boolean {
    const r = this.ctx.db.run("UPDATE notifications SET status='pending', attempts=0, next_attempt_at=?, last_error=NULL WHERE id=? AND status IN ('failed','pending') AND webhook_id IS NOT NULL", nowIso(), id);
    if (r.changes) void this.tick();
    return r.changes > 0;
  }
}
