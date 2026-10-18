import type { AppContext } from "../context.js";
import type { EventRecord } from "../events.js";
import type { NotifyConfig, Watch } from "../watches.js";
import { render, isValidTimezone, UNAVAILABLE, type TemplateContext } from "./template.js";
import { assertSafeUrl } from "../util/ssrf.js";
import { UserError } from "../util/misc.js";

export const DISCORD_LIMITS = { content: 2000, embedDescription: 4096, fieldValue: 1024, fieldName: 256, title: 256, embedTotal: 6000 };

const DISCORD_HOSTS = ["discord.com", "discordapp.com"];

/** Validate a webhook URL. Discord hosts only, unless the admin enabled custom hosts (then SSRF-checked). */
export async function validateWebhookUrl(url: string, allowCustomHosts: boolean): Promise<void> {
  let u: URL;
  try { u = new URL(url); } catch { throw new UserError("Webhook URL is not a valid URL"); }
  const discord = DISCORD_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith("." + h));
  if (discord) {
    if (u.protocol !== "https:" || !/^\/api\/(v\d+\/)?webhooks\/\d+\/[\w-]+\/?$/.test(u.pathname)) throw new UserError("Not a valid Discord webhook URL (expected https://discord.com/api/webhooks/<id>/<token>)");
    return;
  }
  if (!allowCustomHosts) throw new UserError("Only discord.com / discordapp.com webhook URLs are accepted (change Settings > Notifications to allow other hosts)");
  await assertSafeUrl(url, { protocols: ["https:"] });
}

export function resolveTimezone(notify: NotifyConfig, ctx: AppContext): string {
  const s = ctx.settings.get().notifications;
  const mode = notify.timeMode ?? s.timeMode;
  if (mode === "utc") return "UTC";
  const tz = notify.timezone ?? s.timezone;
  if (tz && tz !== "UTC" && isValidTimezone(tz)) return tz;
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function historyUrl(ctx: AppContext, eventId: string): string {
  const base = ctx.settings.get().security.publicBaseUrl || `http://${ctx.boot.host === "0.0.0.0" ? "127.0.0.1" : ctx.boot.host}:${ctx.boot.port}`;
  return `${base.replace(/\/$/, "")}/#/history/${eventId}`;
}

export function buildTemplateContext(ctx: AppContext, ev: EventRecord, watch: Pick<Watch, "notify">): TemplateContext {
  const n = watch.notify;
  const fmt = n.manifestFormat ?? ctx.settings.get().notifications.manifestFormat;
  const depots = ev.changes.depots.map((d) => ({
    depot_id: d.depotId, manifest_id: d.to, prev_manifest_id: d.from ?? UNAVAILABLE, change: d.change,
  }));
  const tz = resolveTimezone(n, ctx);
  const tsDate = new Date(ev.updateTime ?? ev.detectedAt);
  const manifestLines = depots.map((d) => renderDepot(fmt, d, tz));
  const kindLabel = ev.kind === "rollback" ? "rolled back" : "updated";
  return {
    vars: {
      game_name: ev.gameName, app_id: ev.appId, build_id: ev.newBuild, prev_build_id: ev.prevBuild, kind: ev.kind, kind_label: kindLabel,
      event_id: ev.id, branch: ev.changes.branch ?? "public",
      depot_ids: depots.map((d) => d.depot_id).join(", "), depot_count: depots.length,
      manifest_id: depots.length === 0 ? null : depots.map((d) => d.manifest_id).join(", "),
      manifest_ids: manifestLines.join("\n"), manifest_count: depots.length,
      history_url: historyUrl(ctx, ev.id),
      steamdb_url: `https://steamdb.info/app/${ev.appId}/`, store_url: `https://store.steampowered.com/app/${ev.appId}/`,
    },
    dates: { timestamp: tsDate, detected_at: new Date(ev.detectedAt), update_time: ev.updateTime ? new Date(ev.updateTime) : null },
    depots, timezone: tz,
  };
}

function renderDepot(fmt: string, d: TemplateContext["depots"][number], tz: string): string {
  return render(`{#each depots}${fmt}{/each}`, { vars: {}, dates: {}, depots: [d], timezone: tz }).text;
}

export function renderMessage(ctx: AppContext, ev: EventRecord, watch: Pick<Watch, "notify">, templateOverride?: string) {
  const tpl = templateOverride ?? watch.notify.template ?? ctx.settings.get().notifications.template;
  return render(tpl, buildTemplateContext(ctx, ev, watch));
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 3) + "..." : s);

export interface WebhookRow { id: number; name: string; url: string; username: string | null; avatar_url: string | null }

export function buildPayload(ctx: AppContext, ev: EventRecord, watch: Pick<Watch, "notify">, hook: Pick<WebhookRow, "username" | "avatar_url">, textOverride?: string) {
  const n = watch.notify;
  const gs = ctx.settings.get().notifications;
  const { text } = textOverride !== undefined ? { text: textOverride } : renderMessage(ctx, ev, watch);
  const m = n.mentions;
  const mentionText = [...m.users.map((u) => `<@${u}>`), ...m.roles.map((r) => `<@&${r}>`), ...(m.everyone ? ["@everyone"] : [])].join(" ");
  const payload: Record<string, unknown> = {
    allowed_mentions: { parse: m.everyone ? ["everyone"] : [], users: m.users, roles: m.roles },
  };
  const username = n.username ?? hook.username, avatar = n.avatarUrl ?? hook.avatar_url;
  if (username) payload.username = truncate(username, 80);
  if (avatar) payload.avatar_url = avatar;

  if (n.useEmbed ?? gs.useEmbed) {
    const tctx = buildTemplateContext(ctx, ev, watch);
    const inc = n.include;
    const fields: { name: string; value: string; inline?: boolean }[] = [];
    const add = (name: string, value: string, inline = true) => fields.push({ name: truncate(name, DISCORD_LIMITS.fieldName), value: truncate(value || UNAVAILABLE, DISCORD_LIMITS.fieldValue), inline });
    if (inc.gameName) add("Game", ev.gameName);
    if (inc.appId) add("App ID", String(ev.appId));
    if (inc.buildIds) add("Build", `${ev.prevBuild ?? UNAVAILABLE} to ${ev.newBuild ?? UNAVAILABLE}`);
    if (inc.depotIds) add("Depots", String(tctx.vars.depot_ids || UNAVAILABLE));
    if (inc.manifestIds) add("Manifests", String(tctx.vars.manifest_ids || UNAVAILABLE), false);
    if (inc.timestamps) add("Time", `<t:${Math.floor(new Date(ev.updateTime ?? ev.detectedAt).getTime() / 1000)}:F>`);
    if (inc.links) add("Links", `[SteamDB](${tctx.vars.steamdb_url}) | [Store](${tctx.vars.store_url}) | [History](${tctx.vars.history_url})`, false);
    payload.embeds = [{
      title: truncate(ev.gameName, DISCORD_LIMITS.title),
      description: truncate(text, DISCORD_LIMITS.embedDescription),
      color: ev.kind === "rollback" ? 0xd29922 : 0x3b82f6,
      timestamp: new Date(ev.updateTime ?? ev.detectedAt).toISOString(),
      fields: fields.slice(0, 25),
    }];
    if (mentionText) payload.content = truncate(mentionText, DISCORD_LIMITS.content);
  } else {
    const body = mentionText ? `${mentionText}\n${text}` : text;
    payload.content = truncate(body, DISCORD_LIMITS.content);
  }
  return payload;
}

export interface SendResult { ok: boolean; status?: number; retryAfterMs?: number; permanent?: boolean; error?: string }

/** POST to a Discord webhook. Classifies the outcome so the caller knows whether to retry. */
export async function sendWebhook(url: string, payload: unknown, timeoutMs = 15000, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetchImpl(url + (url.includes("?") ? "&" : "?") + "wait=true", {
      method: "POST", headers: { "content-type": "application/json", "user-agent": "ManifestHound/1.0" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs), redirect: "error",
    });
  } catch (e) {
    return { ok: false, error: `Network error: ${(e as Error).message}` };
  }
  if (res.ok) return { ok: true, status: res.status };
  const body = (await res.text().catch(() => "")).slice(0, 300);
  if (res.status === 429) {
    let secs = Number(res.headers.get("retry-after"));
    try { const j = JSON.parse(body); if (typeof j.retry_after === "number") secs = j.retry_after; } catch { /* header only */ }
    return { ok: false, status: 429, retryAfterMs: Math.ceil((Number.isFinite(secs) && secs > 0 ? secs : 5) * 1000), error: "Rate limited by Discord" };
  }
  if (res.status >= 500) return { ok: false, status: res.status, error: `Discord server error ${res.status}` };
  return { ok: false, status: res.status, permanent: true, error: `Discord rejected the request (${res.status}): ${body}` };
}
