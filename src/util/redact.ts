const SECRET_KEY = /pass(word)?|token|secret|authorization|cookie|api[-_]?key|private[-_]?key|webhook|credential|guard/i;
const PATTERNS: [RegExp, string][] = [
  [/https?:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/[^\s"'<>]+/gi, "[REDACTED_WEBHOOK]"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, "[REDACTED_JWT]"],
  [/(authorization:\s*(?:basic|bearer)\s+)[^\s"']+/gi, "$1[REDACTED]"],
  [/(https?:\/\/[^\/\s:@]+:)[^@\s\/]+@/gi, "$1[REDACTED]@"],
];

export function redactString(s: string): string {
  let out = scrubPaths(s);
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/** Deep-copy `v`, masking values under secret-looking keys and secret-looking substrings. */
export function redact<T>(v: T, depth = 0): T {
  if (depth > 8) return "[depth]" as unknown as T;
  if (typeof v === "string") return redactString(v) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1)) as unknown as T;
  if (v instanceof Error) return { name: v.name, message: redactString(v.message), stack: v.stack ? redactString(v.stack) : undefined } as unknown as T;
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      o[k] = SECRET_KEY.test(k) && val != null && val !== "" ? "[REDACTED]" : redact(val, depth + 1);
    }
    return o as T;
  }
  return v;
}

// ---- filesystem path scrubbing -------------------------------------------------------------
// Anything that leaves the process boundary of a trusted admin session (logs, job logs, error messages,
// diagnostics bundles, API error bodies) goes through redactString, which also masks host paths so the
// machine's directory layout and account names never leak.
import os from "node:os";
import path from "node:path";

const WIN = process.platform === "win32";
let rootRules: { re: RegExp; label: string }[] = [];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Match a path in either slash style (and any case on Windows). */
function pathRegExp(p: string): RegExp {
  const abs = path.resolve(p);
  const parts = abs.split(/[\\/]+/).filter(Boolean).map(escapeRe);
  const lead = /^[\\/]/.test(abs) ? "[\\\\/]+" : "";
  return new RegExp(lead + parts.join("[\\\\/]+") + "(?=[\\\\/]|$|[^\\w.-])", WIN ? "gi" : "g");
}

/** Register host directories to be replaced by placeholders. Longest paths win. Call at startup and when settings change. */
export function registerPathRoots(named: { path: string; label: string }[]) {
  const all = [
    ...named,
    { path: process.cwd(), label: "<app>" },
    { path: os.tmpdir(), label: "<tmp>" },
    { path: os.homedir(), label: "<home>" },
  ].filter((n) => n.path && path.resolve(n.path).length > 1);
  rootRules = all.sort((a, b) => path.resolve(b.path).length - path.resolve(a.path).length).map((n) => ({ re: pathRegExp(n.path), label: n.label }));
}

const GENERIC_HOME: [RegExp, string][] = [
  [/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'<>|:*?]+/gi, "<home>"],
  [/(?<![\w.])\/home\/[^\/\s"'<>|:\\]+/g, "<home>"],
  [/(?<![\w.])\/Users\/[^\/\s"'<>|:\\]+/g, "<home>"],
];

export function scrubPaths(s: string): string {
  let out = s;
  for (const r of rootRules) out = out.replace(r.re, r.label);
  for (const [re, label] of GENERIC_HOME) out = out.replace(re, label);
  return out;
}

/** Deep-scrub every string in a JSON-like value (used for API responses that may carry host paths). */
export function scrubDeep<T>(v: T, depth = 0): T {
  if (depth > 12) return v;
  if (typeof v === "string") return scrubPaths(v) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, depth + 1)) as unknown as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, scrubDeep(x, depth + 1)])) as T;
  return v;
}

/** True if `s` contains one of THIS machine's registered directories (data, work, app, allowed roots, tmp, home). */
export function containsHostPath(s: string): boolean {
  return rootRules.some((r) => new RegExp(r.re.source, r.re.flags.replace("g", "")).test(s));
}
