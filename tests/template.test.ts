import { describe, expect, it } from "vitest";
import { formatDate, render, type TemplateContext } from "../src/notify/template.js";
import { buildPayload, DISCORD_LIMITS, sendWebhook, validateWebhookUrl } from "../src/notify/discord.js";
import { NotifySchema } from "../src/watches.js";

// 2017-04-22 00:19:10 UTC
const T = new Date(Date.UTC(2017, 3, 22, 0, 19, 10));
const ctx = (over: Partial<TemplateContext> = {}): TemplateContext => ({
  vars: { game_name: "Half-Life", app_id: 70, build_id: "123", manifest_id: null },
  dates: { timestamp: T, detected_at: new Date(T.getTime() + 5000), update_time: null },
  depots: [{ depot_id: "71", manifest_id: "9001", prev_manifest_id: "9000", change: "changed" }, { depot_id: "72", manifest_id: "9002", prev_manifest_id: "unavailable", change: "added" }],
  timezone: "UTC", ...over,
});

describe("template engine", () => {
  it("substitutes variables", () => {
    expect(render("{game_name} (App ID: {app_id}) has updated!", ctx()).text).toBe("Half-Life (App ID: 70) has updated!");
  });
  it("renders unavailable values explicitly instead of inventing them", () => {
    expect(render("Manifest: {manifest_id}", ctx()).text).toBe("Manifest: unavailable");
    expect(render("{update_time:F}", ctx()).text).toBe("unavailable");
  });
  it("computes Discord timestamps from the real event time", () => {
    const unix = Math.floor(T.getTime() / 1000);
    expect(unix).toBe(1492820350);
    expect(render("{timestamp:F}", ctx()).text).toBe(`<t:${unix}:F>`);
    expect(render("{timestamp:R}|{timestamp:t}|{timestamp}", ctx()).text).toBe(`<t:${unix}:R>|<t:${unix}:t>|<t:${unix}:F>`);
    expect(render("{unix}", ctx()).text).toBe(String(unix));
  });
  it("formats literal dates in UTC and in another timezone", () => {
    expect(render("{date:YYYY-MM-DD}", ctx()).text).toBe("2017-04-22");
    expect(render("{timestamp:YYYY-MM-DD HH:mm:ss}", ctx()).text).toBe("2017-04-22 00:19:10");
    expect(render("{date:YYYY-MM-DD HH:mm Z}", ctx({ timezone: "America/New_York" })).text).toBe("2017-04-21 20:19 -04:00");
    expect(render("{date:YYYY-MM-DD HH:mm Z}", ctx({ timezone: "Asia/Kolkata" })).text).toBe("2017-04-22 05:49 +05:30");
    expect(formatDate(T, "[on] dddd, MMMM D", "UTC")).toBe("on Saturday, April 22");
  });
  it("supports depot-specific manifests and loops", () => {
    expect(render("{manifest:71} {manifest:99}", ctx()).text).toBe("9001 unavailable");
    expect(render("{#each depots}{depot_id}={manifest_id};{/each}", ctx()).text).toBe("71=9001;72=9002;");
  });
  it("supports conditionals and filters", () => {
    expect(render("{#if manifest_id}has{#else}none{/if}", ctx()).text).toBe("none");
    expect(render("{#if game_name}has{#else}none{/if}", ctx()).text).toBe("has");
    expect(render("{game_name|upper|truncate:4}", ctx()).text).toBe("H...");
    expect(render("{manifest_id|default:n/a}", ctx()).text).toBe("n/a");
  });
  it("escapes braces and warns on unknown variables without throwing", () => {
    const r = render("{{literal}} {nope}", ctx());
    expect(r.text).toBe("{literal} {nope}");
    expect(r.warnings[0]).toMatch(/Unknown variable/);
  });
});

describe("discord payload + delivery", () => {
  const ev: any = { id: "e", appId: 1, gameName: "G", kind: "update", detectedAt: T.toISOString(), updateTime: null, prevBuild: "1", newBuild: "2", changes: { depots: [], manifestIds: {}, trigger: [], rollback: false, buildChange: null } };
  const fakeCtx: any = { settings: { get: () => ({ notifications: { useEmbed: false, template: "", timezone: "UTC", timeMode: "utc", manifestFormat: "" }, security: { publicBaseUrl: "" } }) }, boot: { host: "127.0.0.1", port: 4019 } };

  it("truncates to Discord limits and builds mentions + allowed_mentions", () => {
    const notify = NotifySchema.parse({ mentions: { users: ["123456789012345678"], roles: ["223456789012345678"], everyone: false } });
    const p: any = buildPayload(fakeCtx, ev, { notify }, { username: null, avatar_url: null }, "x".repeat(5000));
    expect(p.content.length).toBeLessThanOrEqual(DISCORD_LIMITS.content);
    expect(p.content.startsWith("<@123456789012345678> <@&223456789012345678>")).toBe(true);
    expect(p.allowed_mentions).toEqual({ parse: [], users: ["123456789012345678"], roles: ["223456789012345678"] });
  });
  it("accepts only Discord webhook URLs by default", async () => {
    await expect(validateWebhookUrl("https://discord.com/api/webhooks/123456789012345678/tok", false)).resolves.toBeUndefined();
    await expect(validateWebhookUrl("https://evil.example/api/webhooks/1/x", false)).rejects.toThrow(/Only discord/);
    await expect(validateWebhookUrl("http://discord.com/api/webhooks/1/x", false)).rejects.toThrow();
    await expect(validateWebhookUrl("https://127.0.0.1/hook", true)).rejects.toThrow(/private/);
  });
  it("classifies 429 (with retry_after), 5xx and 4xx outcomes", async () => {
    const mk = (status: number, body = "", headers: Record<string, string> = {}) => (async () => new Response(status === 204 ? null : body, { status, headers })) as unknown as typeof fetch;
    expect(await sendWebhook("https://x/y", {}, 1000, mk(204))).toMatchObject({ ok: true });
    expect(await sendWebhook("https://x/y", {}, 1000, mk(429, JSON.stringify({ retry_after: 1.5 })))).toMatchObject({ ok: false, status: 429, retryAfterMs: 1500 });
    const r502 = await sendWebhook("https://x/y", {}, 1000, mk(502)); expect(r502.ok).toBe(false); expect(r502.permanent).toBeFalsy();
    expect(await sendWebhook("https://x/y", {}, 1000, mk(404, "Unknown Webhook"))).toMatchObject({ ok: false, permanent: true });
    const net = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    expect((await sendWebhook("https://x/y", {}, 1000, net)).ok).toBe(false);
  });
});
