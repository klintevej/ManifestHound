import fsp from "node:fs/promises";
import path from "node:path";
import { diffFiles, renderHtmlReport, renderMarkdownReport, scanFiles, type FileDiff, type FileRecord, type ReportMeta } from "./files.js";
import { slug, validateConfig, type JobCtx, type JobResult } from "./types.js";
import { KeyedLock, safeJoin } from "../util/misc.js";

const locks = new KeyedLock();

export function reportMeta(c: JobCtx, firstRun: boolean): ReportMeta {
  const e = c.event;
  return {
    gameName: e.gameName, appId: e.appId, eventId: e.id, buildId: e.newBuild, prevBuildId: e.prevBuild,
    manifestIds: e.changes.manifestIds, updateTime: e.updateTime ?? e.detectedAt, generatedAt: new Date().toISOString(),
    jobName: c.def.name, firstRun,
  };
}

function loadSnapshot(c: JobCtx): FileRecord[] | null {
  const rows = c.app.db.all("SELECT path, sha256, size, mtime_ms FROM file_snapshots WHERE job_id=?", c.def.id);
  return rows.length ? rows.map((r) => ({ path: r.path, sha256: r.sha256, size: r.size, mtimeMs: r.mtime_ms })) : null;
}

function saveSnapshot(c: JobCtx, files: FileRecord[]) {
  const db = c.app.db;
  db.tx(() => {
    db.run("DELETE FROM file_snapshots WHERE job_id=?", c.def.id);
    for (const f of files) db.run("INSERT INTO file_snapshots(job_id,path,sha256,size,mtime_ms) VALUES(?,?,?,?,?)", c.def.id, f.path, f.sha256, f.size, f.mtimeMs);
  });
}

export const summarizeDiff = (d: FileDiff) => `${d.added.length} added, ${d.modified.length} modified, ${d.removed.length} removed, ${d.unchanged.length} unchanged`;

/**
 * Shared by the "collect" (copies files) and "report" (report only) jobs.
 * Idempotent per event: a report already written for this event is reused, so a retry after a crash
 * (when the snapshot has already advanced) still yields the original diff.
 */
export async function runScan(c: JobCtx, copy: boolean): Promise<JobResult> {
  const cfg = validateConfig(copy ? "collect" : "report", c.def.config);
  const root = c.resolveRoot(cfg.selection);
  return locks.run(c.outputDir, async () => {
    const reportsDir = path.join(c.outputDir, "reports");
    await fsp.mkdir(reportsDir, { recursive: true });
    const stem = c.manual ? `${slug(c.event.id)}-manual-${c.runId}` : slug(c.event.id);
    const jsonPath = path.join(reportsDir, `${stem}.json`);

    if (!c.manual) {
      const prior = await fsp.readFile(jsonPath, "utf8").catch(() => null);
      if (prior) {
        const j = JSON.parse(prior);
        c.log("Report for this event already exists; reusing it (idempotent retry).");
        return { summary: summarizeDiff(j.diff), data: { reused: true, report: path.relative(c.outputDir, jsonPath).split(path.sep).join("/"), counts: j.counts } };
      }
    }

    c.log(`Scanning ${root}`);
    const files = await scanFiles(root, cfg.selection, c.signal);
    c.log(`${files.length} files selected and hashed`);
    const prev = loadSnapshot(c);
    const diff = diffFiles(prev, files);
    const meta = reportMeta(c, prev === null);

    if (copy) {
      const dest = path.join(c.outputDir, "files");
      await fsp.mkdir(dest, { recursive: true });
      for (const f of [...diff.added, ...diff.modified.map((m) => m.after)]) {
        c.signal.throwIfAborted();
        const to = safeJoin(dest, f.path);
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.copyFile(safeJoin(root, f.path), to);
      }
      for (const f of diff.removed) await fsp.rm(safeJoin(dest, f.path), { force: true });
      c.log(`Copied ${diff.added.length + diff.modified.length} files to ${dest}`);
    }

    const counts = { added: diff.added.length, modified: diff.modified.length, removed: diff.removed.length, unchanged: diff.unchanged.length };
    const json = { meta, counts, diff, files };
    await fsp.writeFile(path.join(reportsDir, `${stem}.md`), renderMarkdownReport(meta, diff));
    await fsp.writeFile(path.join(reportsDir, `${stem}.html`), renderHtmlReport(meta, diff));
    await fsp.writeFile(path.join(reportsDir, "latest.json"), JSON.stringify(json, null, 2));
    await fsp.writeFile(jsonPath, JSON.stringify(json, null, 2)); // written last: its presence marks the event as done
    saveSnapshot(c, files);
    return { summary: summarizeDiff(diff), data: { report: path.relative(c.outputDir, jsonPath).split(path.sep).join("/"), counts, firstRun: prev === null } };
  });
}

export const collectHandler = (c: JobCtx) => runScan(c, true);
export const reportHandler = (c: JobCtx) => runScan(c, false);
