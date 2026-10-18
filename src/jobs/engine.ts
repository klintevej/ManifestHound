import fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { AppContext } from "../context.js";
import { rowToEvent, type EventRecord } from "../events.js";
import { rowToWatch, type Watch } from "../watches.js";
import { backoffMs, nowIso, parseJson, resolveInsideRoots, sleep, UserError } from "../util/misc.js";
import { redactString } from "../util/redact.js";
import { outputDirFor, rowToJobDef, validateConfig, type JobCtx, type JobHandler, type JobResult, type JobType } from "./types.js";
import { collectHandler, reportHandler } from "./collect.js";
import { archiveHandler } from "./archive.js";
import { decompileHandler } from "./decompile.js";
import { gitHandler } from "./git.js";
import type { Selection } from "./files.js";
import path from "node:path";

export const HANDLERS: Record<JobType, JobHandler> = {
  collect: collectHandler, report: reportHandler, archive: archiveHandler, decompile: decompileHandler, git: gitHandler,
};

const MAX_LOG = 256 * 1024;
const FINAL = ["succeeded", "failed", "skipped", "cancelled"];

/**
 * Persistent job queue. The queue is the job_runs table, so it survives restarts.
 * Ordering: runs of one event execute by ascending `ord`; equal `ord` may run in parallel.
 * A failed job with stop_on_fail marks later-ord runs of that event as skipped.
 * Bounded by settings.jobs.maxConcurrent; each job definition runs at most once at a time.
 */
export class JobEngine {
  private timer: NodeJS.Timeout | null = null;
  private running = new Map<number, { ac: AbortController; jobId: number; promise: Promise<void> }>();
  private log;
  private handlers: Record<JobType, JobHandler>;
  private stopped = false;
  constructor(private ctx: AppContext, handlers: Partial<Record<JobType, JobHandler>> = {}) {
    this.log = ctx.logger.child("jobs");
    this.handlers = { ...HANDLERS, ...handlers };
  }

  /** Re-queue runs that were interrupted by a crash/restart. Safe because every built-in job is idempotent. */
  recover() {
    const db = this.ctx.db;
    const stuck = db.all("SELECT r.id, r.attempts, d.max_retries FROM job_runs r LEFT JOIN job_defs d ON d.id=r.job_id WHERE r.status='running'");
    for (const r of stuck) {
      const mark = `\n[${nowIso()}] Interrupted by application restart.`;
      if (r.attempts > (r.max_retries ?? 0)) {
        db.run("UPDATE job_runs SET status='failed', finished_at=?, error='Interrupted by restart and out of retries', log=log||? WHERE id=?", nowIso(), mark, r.id);
      } else {
        db.run("UPDATE job_runs SET status='queued', next_attempt_at=?, log=log||? WHERE id=?", nowIso(), mark + " Re-queued.", r.id);
      }
    }
    if (stuck.length) this.log.warn("Recovered interrupted job runs", { count: stuck.length });
  }

  start() {
    this.stopped = false;
    this.recover();
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref?.();
    this.ctx.bus.on("event:created", () => void this.tick());
  }

  async stop(graceMs = 15_000) {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    const end = Date.now() + graceMs;
    while (this.running.size && Date.now() < end) await sleep(100);
    for (const r of this.running.values()) r.ac.abort(); // anything still running is recovered on next start
    await Promise.allSettled([...this.running.values()].map((r) => r.promise));
  }

  activeRunIds() { return [...this.running.keys()]; }

  cancel(runId: number): boolean {
    const r = this.running.get(runId);
    if (r) { r.ac.abort(new Error("Cancelled by user")); return true; }
    const res = this.ctx.db.run("UPDATE job_runs SET status='cancelled', finished_at=?, error='Cancelled by user' WHERE id=? AND status='queued'", nowIso(), runId);
    return res.changes > 0;
  }

  async tick(now = new Date()) {
    if (this.stopped) return;
    const db = this.ctx.db;
    const cap = this.ctx.settings.get().jobs.maxConcurrent;
    this.skipBlocked();
    if (this.running.size >= cap) return;
    const queued = db.all("SELECT * FROM job_runs WHERE status='queued' AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY manual DESC, created_at, ord, id LIMIT 100", now.toISOString());
    const busyJobs = new Set([...this.running.values()].map((r) => r.jobId));
    for (const r of queued) {
      if (this.running.size >= cap) break;
      if (busyJobs.has(r.job_id) || this.running.has(r.id)) continue;
      if (!r.manual) {
        // wait for all lower-ord runs of the same event to finish
        const blocker = db.get("SELECT 1 FROM job_runs WHERE event_id=? AND manual=0 AND ord<? AND status IN ('queued','running') LIMIT 1", r.event_id, r.ord);
        if (blocker) continue;
      }
      busyJobs.add(r.job_id);
      this.launch(r);
    }
  }

  /** Mark queued runs as skipped when an earlier stop_on_fail job of the same event failed. */
  private skipBlocked() {
    const db = this.ctx.db;
    const rows = db.all(
      `SELECT q.id, f.job_name AS failed_name FROM job_runs q
       JOIN job_runs f ON f.event_id=q.event_id AND f.manual=0 AND f.status='failed' AND f.ord<q.ord
       JOIN job_defs d ON d.id=f.job_id AND d.stop_on_fail=1
       WHERE q.status='queued' AND q.manual=0`);
    for (const r of rows) {
      db.run("UPDATE job_runs SET status='skipped', finished_at=?, error=? WHERE id=? AND status='queued'", nowIso(), `Skipped: earlier job "${r.failed_name}" failed and is set to stop the chain`, r.id);
      this.ctx.bus.emit("job:updated", r.id);
    }
  }

  private launch(run: any) {
    const ac = new AbortController();
    const promise = this.execute(run, ac).catch((e) => this.log.error("Job engine error", { runId: run.id, err: e })).finally(() => {
      this.running.delete(run.id);
      void this.tick();
    });
    this.running.set(run.id, { ac, jobId: run.job_id, promise });
  }

  private eventFor(eventId: string): EventRecord | null {
    const row = this.ctx.db.get("SELECT * FROM events WHERE id=?", eventId);
    if (row) return rowToEvent(row);
    const m = /^manual-(\d+)-/.exec(eventId);
    if (!m) return null;
    const w = this.ctx.db.get("SELECT * FROM watches WHERE id=?", Number(m[1]));
    if (!w) return null;
    const st = this.ctx.db.get("SELECT * FROM watch_state WHERE watch_id=?", w.id);
    const depots: Record<string, string> = parseJson(st?.depots_json, {});
    return {
      id: eventId, watchId: w.id, appId: w.app_id, gameName: w.name, kind: "update", detectedAt: nowIso(), updateTime: st?.time_updated ? new Date(st.time_updated * 1000).toISOString() : null,
      prevBuild: null, newBuild: st?.build_id ?? null,
      changes: { buildChange: null, depots: Object.entries(depots).map(([depotId, to]) => ({ depotId, change: "changed" as const, from: null, to, tracked: true })), rollback: false, trigger: [], manifestIds: depots },
    };
  }

  private async execute(run: any, ac: AbortController) {
    const db = this.ctx.db;
    const started = db.run("UPDATE job_runs SET status='running', attempts=attempts+1, started_at=?, error=NULL WHERE id=? AND status='queued'", nowIso(), run.id);
    if (!started.changes) return;
    const attempt = run.attempts + 1;
    this.ctx.bus.emit("job:updated", run.id);

    let buf = run.log || "";
    let dirty = false;
    const flush = () => { if (dirty) { db.run("UPDATE job_runs SET log=? WHERE id=?", buf.slice(-MAX_LOG), run.id); dirty = false; } };
    const log = (m: string) => { buf += `[${nowIso()}] ${redactString(m)}\n`; dirty = true; if (buf.length > MAX_LOG * 2) buf = buf.slice(-MAX_LOG); };
    const flusher = setInterval(flush, 1000);

    let status: "succeeded" | "failed" | "queued" | "cancelled" = "failed";
    let error: string | null = null, result: JobResult | null = null, retryDelay = 0;
    let timer: NodeJS.Timeout | undefined;
    let def: ReturnType<typeof rowToJobDef> | null = null;
    try {
      const defRow = db.get("SELECT * FROM job_defs WHERE id=?", run.job_id);
      if (!defRow) throw new Error("Job definition no longer exists");
      def = rowToJobDef(this.ctx, defRow);
      const event = this.eventFor(run.event_id);
      if (!event) throw new Error("Event no longer exists");
      const wRow = event.watchId != null ? db.get("SELECT * FROM watches WHERE id=?", event.watchId) : null;
      const watch: Watch | null = wRow ? rowToWatch(wRow) : null;

      const timeoutSec = def.timeoutSec || this.ctx.settings.get().jobs.defaultTimeoutSec;
      timer = setTimeout(() => ac.abort(new Error(`Job timed out after ${timeoutSec}s`)), timeoutSec * 1000);
      const cfg = validateConfig(def.type, def.config);
      const outputDir = outputDirFor(this.ctx, def, event.appId);
      await fsp.mkdir(outputDir, { recursive: true });

      const c: JobCtx = {
        app: this.ctx, def: { ...def, config: cfg }, event, watch, runId: run.id, manual: !!run.manual, attempt, signal: ac.signal, outputDir, log,
        resolveRoot: (sel: Selection) => {
          if (sel.sourceJobId != null) {
            const r = db.get("SELECT * FROM job_defs WHERE id=?", sel.sourceJobId);
            if (!r) throw new UserError(`Source job ${sel.sourceJobId} does not exist`);
            return outputDirFor(this.ctx, rowToJobDef(this.ctx, r), event.appId);
          }
          if (!sel.root) throw new UserError("selection.root is required (the game install or depot download directory)");
          return resolveInsideRoots(sel.root, this.ctx.settings.roots(), this.ctx.settings.workDir());
        },
      };
      log(`Starting "${def.name}" (${def.type}), attempt ${attempt}${run.manual ? ", manual run" : ""}`);
      if (cfg.waitForBuild) await this.waitForBuild(c, cfg.waitForBuild);
      ac.signal.throwIfAborted(); // cancelled while starting up
      result = await this.handlers[def.type](c);
      status = "succeeded";
      log(`Finished: ${result.summary}`);
    } catch (e) {
      const reason = ac.signal.aborted ? (ac.signal.reason as Error | undefined) : undefined;
      error = redactString((reason?.message ?? (e as Error).message) || "Unknown error");
      result = (e as any)?.data ? { summary: error, data: (e as any).data } : null;
      log(`ERROR: ${error}`);
      if (this.stopped && ac.signal.aborted) { status = "queued"; error = null; } // shutdown: stays queued, recovered next start
      else if (reason?.message === "Cancelled by user") status = "cancelled";
      else if (def && attempt <= def.maxRetries) { status = "queued"; retryDelay = backoffMs(attempt, 5000, 10 * 60_000); log(`Will retry in ${Math.round(retryDelay / 1000)}s`); }
    } finally {
      clearTimeout(timer);
      clearInterval(flusher);
    }
    db.run(
      "UPDATE job_runs SET status=?, log=?, error=?, result_json=?, finished_at=?, next_attempt_at=? WHERE id=?",
      status, buf.slice(-MAX_LOG), error, result ? JSON.stringify(result) : null, status === "queued" ? null : nowIso(),
      status === "queued" ? new Date(Date.now() + retryDelay).toISOString() : null, run.id);
    this.ctx.bus.emit("job:updated", run.id);
  }

  /** Optionally wait until the local Steam install reports the new build (appmanifest_<id>.acf). */
  private async waitForBuild(c: JobCtx, w: { acfPath: string; timeoutSec: number }) {
    const acf = resolveInsideRoots(w.acfPath, this.ctx.settings.roots(), this.ctx.settings.workDir());
    const want = c.event.newBuild;
    if (!want) return;
    const deadline = Date.now() + w.timeoutSec * 1000;
    for (;;) {
      const txt = await fsp.readFile(acf, "utf8").catch(() => "");
      const have = /"buildid"\s+"(\d+)"/.exec(txt)?.[1];
      const state = /"StateFlags"\s+"(\d+)"/.exec(txt)?.[1];
      if (have === want && (state === undefined || state === "4")) { c.log(`Local install is at build ${want}.`); return; }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for local install (${path.basename(acf)}) to reach build ${want}; it reports ${have ?? "no build"}`);
      c.log(`Waiting for local install: has ${have ?? "?"}, want ${want}`);
      await sleep(10_000, c.signal);
    }
  }

  // ---- API helpers
  /** Create a manual run (never subject to the automatic duplicate guard). */
  enqueueManual(jobId: number, eventId?: string): number {
    const db = this.ctx.db;
    const def = db.get("SELECT * FROM job_defs WHERE id=?", jobId);
    if (!def) throw new UserError("Job not found", 404);
    let ev: string = eventId ?? "";
    if (!ev) {
      const wid = def.watch_id ?? db.get("SELECT id FROM watches ORDER BY id LIMIT 1")?.id;
      if (!wid) throw new UserError("Add a game first: a job needs a game to run against");
      const last = db.get("SELECT id FROM events WHERE watch_id=? AND kind!='baseline' ORDER BY detected_at DESC LIMIT 1", wid);
      ev = last?.id ?? `manual-${wid}-${randomUUID()}`;
    }
    if (!this.eventFor(ev)) throw new UserError("Event not found", 404);
    const id = db.run("INSERT INTO job_runs(event_id,job_id,job_name,ord,status,manual,next_attempt_at,created_at) VALUES(?,?,?,?,?,?,?,?)",
      ev, jobId, def.name, def.ord, "queued", 1, nowIso(), nowIso()).lastId;
    void this.tick();
    return id;
  }
}

export const isFinal = (s: string) => FINAL.includes(s);
