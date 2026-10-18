import type { AppContext } from "./context.js";
import type { Monitor } from "./monitor/service.js";
import type { SteamManager } from "./steam/manager.js";
import type { SteamAuth } from "./steam/auth.js";
import type { NotificationWorker } from "./notify/worker.js";
import type { JobEngine } from "./jobs/engine.js";
import type { Watches } from "./watches.js";

export interface Services {
  ctx: AppContext;
  watches: Watches;
  monitor: Monitor;
  steam: SteamManager | null;
  steamAuth: SteamAuth | null;
  notifier: NotificationWorker;
  jobs: JobEngine;
  startedAt: number;
}
