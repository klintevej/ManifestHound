import { spawn } from "node:child_process";
import { redactString } from "./redact.js";

export interface ProcResult { code: number | null; stdout: string; stderr: string; missing?: boolean }

/** Run an executable with an argument array (never a shell string). Output is capped; abort kills the process tree. */
export function runProc(cmd: string, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number; input?: string } = {}): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    if (/[\r\n\0]/.test(cmd)) return reject(new Error("Invalid executable path"));
    const max = o.maxBytes ?? 4 * 1024 * 1024;
    const child = spawn(cmd, args, { cwd: o.cwd, env: { ...process.env, ...o.env }, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", done = false;
    const finish = (r: ProcResult | Error) => {
      if (done) return; done = true; clearTimeout(timer); o.signal?.removeEventListener("abort", onAbort);
      r instanceof Error ? reject(r) : resolve(r);
    };
    const kill = () => {
      if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
      else child.kill("SIGKILL");
    };
    const onAbort = () => { kill(); finish(new Error("Process aborted")); };
    const timer = o.timeoutMs ? setTimeout(() => { kill(); finish(new Error(`Process timed out after ${o.timeoutMs}ms`)); }, o.timeoutMs) : undefined;
    if (o.signal?.aborted) return onAbort();
    o.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d) => { if (stdout.length < max) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < max) stderr += d; });
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") finish({ code: null, stdout, stderr: `Executable not found: ${cmd}`, missing: true });
      else finish(e);
    });
    child.on("close", (code) => finish({ code, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(o.input ?? "");
  });
}

export const cleanOutput = (s: string, n = 2000) => redactString(s.trim()).slice(-n);

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** "ilspycmd" is installed to ~/.dotnet/tools, which services (systemd, Task Scheduler) often lack on PATH. */
export function resolveTool(name: string): string {
  if (name !== "ilspycmd") return name;
  const p = path.join(os.homedir(), ".dotnet", "tools", process.platform === "win32" ? "ilspycmd.exe" : "ilspycmd");
  return fs.existsSync(p) ? p : name;
}
/** Case-insensitive only where the filesystem is (Windows). */
export const pkey = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
