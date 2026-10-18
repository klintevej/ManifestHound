import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { scanFiles } from "./files.js";
import { slug, validateConfig, type JobCtx, type JobResult } from "./types.js";
import { createProvider, type DestRow } from "./uploads.js";
import { safeJoin } from "../util/misc.js";
import { redactString } from "../util/redact.js";

const require = createRequire(import.meta.url);
const yazl = require("yazl");

export function stampForFile(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
}

export async function archiveHandler(c: JobCtx): Promise<JobResult> {
  const cfg = validateConfig("archive", c.def.config);
  const e = c.event;
  const files = cfg.include.files ? await scanFiles(c.resolveRoot(cfg.selection), cfg.selection, c.signal) : [];
  const root = cfg.include.files ? c.resolveRoot(cfg.selection) : "";
  if (!cfg.include.files && !cfg.include.metadata) throw new Error("Archive config includes neither files nor metadata");
  c.log(`${files.length} files selected`);

  await fsp.mkdir(c.outputDir, { recursive: true });
  const name = `${slug(e.gameName)}-${e.appId}-b${e.newBuild ?? "unknown"}-${stampForFile(new Date(e.updateTime ?? e.detectedAt))}.zip`;
  const zipPath = path.join(c.outputDir, name);
  const tmp = zipPath + ".part";

  const zip = new yazl.ZipFile();
  if (cfg.include.metadata) {
    const meta = {
      app: { id: e.appId, name: e.gameName }, eventId: e.id, kind: e.kind, buildId: e.newBuild, previousBuildId: e.prevBuild,
      manifests: e.changes.manifestIds, depots: e.changes.depots, updateTime: e.updateTime ?? e.detectedAt, detectedAt: e.detectedAt,
      generatedAt: new Date().toISOString(), generator: "ManifestHound",
      files: files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })),
    };
    zip.addBuffer(Buffer.from(JSON.stringify(meta, null, 2)), "metadata.json", { compress: true });
  }
  for (const f of files) zip.addFile(safeJoin(root, f.path), `files/${f.path}`, { compress: cfg.compressionLevel > 0, compressionLevel: cfg.compressionLevel, mtime: new Date(f.mtimeMs) });
  zip.end();
  await new Promise<void>((res, rej) => {
    const out = fs.createWriteStream(tmp);
    c.signal.addEventListener("abort", () => { out.destroy(new Error("aborted")); }, { once: true });
    zip.outputStream.on("error", rej).pipe(out).on("close", res).on("error", rej);
  });
  await fsp.rename(tmp, zipPath);
  const size = (await fsp.stat(zipPath)).size;
  c.log(`Archive written: ${name} (${size} bytes)`);

  const uploads: Record<string, unknown>[] = [];
  const failures: string[] = [];
  for (const id of cfg.destinationIds) {
    c.signal.throwIfAborted();
    const row = c.app.db.get("SELECT * FROM destinations WHERE id=?", id) as DestRow | undefined;
    if (!row) { failures.push(`destination ${id} no longer exists`); continue; }
    try {
      const r = await createProvider(c.app, row).upload(zipPath, name, { signal: c.signal, log: c.log });
      c.log(`Uploaded to "${row.name}" (${row.type}): ${r.location} verified=${r.verified}${r.detail ? ` (${r.detail})` : ""}`);
      uploads.push({ destination: row.name, ...r });
    } catch (err) {
      const msg = redactString((err as Error).message);
      c.log(`Upload to "${row.name}" FAILED: ${msg}`);
      failures.push(`${row.name}: ${msg}`);
    }
  }
  if (failures.length) throw new Error(`Archive created but ${failures.length} upload(s) failed: ${failures.join("; ")}`);
  return { summary: `${files.length} files archived (${size} bytes), ${uploads.length} upload(s) verified`, data: { archive: name, size, uploads } };
}
