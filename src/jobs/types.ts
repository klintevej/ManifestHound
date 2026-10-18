import path from "node:path";
import { z } from "zod";
import type { AppContext } from "../context.js";
import type { EventRecord } from "../events.js";
import type { Watch } from "../watches.js";
import { resolveInsideRoots, UserError, parseJson } from "../util/misc.js";
import { SelectionSchema, type Selection } from "./files.js";

export const JOB_TYPES = ["collect", "report", "archive", "decompile", "git"] as const;
export type JobType = (typeof JOB_TYPES)[number];

export interface JobDef {
  id: number; watchId: number | null; name: string; description: string | null; type: JobType; enabled: boolean; ord: number;
  depotFilter: string[]; timeoutSec: number; maxRetries: number; stopOnFail: boolean; outputDir: string | null; config: any;
  secrets: Record<string, string>;
}

export function rowToJobDef(ctx: AppContext, r: any): JobDef {
  let secrets: Record<string, string> = {};
  if (r.secrets_enc) { try { secrets = JSON.parse(ctx.box.decrypt(r.secrets_enc)); } catch { /* unreadable secrets => treated as unset */ } }
  return {
    id: r.id, watchId: r.watch_id, name: r.name, description: r.description, type: r.type, enabled: !!r.enabled, ord: r.ord,
    depotFilter: parseJson(r.depot_filter, []), timeoutSec: r.timeout_sec, maxRetries: r.max_retries, stopOnFail: !!r.stop_on_fail,
    outputDir: r.output_dir, config: parseJson(r.config_json, {}), secrets,
  };
}

export interface JobCtx {
  app: AppContext;
  def: JobDef;
  event: EventRecord;
  watch: Watch | null;
  runId: number;
  manual: boolean;
  attempt: number;
  signal: AbortSignal;
  outputDir: string;
  log: (msg: string) => void;
  /** Resolve a selection root (sourceJobId or explicit root) and confirm it lies inside allowed roots. */
  resolveRoot: (sel: Selection) => string;
}

export interface JobResult { summary: string; data?: Record<string, unknown> }
export type JobHandler = (c: JobCtx) => Promise<JobResult>;

const slug = (s: string) => s.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "job";
export { slug };

export function outputDirFor(app: AppContext, def: Pick<JobDef, "id" | "name" | "outputDir">, appId: number | null): string {
  const work = app.settings.workDir();
  if (def.outputDir) return resolveInsideRoots(def.outputDir, app.settings.roots(), work);
  return path.join(work, String(appId ?? "all"), `${slug(def.name)}-${def.id}`);
}

const WaitSchema = z.object({ acfPath: z.string().min(1), timeoutSec: z.number().int().min(1).max(86400).default(1800) });

/** Per-type config validation, run when a job is saved and again before it executes. */
export const ConfigSchemas: Record<JobType, z.ZodType<any>> = {
  collect: z.object({ selection: SelectionSchema, waitForBuild: WaitSchema.optional() }).prefault({}),
  report: z.object({ selection: SelectionSchema, waitForBuild: WaitSchema.optional() }).prefault({}),
  archive: z.object({
    selection: SelectionSchema,
    include: z.object({ files: z.boolean().default(true), metadata: z.boolean().default(true) }).prefault({}),
    destinationIds: z.array(z.number().int()).default([]),
    compressionLevel: z.number().int().min(0).max(9).default(6),
    waitForBuild: WaitSchema.optional(),
  }).prefault({}),
  decompile: z.object({
    selection: SelectionSchema,
    /** Important assemblies for this game: names or globs relative to the selection root. */
    assemblies: z.array(z.string().min(1)).default([]),
    languageVersion: z.string().regex(/^(CSharp\d+(_\d+)?|Preview|Latest)$/).default("Latest"),
    onExisting: z.enum(["versioned", "overwrite", "skip", "fail"]).default("versioned"),
    nestedDirectories: z.boolean().default(false),
    removeDeadCode: z.boolean().default(false),
    copyInputs: z.boolean().default(true),
    strict: z.boolean().default(false),
    waitForBuild: WaitSchema.optional(),
  }).prefault({}),
  git: z.object({
    repoPath: z.string().default(""),
    init: z.boolean().default(true),
    branch: z.string().regex(/^[\w][\w./-]*$/).default("main"),
    remoteName: z.string().regex(/^[\w.-]+$/).default("origin"),
    remoteUrl: z.string().default(""),
    push: z.boolean().default(false),
    authorName: z.string().default(""),
    authorEmail: z.string().default(""),
    credentialId: z.number().int().nullable().default(null),
    allowMetadataOnlyCommit: z.boolean().default(false),
    sources: z.array(z.object({
      path: z.string().default(""),
      sourceJobId: z.number().int().nullable().default(null),
      dest: z.string().default(""),
      mirror: z.boolean().default(true),
      include: z.array(z.string()).default([]),
      exclude: z.array(z.string()).default([]),
    })).default([]),
    metadataDir: z.string().default(""),
    waitForBuild: WaitSchema.optional(),
  }).prefault({}),
};

export function validateConfig(type: JobType, config: unknown) {
  const p = ConfigSchemas[type].safeParse(config ?? {});
  if (!p.success) throw new UserError("Invalid job config: " + p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return p.data;
}
