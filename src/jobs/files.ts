import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { UserError, safeJoin } from "../util/misc.js";

export const SelectionSchema = z.object({
  /** Directory to scan. Must live inside an allowed root. Ignored when sourceJobId is set. */
  root: z.string().default(""),
  /** Use another job's output directory as the root (chain jobs without hard-coding paths). */
  sourceJobId: z.number().int().nullable().default(null),
  /** Glob patterns relative to root. `**` crosses directories, `*` and `?` do not. */
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  /** Individual files relative to root (e.g. "Game_Data/Managed/Assembly-CSharp.dll"). */
  files: z.array(z.string()).default([]),
  extensions: z.array(z.string().regex(/^\.?[\w]+$/)).default([]),
  recursive: z.boolean().default(true),
  maxFiles: z.number().int().min(1).max(500_000).default(50_000),
}).prefault({});
export type Selection = z.infer<typeof SelectionSchema>;

export interface FileRecord { path: string; size: number; mtimeMs: number; sha256: string }

const win = process.platform === "win32";

/** Convert a glob to an anchored RegExp (matching forward-slash relative paths). */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  const g = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$", win ? "i" : "");
}

export async function sha256File(file: string): Promise<string> {
  const h = createHash("sha256");
  await new Promise<void>((res, rej) => {
    fs.createReadStream(file).on("data", (d) => h.update(d)).on("end", () => res()).on("error", rej);
  });
  return h.digest("hex");
}

/** Walk and filter. Symlinks are never followed, so a link cannot lead out of the root. */
export async function listFiles(root: string, sel: Selection, signal?: AbortSignal): Promise<FileRecord[]> {
  const rootAbs = path.resolve(root);
  const st = await fsp.stat(rootAbs).catch(() => null);
  if (!st?.isDirectory()) throw new UserError(`Source directory does not exist: ${rootAbs}`);
  const inc = sel.include.map(globToRegExp), exc = sel.exclude.map(globToRegExp);
  const explicit = new Set(sel.files.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, "")).map((f) => (win ? f.toLowerCase() : f)));
  const exts = new Set(sel.extensions.map((e) => (e.startsWith(".") ? e : "." + e).toLowerCase()));
  const useDefaultAll = !inc.length && !explicit.size;
  const out: FileRecord[] = [];

  async function walk(dir: string, rel: string) {
    for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
      signal?.throwIfAborted();
      if (ent.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { if (sel.recursive) await walk(path.join(dir, ent.name), r); continue; }
      if (!ent.isFile()) continue;
      const key = win ? r.toLowerCase() : r;
      const picked = explicit.has(key) || inc.some((x) => x.test(r)) || useDefaultAll;
      if (!picked) continue;
      if (exts.size && !exts.has(path.extname(ent.name).toLowerCase()) && !explicit.has(key)) continue;
      if (exc.some((x) => x.test(r))) continue;
      if (out.length >= sel.maxFiles) throw new UserError(`More than ${sel.maxFiles} files matched; narrow the selection`);
      const abs = path.join(dir, ent.name);
      const s = await fsp.stat(abs);
      out.push({ path: r, size: s.size, mtimeMs: Math.floor(s.mtimeMs), sha256: "" });
    }
  }
  await walk(rootAbs, "");
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Hash the given listed files in place. */
export async function hashFiles(root: string, files: FileRecord[], signal?: AbortSignal): Promise<FileRecord[]> {
  for (const f of files) { signal?.throwIfAborted(); f.sha256 = await sha256File(safeJoin(path.resolve(root), f.path)); }
  return files;
}

export async function scanFiles(root: string, sel: Selection, signal?: AbortSignal): Promise<FileRecord[]> {
  return hashFiles(root, await listFiles(root, sel, signal), signal);
}

export interface FileDiff {
  added: FileRecord[];
  removed: FileRecord[];
  modified: { path: string; before: FileRecord; after: FileRecord }[];
  unchanged: FileRecord[];
}

export function diffFiles(prev: FileRecord[] | null, curr: FileRecord[]): FileDiff {
  const p = new Map((prev ?? []).map((f) => [f.path, f]));
  const d: FileDiff = { added: [], removed: [], modified: [], unchanged: [] };
  for (const f of curr) {
    const o = p.get(f.path);
    if (!o) d.added.push(f);
    else if (o.sha256 !== f.sha256) d.modified.push({ path: f.path, before: o, after: f });
    else d.unchanged.push(f);
    p.delete(f.path);
  }
  d.removed = [...p.values()];
  return d;
}

export interface ReportMeta {
  gameName: string; appId: number; eventId: string; buildId: string | null; prevBuildId: string | null;
  manifestIds: Record<string, string>; updateTime: string; generatedAt: string; jobName: string; firstRun: boolean;
}

export function renderMarkdownReport(meta: ReportMeta, d: FileDiff): string {
  const tbl = (rows: string[][], head: string[]) =>
    rows.length ? [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n") : "_none_";
  const mf = Object.entries(meta.manifestIds).map(([d, m]) => `${d}: ${m}`).join(", ") || "unavailable";
  return [
    `# File change report: ${meta.gameName} (${meta.appId})`, "",
    `- Job: ${meta.jobName}`, `- Event: ${meta.eventId}`, `- Build: ${meta.prevBuildId ?? "unavailable"} -> ${meta.buildId ?? "unavailable"}`,
    `- Manifests: ${mf}`, `- Update time: ${meta.updateTime}`, `- Generated: ${meta.generatedAt}`,
    meta.firstRun ? "- First run for this job: every file is reported as added (baseline)." : "",
    "", `**Added ${d.added.length} / Modified ${d.modified.length} / Removed ${d.removed.length} / Unchanged ${d.unchanged.length}**`, "",
    "## Added", tbl(d.added.map((f) => [f.path, String(f.size), f.sha256]), ["Path", "Size", "SHA-256"]), "",
    "## Modified", tbl(d.modified.map((m) => [m.path, `${m.before.size} -> ${m.after.size}`, m.before.sha256.slice(0, 16) + "...", m.after.sha256]), ["Path", "Size", "Old SHA-256", "New SHA-256"]), "",
    "## Removed", tbl(d.removed.map((f) => [f.path, String(f.size), f.sha256]), ["Path", "Size", "SHA-256"]), "",
  ].join("\n");
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
export function renderHtmlReport(meta: ReportMeta, d: FileDiff): string {
  const rows = (items: string[][]) => items.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("");
  const section = (title: string, head: string[], items: string[][]) =>
    `<h2>${title} (${items.length})</h2><table><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr>${rows(items)}</table>`;
  return `<!doctype html><meta charset="utf-8"><title>${esc(meta.gameName)} file changes</title>
<style>body{font:14px system-ui;background:#0f1115;color:#e6e6e6;margin:2rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #2a2f3a;padding:4px 8px;text-align:left;font-family:ui-monospace,monospace;font-size:12px}th{background:#171a21}h1,h2{font-weight:600}</style>
<h1>File change report: ${esc(meta.gameName)} (${meta.appId})</h1>
<p>Event ${esc(meta.eventId)} - build ${esc(meta.prevBuildId ?? "unavailable")} -> ${esc(meta.buildId ?? "unavailable")} - ${esc(meta.updateTime)}</p>
<p>Manifests: ${esc(Object.entries(meta.manifestIds).map(([a, b]) => `${a}: ${b}`).join(", ") || "unavailable")}</p>
${section("Added", ["Path", "Size", "SHA-256"], d.added.map((f) => [f.path, String(f.size), f.sha256]))}
${section("Modified", ["Path", "Old size", "New size", "Old SHA-256", "New SHA-256"], d.modified.map((m) => [m.path, String(m.before.size), String(m.after.size), m.before.sha256, m.after.sha256]))}
${section("Removed", ["Path", "Size", "SHA-256"], d.removed.map((f) => [f.path, String(f.size), f.sha256]))}`;
}
