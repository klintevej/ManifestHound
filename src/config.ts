import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/** Bootstrap config: needed before the database opens. Env vars win over the JSON file. */
const BootSchema = z.object({
  host: z.string().min(1).default("127.0.0.1"),
  port: z.coerce.number().int().min(1).max(65535).default(4019),
  dataDir: z.string().min(1).default("./data"),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  adminPassword: z.string().min(8, "MH_ADMIN_PASSWORD must be at least 8 characters").optional(),
  secretKey: z.string().regex(/^[0-9a-f]{64}$/i, "MH_SECRET_KEY must be 64 hex characters").optional(),
  allowRemote: z.coerce.boolean().default(false),
});
export type BootConfig = Omit<z.infer<typeof BootSchema>, "dataDir"> & { dataDir: string; configFile: string };

export const CONFIG_FILE = "manifesthound.config.json";

export function loadBootConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): BootConfig {
  const configFile = path.resolve(cwd, env.MH_CONFIG ?? CONFIG_FILE);
  let file: Record<string, unknown> = {};
  if (fs.existsSync(configFile)) {
    try { file = JSON.parse(fs.readFileSync(configFile, "utf8")); }
    catch (e) { throw new Error(`Invalid JSON in ${configFile}: ${(e as Error).message}`); }
  }
  const pick = (envName: string, key: string) => env[envName] ?? (file[key] as string | undefined);
  const parsed = BootSchema.safeParse({
    host: pick("MH_HOST", "host"),
    port: pick("MH_PORT", "port"),
    dataDir: pick("MH_DATA_DIR", "dataDir"),
    logLevel: pick("MH_LOG_LEVEL", "logLevel"),
    adminPassword: env.MH_ADMIN_PASSWORD || undefined,
    secretKey: env.MH_SECRET_KEY || undefined,
    allowRemote: pick("MH_ALLOW_REMOTE", "allowRemote") ?? false,
  });
  if (!parsed.success) {
    throw new Error("Invalid configuration:\n" + parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n"));
  }
  const c = parsed.data;
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(c.host);
  if (!loopback && !c.allowRemote) {
    throw new Error(`Refusing to bind to non-loopback address "${c.host}" without MH_ALLOW_REMOTE=true. See docs/SECURITY.md.`);
  }
  return { ...c, dataDir: path.resolve(cwd, c.dataDir), configFile };
}

/** Persist network settings to the JSON config file (applied on next start). */
export function writeNetworkConfig(configFile: string, patch: { host?: string; port?: number; allowRemote?: boolean }) {
  let cur: Record<string, unknown> = {};
  try { cur = JSON.parse(fs.readFileSync(configFile, "utf8")); } catch { /* new file */ }
  fs.writeFileSync(configFile, JSON.stringify({ ...cur, ...patch }, null, 2));
}
