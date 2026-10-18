import fsp from "node:fs/promises";
import path from "node:path";
import { globToRegExp } from "./files.js";
import { validateConfig, type JobCtx, type JobResult } from "./types.js";
import { KeyedLock } from "../util/misc.js";
import { cleanOutput, runProc } from "../util/proc.js";
import { ensureTool } from "../tools.js";

const locks = new KeyedLock();

/** Convert a glob (forward slashes) into a DepotDownloader `regex:` filelist line. Either slash style matches. */
export function globToFilelistLine(glob: string): string {
  // Walk the JS regex source and widen every slash (and [^/]) to accept both separators.
  const full = globToRegExp(glob).source;
  const src = full.slice(1, full.length - 1); // drop the ^ and $ anchors
  const BS = String.fromCharCode(92);
  const SLASH = "[" + BS + BS + "/]", NOT_SLASH = "[^" + BS + BS + "/]";
  let out = "";
  for (let i = 0; i < src.length; i++) {
    if (src.startsWith("[^" + BS + "/]", i)) { out += NOT_SLASH; i += 4; }
    else if (src.startsWith("[^/]", i)) { out += NOT_SLASH; i += 3; }
    else if (src[i] === BS && src[i + 1] === "/") { out += SLASH; i += 1; }
    else if (src[i] === "/") out += SLASH;
    else out += src[i];
  }
  return "regex:^" + out + "$";
}

export interface DownloadPlan { args: string[]; label: string }

/**
 * One DepotDownloader invocation per changed depot, pinned to the exact manifest of the update event,
 * so the files match the update ManifestHound reported (not whatever is current a minute later).
 * Falls back to a single "all depots of the app" run when no manifests are known.
 */
export function planDownloads(c: Pick<JobCtx, "event" | "outputDir">, cfg: any, filelist: string | null): DownloadPlan[] {
  const base = ["-app", String(c.event.appId), "-dir", c.outputDir, "-max-downloads", String(cfg.maxDownloads)];
  const branch = c.event.changes.branch ?? "public";
  if (branch !== "public") base.push("-branch", branch);
  if (cfg.os) base.push("-os", cfg.os);
  if (cfg.allPlatforms) base.push("-all-platforms");
  if (cfg.username) base.push("-username", cfg.username, "-remember-password");
  if (filelist) base.push("-filelist", filelist);
  const wanted: string[] = cfg.depots;
  const manifests = Object.entries(c.event.changes.manifestIds).filter(([d]) => !wanted.length || wanted.includes(d));
  if (cfg.pinManifests && manifests.length) {
    return manifests.map(([depot, manifest]) => ({ label: `depot ${depot}`, args: [...base, "-depot", depot, "-manifest", manifest] }));
  }
  if (wanted.length) return wanted.map((depot) => ({ label: `depot ${depot}`, args: [...base, "-depot", depot] }));
  return [{ label: "all depots", args: base }];
}

export async function depotDownloadHandler(c: JobCtx): Promise<JobResult> {
  const cfg = validateConfig("depotdownload", c.def.config);
  const tool = await ensureTool(c.app, "DepotDownloader", c.app.settings.get().tools.depotDownloaderPath, c.log, c.signal);
  return locks.run(c.outputDir, async () => {
    let filelist: string | null = null;
    if (cfg.files.length) {
      filelist = path.join(c.outputDir, ".manifesthound-filelist.txt");
      await fsp.writeFile(filelist, cfg.files.map(globToFilelistLine).join("\n") + "\n");
    }
    const plans = planDownloads(c, cfg, filelist);
    for (const p of plans) {
      c.signal.throwIfAborted();
      c.log(`DepotDownloader: ${p.label}`);
      const r = await runProc(tool, p.args, { signal: c.signal, timeoutMs: c.def.timeoutSec * 1000, maxBytes: 256 * 1024, env: { DOTNET_CLI_TELEMETRY_OPTOUT: "1" } });
      if (r.missing) {
        throw new Error(`DepotDownloader not found: "${tool}". Download it from github.com/SteamRE/DepotDownloader/releases (linux-arm64, linux-x64 or windows-x64) and set Settings > Jobs and tools > DepotDownloader path.`);
      }
      const out = cleanOutput(r.stdout + "\n" + r.stderr, 1500);
      if (r.code !== 0) {
        if (/password|two.?factor|2fa|steam guard|login/i.test(out) && cfg.username) {
          throw new Error(`DepotDownloader needs you to sign in once. Run this in a terminal and complete Steam Guard, then retry: DepotDownloader -app ${c.event.appId} -username ${cfg.username} -remember-password -manifest-only. Output: ${out.slice(-300)}`);
        }
        throw new Error(`DepotDownloader failed for ${p.label} (exit ${r.code}): ${out.slice(-600)}`);
      }
      c.log(out.split("\n").slice(-6).join("\n"));
    }
    await fsp.rm(path.join(c.outputDir, ".manifesthound-filelist.txt"), { force: true });
    return { summary: `${plans.length} depot download(s) finished for build ${c.event.newBuild ?? "unknown"}`, data: { runs: plans.map((p) => p.label), build: c.event.newBuild } };
  });
}
