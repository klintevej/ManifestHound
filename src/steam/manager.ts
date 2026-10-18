import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import type { AppContext } from "../context.js";
import { parseAppInfo, SteamDataError, type AppSnapshot } from "./appinfo.js";
import { fetchPublicMirror } from "./store.js";
import { retry, withTimeout, sleep } from "../util/misc.js";

const require = createRequire(import.meta.url);
const SteamUser = require("steam-user");

export interface FetchRequest { appId: number; branch: string; accountId: number | null }
/** Anything that can report an app's build and depot manifests. Production: SteamManager. Tests: fakes. */
export interface ManifestSource { fetch(req: FetchRequest): Promise<AppSnapshot> }

interface Entry { client: any; loggedOn: boolean; waiters: ((e?: Error) => void)[]; accountId: number | null }

/** Maintains one Steam client connection per account (plus one anonymous) and serves PICS app-info requests. */
export class SteamManager implements ManifestSource {
  private entries = new Map<string, Entry>();
  private chain: Promise<unknown> = Promise.resolve();
  private lastReq = 0;
  private log;
  constructor(private ctx: AppContext) { this.log = ctx.logger.child("steam"); }

  private key(accountId: number | null) { return accountId == null ? "anon" : `acct:${accountId}`; }

  private async connect(accountId: number | null): Promise<Entry> {
    const k = this.key(accountId);
    let e = this.entries.get(k);
    if (!e) {
      const dataDirectory = path.join(this.ctx.boot.dataDir, "steam");
      fs.mkdirSync(dataDirectory, { recursive: true });
      const client = new SteamUser({ dataDirectory, autoRelogin: true, enablePicsCache: false });
      e = { client, loggedOn: false, waiters: [], accountId };
      this.entries.set(k, e);
      const entry = e;
      client.on("loggedOn", () => { entry.loggedOn = true; entry.waiters.splice(0).forEach((w) => w()); this.log.info("Steam logged on", { account: accountId ?? "anonymous" }); if (accountId != null) this.markAccount(accountId, "valid", null); });
      client.on("disconnected", (_r: number, msg: string) => { entry.loggedOn = false; this.log.warn("Steam disconnected", { msg }); });
      client.on("error", (err: any) => {
        entry.loggedOn = false;
        this.log.error("Steam client error", { msg: err?.message, eresult: err?.eresult });
        const auth = [SteamUser.EResult.AccessDenied, SteamUser.EResult.InvalidPassword, SteamUser.EResult.Expired, SteamUser.EResult.Revoked, SteamUser.EResult.InvalidLoginAuthCode]
          .includes(err?.eresult);
        if (accountId != null) this.markAccount(accountId, auth ? "expired" : "error", err?.message ?? "Steam error");
        entry.waiters.splice(0).forEach((w) => w(new SteamDataError(`Steam login failed: ${err?.message ?? err}`, !auth)));
        this.entries.delete(k);
        try { client.logOff(); } catch { /* ignore */ }
      });
      if (accountId == null) client.logOn({ anonymous: true });
      else {
        const row = this.ctx.db.get("SELECT refresh_token_enc FROM accounts WHERE id=?", accountId);
        if (!row?.refresh_token_enc) { this.entries.delete(k); throw new SteamDataError(`Account ${accountId} is not authenticated. Sign in under Settings > Steam accounts.`); }
        client.logOn({ renewRefreshTokens: false, refreshToken: this.ctx.box.decrypt(row.refresh_token_enc) });
      }
    }
    if (!e.loggedOn) {
      const entry = e;
      await withTimeout(new Promise<void>((res, rej) => entry.waiters.push((err) => (err ? rej(err) : res()))), 45_000, "Steam logon");
    }
    return e;
  }

  private markAccount(id: number, status: string, detail: string | null) {
    this.ctx.db.run("UPDATE accounts SET status=?, status_detail=?, last_validated_at=? WHERE id=?", status, detail, new Date().toISOString(), id);
  }

  /** Disconnect an account's client (after sign-out or token replacement). */
  drop(accountId: number) {
    const k = this.key(accountId);
    const e = this.entries.get(k);
    if (e) { this.entries.delete(k); try { e.client.logOff(); } catch { /* ignore */ } }
  }

  /** Serialise PICS calls and keep a minimum gap between them. */
  private throttled<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      const gap = this.ctx.settings.get().steam.minRequestGapMs;
      const wait = this.lastReq + gap - Date.now();
      if (wait > 0) await sleep(wait);
      try { return await fn(); } finally { this.lastReq = Date.now(); }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  async fetch(req: FetchRequest): Promise<AppSnapshot> {
    const s = this.ctx.settings.get().steam;
    try {
      return await retry(
        () => this.throttled(async () => {
          const e = await this.connect(req.accountId);
          const r: any = await withTimeout(e.client.getProductInfo([req.appId], [], true) as Promise<any>, s.requestTimeoutMs, "PICS request");
          const app = r.apps?.[req.appId];
          if (!app) throw new SteamDataError(`Steam returned no data for app ${req.appId} (unknown app, or an account that owns it is required)`);
          return parseAppInfo(req.appId, app.appinfo, req.branch, req.accountId == null ? "pics-anonymous" : "pics-account");
        }),
        { retries: s.retries, baseMs: 1500, shouldRetry: (err) => !(err instanceof SteamDataError) || err.retryable },
      );
    } catch (err) {
      if (s.usePublicFallback) {
        this.log.warn("PICS failed; trying public mirror", { appId: req.appId, err: (err as Error).message });
        try { return await fetchPublicMirror(s.publicFallbackUrl, req.appId, req.branch, s.requestTimeoutMs); }
        catch (e2) { throw new SteamDataError(`${(err as Error).message}; public mirror also failed: ${(e2 as Error).message}`, true); }
      }
      throw err;
    }
  }

  shutdown() {
    for (const e of this.entries.values()) { try { e.client.logOff(); } catch { /* ignore */ } }
    this.entries.clear();
  }
}
