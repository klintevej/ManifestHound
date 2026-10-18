import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Request, Response, NextFunction } from "express";
import type { AppContext } from "../context.js";
import { hashPassword, verifyPassword } from "../util/crypto.js";
import { UserError } from "../util/misc.js";

const COOKIE = "mh_session";

const parseCookies = (h?: string) => Object.fromEntries((h ?? "").split(";").map((p) => p.trim().split("=")).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]));

export class AuthService {
  private fails = new Map<string, { n: number; until: number }>();
  constructor(private ctx: AppContext) {}

  /** Ensure an admin password exists. Env var wins; otherwise one is generated once and written to the data dir. */
  init(): { generated?: string } {
    if (this.ctx.boot.adminPassword) return {};
    if (this.ctx.db.get("SELECT 1 FROM settings WHERE key='_admin_hash'")) return {};
    const pw = randomBytes(15).toString("base64url");
    this.ctx.db.run("INSERT INTO settings(key,value) VALUES('_admin_hash',?)", JSON.stringify(hashPassword(pw)));
    const f = path.join(this.ctx.boot.dataDir, "initial-admin-password.txt");
    fs.writeFileSync(f, `${pw}\n`, { mode: 0o600 });
    return { generated: pw };
  }

  checkPassword(pw: string): boolean {
    const env = this.ctx.boot.adminPassword;
    if (env) {
      const a = Buffer.from(pw), b = Buffer.from(env);
      return a.length === b.length && timingSafeEqual(a, b);
    }
    const row = this.ctx.db.get("SELECT value FROM settings WHERE key='_admin_hash'");
    return !!row && verifyPassword(pw, JSON.parse(row.value));
  }

  changePassword(current: string, next: string) {
    if (this.ctx.boot.adminPassword) throw new UserError("The password is set via MH_ADMIN_PASSWORD; change it there");
    if (!this.checkPassword(current)) throw new UserError("Current password is incorrect", 403);
    if (next.length < 10) throw new UserError("New password must be at least 10 characters");
    this.ctx.db.run("INSERT INTO settings(key,value) VALUES('_admin_hash',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(hashPassword(next)));
    this.ctx.db.run("DELETE FROM sessions");
    fs.rmSync(path.join(this.ctx.boot.dataDir, "initial-admin-password.txt"), { force: true });
  }

  login(req: Request, res: Response, password: string) {
    const ip = req.socket.remoteAddress ?? "?";
    const f = this.fails.get(ip);
    if (f && f.until > Date.now() && f.n >= 5) throw new UserError("Too many failed attempts. Try again in a few minutes.", 429);
    if (!this.checkPassword(password ?? "")) {
      const n = (f && f.until > Date.now() ? f.n : 0) + 1;
      this.fails.set(ip, { n, until: Date.now() + 5 * 60_000 });
      this.ctx.logger.child("auth").warn("Failed dashboard login", { ip });
      throw new UserError("Incorrect password", 401);
    }
    this.fails.delete(ip);
    const id = randomBytes(32).toString("base64url"), csrf = randomBytes(24).toString("base64url");
    const ttl = this.ctx.settings.get().security.sessionTtlHours * 3600_000;
    this.ctx.db.run("DELETE FROM sessions WHERE expires_at<?", Date.now());
    this.ctx.db.run("INSERT INTO sessions(id,csrf,expires_at) VALUES(?,?,?)", id, csrf, Date.now() + ttl);
    res.cookie(COOKIE, id, { httpOnly: true, sameSite: "strict", path: "/", maxAge: ttl, secure: req.secure });
    return { csrf };
  }

  logout(req: Request, res: Response) {
    const id = parseCookies(req.headers.cookie)[COOKIE];
    if (id) this.ctx.db.run("DELETE FROM sessions WHERE id=?", id);
    res.clearCookie(COOKIE, { path: "/" });
  }

  session(req: Request): { csrf: string } | null {
    const id = parseCookies(req.headers.cookie)[COOKIE];
    if (!id) return null;
    const s = this.ctx.db.get("SELECT csrf, expires_at FROM sessions WHERE id=?", id);
    return s && s.expires_at > Date.now() ? { csrf: s.csrf } : null;
  }

  /** Require a valid session; for state-changing methods also require the CSRF token header and a same-origin Origin. */
  middleware = (req: Request, res: Response, next: NextFunction) => {
    const s = this.session(req);
    if (!s) return void res.status(401).json({ error: "Authentication required" });
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const given = String(req.headers["x-csrf-token"] ?? "");
      const a = Buffer.from(given), b = Buffer.from(s.csrf);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return void res.status(403).json({ error: "Missing or invalid CSRF token" });
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return void res.status(403).json({ error: "Cross-origin request rejected" });
    }
    (req as any).csrf = s.csrf;
    next();
  };
}
