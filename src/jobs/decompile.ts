import fsp from "node:fs/promises";
import path from "node:path";
import { globToRegExp, hashFiles, listFiles } from "./files.js";
import { slug, validateConfig, type JobCtx, type JobResult } from "./types.js";
import { KeyedLock, safeJoin } from "../util/misc.js";
import { cleanOutput, runProc } from "../util/proc.js";
import { ensureTool } from "../tools.js";

const locks = new KeyedLock();
const versionCache = new Map<string, string>();

/** True when the PE file has a CLR header (managed assembly). Native DLLs return false. Throws on non-PE input. */
export async function isManagedAssembly(file: string): Promise<boolean> {
  const fh = await fsp.open(file, "r");
  try {
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, 4096, 0);
    if (bytesRead < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) throw new Error("not a PE file");
    const pe = buf.readUInt32LE(0x3c);
    if (pe + 24 > bytesRead || buf.readUInt32LE(pe) !== 0x00004550) throw new Error("invalid PE signature");
    const opt = pe + 24;
    const magic = buf.readUInt16LE(opt);
    const dirs = opt + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1);
    if (dirs < opt) throw new Error("unknown PE optional header");
    const clr = dirs + 14 * 8;
    if (clr + 8 > bytesRead) return false;
    return buf.readUInt32LE(clr) !== 0 && buf.readUInt32LE(clr + 4) !== 0;
  } finally { await fh.close(); }
}

/** Remove ILSpy/dnSpy-style metadata-token comments from generated C#. Returns the number of lines changed. */
export function stripTokenComments(src: string): { text: string; changed: number } {
  let changed = 0;
  const lines = src.split(/\r?\n/);
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const out: string[] = [];
  const TOKEN = /\/\/\s*(?:Token|RID|RVA|File Offset)\s*:.*$/;
  for (const line of lines) {
    if (TOKEN.test(line)) {
      changed++;
      const rest = line.replace(TOKEN, "").replace(/\s+$/, "");
      if (rest.trim() === "") continue;       // comment-only line: drop it
      out.push(rest);                          // trailing comment: keep code
    } else out.push(line);
  }
  return { text: out.join(eol), changed };
}

/**
 * ILSpy writes <HintPath> entries for non-framework references (e.g. Unity DLLs) using the exporting machine's layout.
 * Keep only the file name so exported projects never carry host directory structure.
 */
export function sanitizeCsproj(xml: string): string {
  return xml.replace(/<HintPath>([^<]*)<\/HintPath>/gi, (_m, p: string) => `<HintPath>${p.split(/[\\/]/).pop()}</HintPath>`);
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else if (e.isFile()) yield p;
  }
}

async function toolVersion(cmd: string, signal: AbortSignal, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (versionCache.has(cmd)) return versionCache.get(cmd)!;
  const r = await runProc(cmd, ["--version"], { signal, timeoutMs: 30_000, env });
  if (r.missing || r.code !== 0) return null;
  const v = r.stdout.trim().split(/\r?\n/)[0].replace(/^ilspycmd:\s*/i, "");
  versionCache.set(cmd, v);
  return v;
}

const relOut = (c: JobCtx, p: string) => path.relative(c.outputDir, p).split(path.sep).join("/");

interface Outcome { assembly: string; status: "exported" | "skipped" | "native" | "failed"; reason?: string; dir?: string; sha256?: string }

export async function decompileHandler(c: JobCtx): Promise<JobResult> {
  const cfg = validateConfig("decompile", c.def.config);
  const e = c.event;
  const tool = await ensureTool(c.app, "ilspycmd", c.app.settings.get().tools.ilspyCmdPath, c.log, c.signal);
  // ilspycmd is built for one .NET major; let it run on a newer installed runtime.
  const env: NodeJS.ProcessEnv = { DOTNET_ROLL_FORWARD: process.env.DOTNET_ROLL_FORWARD ?? "Major", DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" };

  const version = await toolVersion(tool, c.signal, env);
  if (!version) {
    throw new Error(`ILSpy command line tool not found or not runnable: "${tool}". Install it with "dotnet tool install -g ilspycmd" and set Settings > Tools > ilspyCmdPath if it is not on PATH. Native DLLs cannot be decompiled to C# in any case.`);
  }

  const root = c.resolveRoot(cfg.selection);
  if (!cfg.assemblies.length) throw new Error("No assemblies configured. List the important DLLs for this game in the job config (names or globs relative to the source root).");
  // Names without a slash match anywhere under the root, so "Assembly-CSharp.dll" works whatever the game layout.
  const matcher = (a: string) => globToRegExp(a.includes("/") || a.includes("*") ? a : `**/${a}`);
  const wanted: RegExp[] = cfg.assemblies.map(matcher);
  const listed = (await listFiles(root, { ...cfg.selection, include: [], files: [], extensions: [".dll", ".exe"] }, c.signal)).filter((f) => wanted.some((w) => w.test(f.path)));
  const targets = await hashFiles(root, listed, c.signal);
  const missing: string[] = cfg.assemblies.filter((a: string) => !targets.some((t) => matcher(a).test(t.path)));
  for (const m of missing) c.log(`WARNING: configured assembly not found under source root: ${m}`);
  if (!targets.length) throw new Error("None of the configured assemblies were found under the source root");

  const srcRoot = path.join(c.outputDir, "src");
  const inputRoot = path.join(c.outputDir, "input");
  await fsp.mkdir(srcRoot, { recursive: true });

  const outcomes: Outcome[] = [];
  await locks.run(c.outputDir, async () => {
    for (const t of targets) {
      c.signal.throwIfAborted();
      const abs = safeJoin(root, t.path);
      const name = path.basename(t.path).replace(/\.(dll|exe)$/i, "");
      const o: Outcome = { assembly: t.path, status: "failed", sha256: t.sha256 };
      outcomes.push(o);
      try {
        if (!(await isManagedAssembly(abs).catch(() => false))) { o.status = "native"; o.reason = "Native or non-.NET binary; cannot be decompiled to C#"; c.log(`SKIP native: ${t.path}`); continue; }

        let dirName = slug(name);
        const existing = path.join(srcRoot, dirName);
        const info = await fsp.readFile(path.join(existing, "export-info.json"), "utf8").then(JSON.parse).catch(() => null);
        if (info?.input?.sha256 === t.sha256 && info?.settings?.languageVersion === cfg.languageVersion) {
          o.status = "skipped"; o.reason = "Identical input already exported"; o.dir = relOut(c, existing); c.log(`SKIP unchanged: ${t.path}`); continue;
        }
        if (info || (await fsp.stat(existing).catch(() => null))) {
          switch (cfg.onExisting) {
            case "fail": throw new Error(`Export already exists at ${existing} and onExisting=fail`);
            case "skip": o.status = "skipped"; o.reason = "Export exists and onExisting=skip"; o.dir = relOut(c, existing); c.log(`SKIP existing: ${t.path}`); continue;
            case "versioned": dirName = `${slug(name)}@${t.sha256.slice(0, 12)}`; break;
            case "overwrite": await fsp.rm(existing, { recursive: true, force: true }); break;
          }
        }
        const outDir = path.join(srcRoot, dirName);
        if (cfg.onExisting === "versioned" && (await fsp.stat(outDir).catch(() => null))) { o.status = "skipped"; o.reason = "Versioned export already exists"; o.dir = relOut(c, outDir); continue; }
        await fsp.mkdir(outDir, { recursive: true });

        const args = ["--disable-updatecheck", "-p", "-o", outDir, "-lv", cfg.languageVersion, "-r", path.dirname(abs)];
        if (cfg.nestedDirectories) args.push("--nested-directories");
        if (cfg.removeDeadCode) args.push("--no-dead-code", "--no-dead-stores");
        args.push(abs);
        c.log(`ilspycmd ${args.map((a) => (a === abs || a === outDir ? path.basename(a) : a)).join(" ")}`);
        const r = await runProc(tool, args, { signal: c.signal, env, timeoutMs: Math.max(60_000, c.def.timeoutSec * 1000) });
        if (r.code !== 0) throw new Error(`ilspycmd exited with ${r.code}: ${cleanOutput(r.stderr || r.stdout)}`);

        // Post-process: no .sln files, no token comments (ilspycmd 8.x has no switch for either).
        let slnRemoved = 0, stripped = 0, csFiles = 0, csproj = 0;
        for await (const f of walk(outDir)) {
          if (/\.sln$/i.test(f)) { await fsp.rm(f); slnRemoved++; continue; }
          if (/\.csproj$/i.test(f)) {
            csproj++;
            const x = await fsp.readFile(f, "utf8"), y = sanitizeCsproj(x);
            if (y !== x) await fsp.writeFile(f, y);
          }
          if (/\.cs$/i.test(f)) {
            csFiles++;
            const s = await fsp.readFile(f, "utf8");
            const { text, changed } = stripTokenComments(s);
            if (changed) { await fsp.writeFile(f, text); stripped += changed; }
          }
        }
        if (!csproj) throw new Error("ilspycmd produced no .csproj (the assembly may be a mixed-mode or reference-only assembly)");

        await fsp.writeFile(path.join(outDir, "export-info.json"), JSON.stringify({
          tool: { name: "ilspycmd", version, path: path.basename(tool) },
          settings: { languageVersion: cfg.languageVersion, nestedDirectories: cfg.nestedDirectories, removeDeadCode: cfg.removeDeadCode, tokenComments: "disabled (stripped after export)", solutionFiles: "excluded (removed after export)" },
          input: { path: t.path, sha256: t.sha256, size: t.size },
          event: { id: e.id, appId: e.appId, buildId: e.newBuild, manifestIds: e.changes.manifestIds },
          result: { csFiles, csproj, tokenCommentLinesStripped: stripped, slnFilesRemoved: slnRemoved },
          exportedAt: new Date().toISOString(),
        }, null, 2));

        if (cfg.copyInputs) {
          const to = safeJoin(inputRoot, t.path);
          await fsp.mkdir(path.dirname(to), { recursive: true });
          await fsp.copyFile(abs, to);
        }
        o.status = "exported"; o.dir = relOut(c, outDir);
        c.log(`OK ${t.path}: ${csFiles} .cs files, ${stripped} token comment lines stripped, ${slnRemoved} .sln removed`);
      } catch (err) {
        if (c.signal.aborted) throw err;
        o.status = "failed"; o.reason = (err as Error).message;
        c.log(`FAILED ${t.path}: ${o.reason}`);
      }
    }
  });

  if (cfg.pruneStale) {
    const current = new Set(targets.map((t) => slug(path.basename(t.path).replace(/[.](dll|exe)$/i, ""))));
    for (const d of await fsp.readdir(srcRoot, { withFileTypes: true })) {
      const marked = d.isDirectory() && (await fsp.stat(path.join(srcRoot, d.name, "export-info.json")).catch(() => null));
      if (marked && !current.has(d.name.split("@")[0])) { await fsp.rm(path.join(srcRoot, d.name), { recursive: true, force: true }); c.log("Removed stale export " + d.name); }
    }
  }

  const count = (s: Outcome["status"]) => outcomes.filter((o) => o.status === s).length;
  const failed = outcomes.filter((o) => o.status === "failed");
  await fsp.writeFile(path.join(c.outputDir, `decompile-${e.id}.json`), JSON.stringify({ tool: { name: "ilspycmd", version }, outcomes, missing }, null, 2));
  if (failed.length && (cfg.strict || count("exported") + count("skipped") === 0)) {
    throw new Error(`${failed.length} assembl${failed.length === 1 ? "y" : "ies"} failed: ${failed.map((f) => `${f.assembly} (${f.reason})`).join("; ")}`);
  }
  return {
    summary: `${count("exported")} exported, ${count("skipped")} skipped, ${count("native")} native, ${failed.length} failed (ilspycmd ${version})`,
    data: { tool: version, outcomes, missingAssemblies: missing },
  };
}
