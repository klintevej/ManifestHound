import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AppContext } from "./context.js";
import { KeyedLock, UserError } from "./util/misc.js";
import { cleanOutput, managedToolPath, resolveTool, runProc } from "./util/proc.js";

export type ToolName = "ilspycmd" | "DepotDownloader";
export const INSTALLABLE: ToolName[] = ["ilspycmd", "DepotDownloader"];

const ILSPY_VERSION = "8.2.0.7535";
const DD_RELEASE = "https://api.github.com/repos/SteamRE/DepotDownloader/releases/latest";
const MAX_DOWNLOAD = 300 * 1024 * 1024;
const locks = new KeyedLock();

const env = { DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1", DOTNET_ROLL_FORWARD: "Major" };

/** True when the executable cannot be started at all (not on PATH, bad path). */
export async function isMissing(tool: string): Promise<boolean> {
  const r = await runProc(tool, ["--version"], { timeoutMs: 20_000, env }).catch(() => ({ missing: false }));
  return !!r.missing;
}

async function download(url: string, dest: string, signal?: AbortSignal, sha256?: string): Promise<void> {
  const res = await fetch(url, { signal, headers: { "user-agent": "ManifestHound" }, redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} from ${new URL(url).host}`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_DOWNLOAD) throw new Error("Download is larger than the 300 MB limit");
  const hash = createHash("sha256");
  let size = 0;
  const body = Readable.fromWeb(res.body as any);
  body.on("data", (d: Buffer) => { size += d.length; hash.update(d); if (size > MAX_DOWNLOAD) body.destroy(new Error("Download is larger than the 300 MB limit")); });
  await pipeline(body, fs.createWriteStream(dest));
  if (sha256 && hash.digest("hex") !== sha256.toLowerCase()) throw new Error("Downloaded file does not match the published SHA-256");
}

async function extractZip(zip: string, dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  // Windows 10+ ships bsdtar in System32 (a GNU tar earlier on PATH cannot read zips); Debian usually has unzip.
  const winTar = path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "tar.exe");
  const attempts: Array<[string, string[]]> = process.platform === "linux"
    ? [["unzip", ["-o", "-q", zip, "-d", dir]], ["bsdtar", ["-xf", zip, "-C", dir]]]
    : [[process.platform === "win32" ? winTar : "tar", ["-xf", zip, "-C", dir]]];
  let last = "";
  for (const [cmd, args] of attempts) {
    const r = await runProc(cmd, args, { timeoutMs: 120_000 });
    if (!r.missing && r.code === 0) return;
    last = r.missing ? `${cmd} not found` : cleanOutput(r.stderr || r.stdout, 300);
  }
  throw new Error(`Could not unzip the download (${last}). On Debian run: sudo apt install unzip`);
}

async function installDepotDownloader(signal?: AbortSignal): Promise<void> {
  const plat = ({ win32: "windows", linux: "linux", darwin: "macos" } as Record<string, string>)[process.platform];
  const asset = plat && `DepotDownloader-${plat}-${process.arch}.zip`;
  if (!asset) throw new Error(`No DepotDownloader build for ${process.platform} ${process.arch}`);
  const rel: any = await fetch(DD_RELEASE, { signal, headers: { "user-agent": "ManifestHound", accept: "application/vnd.github+json" } })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`GitHub release lookup failed: HTTP ${r.status}`))));
  const a = (rel.assets ?? []).find((x: any) => x.name === asset);
  if (!a) throw new Error(`Release ${rel.tag_name} has no ${asset}`);
  const target = path.dirname(managedToolPath("DepotDownloader"));
  const tmp = target + ".tmp";
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.mkdir(tmp, { recursive: true });
  try {
    const zip = path.join(tmp, asset);
    await download(a.browser_download_url, zip, signal, typeof a.digest === "string" ? a.digest.replace(/^sha256:/, "") : undefined);
    const out = path.join(tmp, "out");
    await extractZip(zip, out);
    await fsp.rm(target, { recursive: true, force: true });
    await fsp.rename(out, target);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
  if (process.platform !== "win32") await fsp.chmod(managedToolPath("DepotDownloader"), 0o755);
}

const dotnetDir = () => path.dirname(managedToolPath("dotnet"));

/** Point child processes at our own .NET when one was installed (apphost tools like ilspycmd read DOTNET_ROOT). */
export function useManagedDotnet(): void {
  if (fs.existsSync(managedToolPath("dotnet"))) process.env.DOTNET_ROOT = dotnetDir();
}

/** Microsoft's official dotnet-install script, run into <data>/tools/dotnet. No admin rights needed. */
async function installDotnet(signal?: AbortSignal): Promise<string> {
  const win = process.platform === "win32";
  const dir = dotnetDir();
  const script = path.join(path.dirname(dir), win ? "dotnet-install.ps1" : "dotnet-install.sh");
  await fsp.mkdir(path.dirname(dir), { recursive: true });
  await download(win ? "https://dot.net/v1/dotnet-install.ps1" : "https://dot.net/v1/dotnet-install.sh", script, signal);
  const r = win
    ? await runProc("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Channel", "8.0", "-InstallDir", dir, "-NoPath"], { signal, timeoutMs: 900_000, env })
    : await runProc("bash", [script, "--channel", "8.0", "--install-dir", dir, "--no-path"], { signal, timeoutMs: 900_000, env });
  await fsp.rm(script, { force: true });
  if (r.missing) throw new Error(win ? "PowerShell was not found, so the .NET SDK could not be installed" : "bash was not found, so the .NET SDK could not be installed");
  if (r.code !== 0) throw new Error(".NET SDK install failed: " + cleanOutput(r.stderr || r.stdout, 600) + (win ? "" : " (needs curl or wget)"));
  useManagedDotnet();
  return managedToolPath("dotnet");
}

async function installIlspy(signal?: AbortSignal): Promise<void> {
  const dir = path.dirname(managedToolPath("ilspycmd"));
  await fsp.rm(dir, { recursive: true, force: true });
  const dotnet = (await isMissing(resolveTool("dotnet"))) ? await installDotnet(signal) : resolveTool("dotnet");
  const r = await runProc(dotnet, ["tool", "install", "ilspycmd", "--tool-path", dir, "--version", ILSPY_VERSION], { signal, timeoutMs: 300_000, env });
  if (r.code !== 0) throw new Error("dotnet tool install failed: " + cleanOutput(r.stderr || r.stdout, 600));
}

/** Download and install one tool into <data>/tools. Returns the path to use. */
export function installTool(ctx: AppContext, name: ToolName, signal?: AbortSignal): Promise<string> {
  if (!INSTALLABLE.includes(name)) throw new UserError(`Unknown tool "${name}"`, 404);
  return locks.run("install:" + name, async () => {
    ctx.logger.child("tools").info(`installing ${name}`);
    try {
      await (name === "ilspycmd" ? installIlspy(signal) : installDepotDownloader(signal));
    } catch (e: any) {
      ctx.logger.child("tools").warn(`${name} install failed: ${e.message}`);
      throw e instanceof UserError ? e : new UserError(e.message, 502);
    }
    const p = managedToolPath(name);
    if (!fs.existsSync(p)) throw new Error(`${name} install finished but ${path.basename(p)} was not found`);
    return p;
  });
}

/**
 * Resolve a tool for a job. When it is missing and the setting still holds the default bare name,
 * download it once. A custom path is never replaced behind the user's back.
 */
export async function ensureTool(ctx: AppContext, name: ToolName, configured: string, log: (m: string) => void, signal?: AbortSignal): Promise<string> {
  let tool = resolveTool(configured);
  if (!(await isMissing(tool))) return tool;
  if (configured.replace(/[.]exe$/i, "") !== name) return tool;
  log(`${name} not found, downloading it`);
  await installTool(ctx, name, signal);
  tool = resolveTool(configured);
  log(`${name} installed`);
  return tool;
}
