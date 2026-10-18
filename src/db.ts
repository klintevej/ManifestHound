import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export type Row = Record<string, any>;

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  refresh_token_enc TEXT,
  steam_id TEXT,
  status TEXT NOT NULL DEFAULT 'unauthenticated', -- unauthenticated | valid | expired | error
  status_detail TEXT,
  last_validated_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  url_enc TEXT NOT NULL,
  username TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE destinations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,                 -- sftp | s3 | http | local
  config_json TEXT NOT NULL,          -- non-secret fields
  secrets_enc TEXT,                   -- encrypted JSON of secret fields
  allow_private INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  icon_url TEXT,
  follow_mode TEXT NOT NULL DEFAULT 'build',   -- build | depots | all
  depot_ids TEXT NOT NULL DEFAULT '[]',
  branch TEXT NOT NULL DEFAULT 'public',
  interval_sec INTEGER NOT NULL DEFAULT 60,
  enabled INTEGER NOT NULL DEFAULT 1,
  baseline_first INTEGER NOT NULL DEFAULT 1,
  account_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | ok | error | paused
  last_check_at TEXT,
  last_success_at TEXT,
  last_update_at TEXT,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  notify_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE watch_state (
  watch_id INTEGER PRIMARY KEY,
  build_id TEXT,
  time_updated INTEGER,
  depots_json TEXT NOT NULL DEFAULT '{}',
  initialized_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  watch_id INTEGER,
  app_id INTEGER NOT NULL,
  game_name TEXT NOT NULL,
  kind TEXT NOT NULL,                -- baseline | update | rollback
  dedupe_key TEXT NOT NULL UNIQUE,
  detected_at TEXT NOT NULL,
  update_time TEXT,
  prev_build TEXT,
  new_build TEXT,
  changes_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_events_watch ON events(watch_id, detected_at DESC);
CREATE INDEX ix_events_detected ON events(detected_at DESC);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  webhook_id INTEGER,
  status TEXT NOT NULL,              -- pending | sending | delivered | failed | suppressed
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  http_status INTEGER,
  delivered_at TEXT,
  detail TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(event_id, webhook_id)
);
CREATE INDEX ix_notif_due ON notifications(status, next_attempt_at);

CREATE TABLE job_defs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id INTEGER,                  -- NULL = applies to every watch
  name TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL,                -- collect | report | archive | decompile | git
  enabled INTEGER NOT NULL DEFAULT 1,
  ord INTEGER NOT NULL DEFAULT 10,   -- equal ord => may run in parallel; lower runs first
  depot_filter TEXT NOT NULL DEFAULT '[]',
  timeout_sec INTEGER NOT NULL DEFAULT 1800,
  max_retries INTEGER NOT NULL DEFAULT 1,
  stop_on_fail INTEGER NOT NULL DEFAULT 0,
  output_dir TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  secrets_enc TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  job_id INTEGER NOT NULL,
  job_name TEXT NOT NULL,
  ord INTEGER NOT NULL,
  status TEXT NOT NULL,              -- queued | running | succeeded | failed | skipped | cancelled
  attempts INTEGER NOT NULL DEFAULT 0,
  manual INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  log TEXT NOT NULL DEFAULT '',
  error TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_run_auto ON job_runs(event_id, job_id) WHERE manual = 0;
CREATE INDEX ix_runs_status ON job_runs(status, next_attempt_at);
CREATE INDEX ix_runs_event ON job_runs(event_id);

CREATE TABLE file_snapshots (
  job_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  PRIMARY KEY (job_id, path)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
`,
  },
  {
    version: 2,
    sql: `
CREATE TABLE git_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,             -- pat | password
  username TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`,
  },
  {
    version: 3,
    sql: `
ALTER TABLE accounts ADD COLUMN password_enc TEXT; -- optional, only when the user chose to save it for DepotDownloader
`,
  },
];

export class Db {
  raw: DatabaseSync;
  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
  }

  migrate(): number {
    this.raw.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const done = new Set(this.all("SELECT version FROM schema_migrations").map((r) => r.version as number));
    let applied = 0;
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      this.tx(() => {
        this.raw.exec(m.sql);
        this.run("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)", m.version, new Date().toISOString());
      });
      applied++;
    }
    return applied;
  }

  get<T extends Row = Row>(sql: string, ...p: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...p) as T | undefined;
  }
  all<T extends Row = Row>(sql: string, ...p: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...p) as T[];
  }
  run(sql: string, ...p: SQLInputValue[]) {
    const r = this.raw.prepare(sql).run(...p);
    return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
  }

  private depth = 0;
  /** Synchronous transaction (nested calls join the outer one). */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.raw.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const r = fn();
      this.raw.exec("COMMIT");
      return r;
    } catch (e) {
      try { this.raw.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw e;
    } finally { this.depth--; }
  }

  close() { try { this.raw.close(); } catch { /* ignore */ } }
}
