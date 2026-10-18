import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { AppContext } from "../context.js";
import { UserError, nowIso } from "../util/misc.js";
import type { SteamManager } from "./manager.js";

const require = createRequire(import.meta.url);
const { LoginSession, EAuthTokenPlatformType, EAuthSessionGuardType } = require("steam-session");

const GUARD_NAMES: Record<number, string> = {
  [EAuthSessionGuardType.EmailCode]: "email_code",
  [EAuthSessionGuardType.DeviceCode]: "device_code",
  [EAuthSessionGuardType.DeviceConfirmation]: "device_confirmation",
  [EAuthSessionGuardType.EmailConfirmation]: "email_confirmation",
};

interface Pending {
  session: any;
  accountName: string;
  username: string;
  state: "waiting" | "authenticated" | "failed";
  error?: string;
  actions: { type: string; detail?: string }[];
  expires: number;
  accountId?: number;
}

/**
 * Interactive Steam sign-in using steam-session (Valve's documented auth-session flow).
 * The password is passed to Steam and never stored or logged; only the resulting refresh token is kept (encrypted).
 */
export class SteamAuth {
  private pending = new Map<string, Pending>();
  constructor(private ctx: AppContext, private steam: SteamManager) {}

  private sweep() {
    for (const [id, p] of this.pending) if (p.expires < Date.now()) { try { p.session.cancelLoginAttempt(); } catch { /* ignore */ } this.pending.delete(id); }
  }

  async start(input: { name: string; username: string; password: string }) {
    this.sweep();
    if (!input.name?.trim() || !input.username?.trim() || !input.password) throw new UserError("name, username and password are required");
    const session = new LoginSession(EAuthTokenPlatformType.SteamClient);
    const p: Pending = { session, accountName: input.name.trim(), username: input.username.trim(), state: "waiting", actions: [], expires: Date.now() + 5 * 60_000 };
    const id = randomUUID();
    this.pending.set(id, p);
    session.on("authenticated", () => this.finish(p));
    session.on("timeout", () => { p.state = "failed"; p.error = "Login timed out"; });
    session.on("error", (e: Error) => { p.state = "failed"; p.error = e.message; });
    try {
      const r = await session.startWithCredentials({ accountName: p.username, password: input.password });
      if (r.actionRequired) {
        p.actions = (r.validActions ?? []).map((a: any) => ({ type: GUARD_NAMES[a.type] ?? String(a.type), detail: a.detailMessage }));
      } else if (p.state === "waiting") {
        await this.finish(p); // some flows authenticate immediately
      }
    } catch (e) {
      this.pending.delete(id);
      throw new UserError(`Steam rejected the sign-in: ${(e as Error).message}`);
    }
    return { pendingId: id, ...this.view(p) };
  }

  async submitCode(id: string, code: string) {
    const p = this.pending.get(id);
    if (!p) throw new UserError("Sign-in attempt not found or expired", 404);
    if (!/^[A-Za-z0-9]{4,10}$/.test(code ?? "")) throw new UserError("Invalid code format");
    try { await p.session.submitSteamGuardCode(code); }
    catch (e) { throw new UserError(`Steam rejected the code: ${(e as Error).message}`); }
    return this.view(p);
  }

  status(id: string) {
    const p = this.pending.get(id);
    if (!p) throw new UserError("Sign-in attempt not found or expired", 404);
    return this.view(p);
  }

  cancel(id: string) {
    const p = this.pending.get(id);
    if (p) { try { p.session.cancelLoginAttempt(); } catch { /* ignore */ } this.pending.delete(id); }
  }

  private view(p: Pending) {
    return { state: p.state, error: p.error, actions: p.actions, accountId: p.accountId };
  }

  private async finish(p: Pending) {
    if (p.state === "authenticated") return;
    try {
      const token: string = p.session.refreshToken;
      const enc = this.ctx.box.encrypt(token);
      const existing = this.ctx.db.get("SELECT id FROM accounts WHERE name=?", p.accountName);
      let id: number;
      if (existing) {
        id = existing.id;
        this.ctx.db.run("UPDATE accounts SET username=?, refresh_token_enc=?, status='valid', status_detail=NULL, last_validated_at=? WHERE id=?", p.username, enc, nowIso(), id);
      } else {
        id = this.ctx.db.run("INSERT INTO accounts(name,username,refresh_token_enc,status,last_validated_at,created_at) VALUES(?,?,?,?,?,?)",
          p.accountName, p.username, enc, "valid", nowIso(), nowIso()).lastId;
      }
      this.ctx.db.run("UPDATE accounts SET steam_id=? WHERE id=?", String(p.session.steamID ?? ""), id);
      this.steam.drop(id);
      p.accountId = id;
      p.state = "authenticated";
      p.actions = [];
      this.ctx.logger.child("steam-auth").info("Account authenticated", { account: p.accountName });
    } catch (e) {
      p.state = "failed";
      p.error = (e as Error).message;
    }
  }

  /** Decode refresh-token expiry (JWT exp) without trusting it for security, only for UI status. */
  static tokenExpiry(token: string): number | null {
    try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).exp * 1000; } catch { return null; }
  }

  /** Re-evaluate stored accounts: mark expired when the refresh token's exp has passed. */
  refreshStatuses() {
    for (const a of this.ctx.db.all("SELECT id, refresh_token_enc, status FROM accounts WHERE refresh_token_enc IS NOT NULL")) {
      try {
        const exp = SteamAuth.tokenExpiry(this.ctx.box.decrypt(a.refresh_token_enc));
        if (exp && exp < Date.now() && a.status !== "expired") {
          this.ctx.db.run("UPDATE accounts SET status='expired', status_detail='Refresh token expired. Sign in again.', last_validated_at=? WHERE id=?", nowIso(), a.id);
        }
      } catch { this.ctx.db.run("UPDATE accounts SET status='error', status_detail='Stored token cannot be decrypted' WHERE id=?", a.id); }
    }
  }
}
