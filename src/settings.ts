import path from "node:path";
import { z } from "zod";
import type { Db } from "./db.js";
import { UserError } from "./util/misc.js";

export const DEFAULT_TEMPLATE =
  "**{game_name}** (App ID: {app_id}) has updated!\nBuild: {build_id}\nManifest: {manifest_ids}\nUpdated: {timestamp:F} ({timestamp:R})";

export const SettingsSchema = z.object({
  polling: z.object({
    defaultIntervalSec: z.number().int().min(5).max(86400).default(60),
    minIntervalSec: z.number().int().min(1).max(3600).default(10),
    baselineOnFirstCheck: z.boolean().default(true),
    maxConcurrentChecks: z.number().int().min(1).max(20).default(3),
    failureAlertThreshold: z.number().int().min(1).default(5),
  }).prefault({}),
  steam: z.object({
    requestTimeoutMs: z.number().int().min(2000).max(120000).default(30000),
    retries: z.number().int().min(0).max(10).default(2),
    minRequestGapMs: z.number().int().min(0).default(500),
    usePublicFallback: z.boolean().default(false),
    publicFallbackUrl: z.string().default("https://api.steamcmd.net/v1/info/{appid}"),
  }).prefault({}),
  notifications: z.object({
    defaultWebhookId: z.number().int().nullable().default(null),
    template: z.string().max(4000).default(DEFAULT_TEMPLATE),
    timezone: z.string().default("UTC"),
    timeMode: z.enum(["utc", "local"]).default("utc"),
    manifestFormat: z.string().default("{depot_id}: {manifest_id}"),
    useEmbed: z.boolean().default(false),
    allowCustomWebhookHosts: z.boolean().default(false),
    maxAttempts: z.number().int().min(1).max(20).default(6),
  }).prefault({}),
  paths: z.object({
    workDir: z.string().default(""),            // empty => <dataDir>/work
    allowedRoots: z.array(z.string()).default([]),
  }).prefault({}),
  jobs: z.object({
    maxConcurrent: z.number().int().min(1).max(16).default(2),
    defaultTimeoutSec: z.number().int().min(5).default(1800),
    keepRunLogDays: z.number().int().min(1).default(90),
  }).prefault({}),
  git: z.object({
    gitPath: z.string().default("git"),
    authorName: z.string().trim().min(1).max(100).default("ManifestHound"),
    authorEmail: z.string().regex(/^[^\s@]+@[^\s@]+$/, "must look like name@host").default("manifesthound@localhost"),
  }).prefault({}),
  tools: z.object({
    ilspyCmdPath: z.string().default("ilspycmd"),
    depotDownloaderPath: z.string().default("DepotDownloader"),
  }).prefault({}),
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    retentionDays: z.number().int().min(1).max(3650).default(14),
  }).prefault({}),
  security: z.object({
    sessionTtlHours: z.number().int().min(1).max(720).default(12),
    publicBaseUrl: z.string().default(""),       // used for dashboard links in notifications
  }).prefault({}),
});
export type Settings = z.infer<typeof SettingsSchema>;

export class SettingsStore {
  private cache: Settings;
  private listeners: ((s: Settings) => void)[] = [];
  constructor(private db: Db, private dataDir: string) {
    this.cache = this.load();
  }
  private load(): Settings {
    const raw: Record<string, unknown> = {};
    for (const r of this.db.all("SELECT key, value FROM settings")) {
      try { raw[r.key] = JSON.parse(r.value); } catch { /* ignore corrupt value, fall back to default */ }
    }
    const p = SettingsSchema.safeParse(raw);
    return p.success ? p.data : SettingsSchema.parse({});
  }
  get(): Settings { return this.cache; }
  onChange(fn: (s: Settings) => void) { this.listeners.push(fn); }
  workDir(): string {
    return path.resolve(this.cache.paths.workDir || path.join(this.dataDir, "work"));
  }
  /** Allowed roots for file operations: work dir plus user-configured roots. */
  roots(): string[] {
    return [this.workDir(), ...this.cache.paths.allowedRoots.map((r) => path.resolve(r))];
  }
  /** Deep-merge a partial update, validate, persist. */
  update(patch: unknown): Settings {
    if (!patch || typeof patch !== "object") throw new UserError("Settings patch must be an object");
    const merged = deepMerge(structuredClone(this.cache), patch as Record<string, unknown>);
    const p = SettingsSchema.safeParse(merged);
    if (!p.success) throw new UserError("Invalid settings: " + p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    this.db.tx(() => {
      for (const [k, v] of Object.entries(p.data)) {
        this.db.run("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", k, JSON.stringify(v));
      }
    });
    this.cache = p.data;
    this.listeners.forEach((l) => l(this.cache));
    return this.cache;
  }
}

function deepMerge(a: any, b: any): any {
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object") a[k] = deepMerge(a[k], v);
    else a[k] = v;
  }
  return a;
}
