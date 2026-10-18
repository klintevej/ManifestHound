import path from "node:path";
import fs from "node:fs";
import { randomInt } from "node:crypto";

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
  });

/** Exponential backoff with full jitter. attempt starts at 1. */
export function backoffMs(attempt: number, baseMs = 1000, capMs = 5 * 60_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  return Math.floor(exp / 2 + randomInt(0, Math.max(1, Math.floor(exp / 2))));
}

export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { retries: number; baseMs?: number; capMs?: number; shouldRetry?: (e: unknown) => boolean; signal?: AbortSignal },
): Promise<T> {
  let attempt = 0;
  for (;;) {
    attempt++;
    try { return await fn(attempt); }
    catch (e) {
      if (attempt > opts.retries || (opts.shouldRetry && !opts.shouldRetry(e))) throw e;
      await sleep(backoffMs(attempt, opts.baseMs, opts.capMs), opts.signal);
    }
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

/** Keyed async mutex: serialises tasks sharing a key. */
export class KeyedLock {
  private tails = new Map<string, Promise<unknown>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.tails.set(key, next);
    try { return await next; }
    finally { if (this.tails.get(key) === next) this.tails.delete(key); }
  }
}

export class UserError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = "UserError"; }
}

const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

export function isInside(root: string, target: string): boolean {
  const r = path.resolve(root), t = path.resolve(target);
  const rel = path.relative(norm(r), norm(t));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Resolve `p` (absolute, or relative to `base`) and require it to live inside one of `roots`. Follows symlinks when the path exists. */
export function resolveInsideRoots(p: string, roots: string[], base?: string): string {
  if (p.includes("\0")) throw new UserError("Invalid path");
  const abs = path.resolve(base ?? roots[0] ?? ".", p);
  const real = realpathLoose(abs);
  const ok = roots.some((r) => isInside(realpathLoose(path.resolve(r)), real));
  if (!ok) throw new UserError(`Path is outside the allowed directories: ${abs}`, 403);
  return abs;
}

/** realpath of the deepest existing ancestor + remaining segments. */
export function realpathLoose(p: string): string {
  const rest: string[] = [];
  let cur = path.resolve(p);
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...rest.reverse()); }
    catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** Join an untrusted relative path under base, rejecting traversal. */
export function safeJoin(base: string, rel: string): string {
  const out = path.resolve(base, rel);
  if (!isInside(base, out)) throw new UserError(`Path traversal rejected: ${rel}`, 403);
  return out;
}

export const nowIso = () => new Date().toISOString();
export const json = (v: unknown) => JSON.stringify(v);
export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}
