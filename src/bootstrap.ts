import { EventEmitter } from "node:events";
import path from "node:path";
import fs from "node:fs";
import type { BootConfig } from "./config.js";
import type { AppContext } from "./context.js";
import type { Services } from "./services.js";
import { Db } from "./db.js";
import { Logger } from "./logger.js";
import { SettingsStore } from "./settings.js";
import { SecretBox } from "./util/crypto.js";
import { Watches } from "./watches.js";
import { Monitor } from "./monitor/service.js";
import { SteamManager, type ManifestSource } from "./steam/manager.js";
import { SteamAuth } from "./steam/auth.js";
import { NotificationWorker, type Sender } from "./notify/worker.js";
import { JobEngine } from "./jobs/engine.js";
import { fileURLToPath } from "node:url";
import { registerPathRoots } from "./util/redact.js";
import { setToolsDir } from "./util/proc.js";
import { useManagedDotnet } from "./tools.js";
import type { JobHandler, JobType } from "./jobs/types.js";

export interface Overrides {
  source?: ManifestSource;          // tests: deterministic Steam responses
  sender?: Sender;                  // tests: fake Discord
  handlers?: Partial<Record<JobType, JobHandler>>;
  quietLogs?: boolean;
  tickMs?: number;
}

export function createServices(boot: BootConfig, o: Overrides = {}): Services {
  fs.mkdirSync(boot.dataDir, { recursive: true });
  setToolsDir(path.join(boot.dataDir, "tools"));
  useManagedDotnet();
  const db = new Db(path.join(boot.dataDir, "manifesthound.db"));
  db.migrate();
  const box = SecretBox.load(boot.dataDir, boot.secretKey);
  const settings = new SettingsStore(db, boot.dataDir);
  const s = settings.get();
  const logger = new Logger(path.join(boot.dataDir, "logs"), boot.logLevel ?? s.logging.level, s.logging.retentionDays, !o.quietLogs);
  const ctx: AppContext = { boot, db, box, settings, logger, bus: new EventEmitter() };
  fs.mkdirSync(settings.workDir(), { recursive: true });
  // Host paths must never appear in logs, errors, API output or bundles: register them for placeholder substitution.
  const appRoot = fileURLToPath(new URL("../", import.meta.url));
  const refreshRoots = () => registerPathRoots([
    { path: boot.dataDir, label: "<data>" }, { path: settings.workDir(), label: "<work>" }, { path: appRoot, label: "<app>" },
    ...settings.get().paths.allowedRoots.map((p, i) => ({ path: p, label: `<root${i + 1}>` })),
  ]);
  refreshRoots();
  settings.onChange(refreshRoots);

  const steam = o.source ? null : new SteamManager(ctx);
  const steamAuth = steam ? new SteamAuth(ctx, steam) : null;
  const source = o.source ?? steam!;
  return {
    ctx, startedAt: Date.now(), steam, steamAuth,
    watches: new Watches(ctx),
    monitor: new Monitor(ctx, source, o.tickMs),
    notifier: new NotificationWorker(ctx, o.sender),
    jobs: new JobEngine(ctx, o.handlers),
  };
}

export function startServices(svc: Services) {
  svc.notifier.start();
  svc.jobs.start();
  svc.monitor.start();
}

export async function stopServices(svc: Services) {
  await svc.monitor.stop();
  svc.notifier.stop();
  await svc.jobs.stop();
  svc.steam?.shutdown();
  svc.ctx.logger.close();
  svc.ctx.db.close();
}
