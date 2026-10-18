import type { AppContext } from "../context.js";
import type { ManifestSource } from "../steam/manager.js";
import { detect, type PersistedState } from "./detector.js";
import { recordDetection } from "../events.js";
import { rowToWatch, type Watch } from "../watches.js";
import { backoffMs, nowIso, parseJson } from "../util/misc.js";
import { redactString } from "../util/redact.js";
import { storeAppName } from "../steam/store.js";

export interface CheckResult { ok: boolean; eventId?: string | null; kind?: string; error?: string; skipped?: string }

/** Polls enabled watches on their own intervals with bounded concurrency and a per-watch in-flight lock. */
export class Monitor {
  private timer: NodeJS.Timeout | null = null;
  private inflight = new Set<number>();
  private log;
  private stopped = false;
  constructor(private ctx: AppContext, private source: ManifestSource, private tickMs = 1000) {
    this.log = ctx.logger.child("monitor");
  }

  start() {
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
    this.log.info("Monitor started");
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    const deadline = Date.now() + 10_000;
    while (this.inflight.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  }

  /** Effective delay before the next check, with backoff after consecutive failures. */
  static nextDelayMs(w: Pick<Watch, "intervalSec" | "consecutiveFailures">): number {
    const base = w.intervalSec * 1000;
    if (w.consecutiveFailures <= 0) return base;
    return Math.max(base, Math.min(backoffMs(w.consecutiveFailures, base, 5 * 60_000), 5 * 60_000));
  }

  async tick(now = Date.now()) {
    if (this.stopped) return;
    const max = this.ctx.settings.get().polling.maxConcurrentChecks;
    if (this.inflight.size >= max) return;
    const rows = this.ctx.db.all("SELECT * FROM watches WHERE enabled=1");
    const due = rows.map(rowToWatch).filter((w) => {
      if (this.inflight.has(w.id)) return false;
      if (!w.lastCheckAt) return true;
      return Date.parse(w.lastCheckAt) + Monitor.nextDelayMs(w) <= now;
    }).sort((a, b) => (a.lastCheckAt ?? "").localeCompare(b.lastCheckAt ?? ""));
    for (const w of due.slice(0, max - this.inflight.size)) void this.check(w.id).catch((e) => this.log.error("Unexpected check error", { err: e }));
  }

  /** Run one check. Never throws for Steam-side failures: those are recorded on the watch. */
  async check(watchId: number): Promise<CheckResult> {
    const row = this.ctx.db.get("SELECT * FROM watches WHERE id=?", watchId);
    if (!row) return { ok: false, error: "Watch not found" };
    if (this.inflight.has(watchId)) return { ok: false, skipped: "A check for this game is already running" };
    this.inflight.add(watchId);
    const watch = rowToWatch(row);
    const checkedAt = nowIso();
    try {
      const snap = await this.source.fetch({ appId: watch.appId, branch: watch.branch, accountId: watch.accountId });
      const stateRow = this.ctx.db.get("SELECT * FROM watch_state WHERE watch_id=?", watchId);
      const prev: PersistedState | null = stateRow
        ? { buildId: stateRow.build_id, timeUpdated: stateRow.time_updated, depots: parseJson(stateRow.depots_json, {}) }
        : null;
      const det = detect(prev, snap, { followMode: watch.followMode, depotIds: watch.depotIds, baselineFirst: watch.baselineFirst }, watchId);
      const eventId = recordDetection(this.ctx, watch, snap, det, checkedAt);

      let name = watch.name;
      if (/^App \d+$/.test(watch.name)) name = snap.name ?? (await storeAppName(watch.appId).catch(() => null)) ?? watch.name;
      this.ctx.db.run(
        "UPDATE watches SET status='ok', last_check_at=?, last_success_at=?, last_error=NULL, consecutive_failures=0, name=? WHERE id=?",
        checkedAt, checkedAt, name, watchId);
      if (eventId) {
        this.log.info("Event recorded", { watchId, appId: watch.appId, kind: det.type, eventId });
        this.ctx.bus.emit("event:created", eventId);
      }
      this.ctx.bus.emit("watch:updated", watchId);
      return { ok: true, eventId, kind: det.type };
    } catch (e) {
      const msg = (e as Error).message;
      const fails = (row.consecutive_failures ?? 0) + 1;
      this.ctx.db.run("UPDATE watches SET status='error', last_check_at=?, last_error=?, consecutive_failures=? WHERE id=?", checkedAt, redactString(msg), fails, watchId);
      (fails === 1 || fails % this.ctx.settings.get().polling.failureAlertThreshold === 0 ? this.log.warn : this.log.debug)("Check failed", { watchId, appId: watch.appId, fails, err: msg });
      this.ctx.bus.emit("watch:updated", watchId);
      return { ok: false, error: msg };
    } finally {
      this.inflight.delete(watchId);
    }
  }
}
