import fs from "node:fs";
import path from "node:path";
import { redact } from "./util/redact.js";

export type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogEntry { ts: string; level: Level; component: string; msg: string; [k: string]: unknown }

/** JSON-lines logger with daily rotation, retention purge, a recent-entries ring buffer and secret redaction. */
export class Logger {
  private ring: LogEntry[] = [];
  private currentDay = "";
  private fd: number | null = null;
  constructor(public dir: string | null, public level: Level = "info", public retentionDays = 14, private echo = true) {
    if (dir) { fs.mkdirSync(dir, { recursive: true }); this.purge(); }
  }

  child(component: string) {
    const emit = (level: Level, msg: string, data?: Record<string, unknown>) => this.write(level, component, msg, data);
    return {
      debug: (m: string, d?: Record<string, unknown>) => emit("debug", m, d),
      info: (m: string, d?: Record<string, unknown>) => emit("info", m, d),
      warn: (m: string, d?: Record<string, unknown>) => emit("warn", m, d),
      error: (m: string, d?: Record<string, unknown>) => emit("error", m, d),
    };
  }

  recent(n = 200, minLevel: Level = "debug"): LogEntry[] {
    return this.ring.filter((e) => ORDER[e.level] >= ORDER[minLevel]).slice(-n);
  }

  write(level: Level, component: string, msg: string, data?: Record<string, unknown>) {
    if (ORDER[level] < ORDER[this.level]) return;
    const entry = redact({ ts: new Date().toISOString(), level, component, msg: String(msg), ...data }) as LogEntry;
    this.ring.push(entry);
    if (this.ring.length > 1000) this.ring.shift();
    const line = JSON.stringify(entry);
    if (this.echo) (level === "error" ? process.stderr : process.stdout).write(line + "\n");
    if (this.dir) {
      try {
        const day = entry.ts.slice(0, 10);
        if (day !== this.currentDay) { this.closeFile(); this.currentDay = day; this.purge(); }
        this.fd ??= fs.openSync(path.join(this.dir, `manifesthound-${day}.log`), "a");
        fs.writeSync(this.fd, line + "\n");
      } catch { /* logging must never crash the app */ }
    }
  }

  purge() {
    if (!this.dir) return;
    const cutoff = Date.now() - this.retentionDays * 86_400_000;
    for (const f of fs.readdirSync(this.dir)) {
      if (!/^manifesthound-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
      const p = path.join(this.dir, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch { /* ignore */ }
    }
  }

  closeFile() { if (this.fd !== null) { try { fs.closeSync(this.fd); } catch { /* ignore */ } this.fd = null; } }
  close() { this.closeFile(); }
}

export type Log = ReturnType<Logger["child"]>;
