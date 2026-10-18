import { EventEmitter } from "node:events";
import type { BootConfig } from "./config.js";
import type { Db } from "./db.js";
import type { Logger } from "./logger.js";
import type { SettingsStore } from "./settings.js";
import type { SecretBox } from "./util/crypto.js";

export interface AppContext {
  boot: BootConfig;
  db: Db;
  box: SecretBox;
  settings: SettingsStore;
  logger: Logger;
  /** Internal notifications: "event:created", "job:updated", "notification:updated", "watch:updated". */
  bus: EventEmitter;
}
