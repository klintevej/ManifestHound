import { h, get, post, put, patch, del, guard, toast, modal, field, check, select, table, confirmDialog } from "./lib.js";

/** Reusable per-game notification settings editor. Returns { el, collect() }. */
export function notifyEditor(n, watchId) {
  n = n || {};
  const inc = n.include || {}, men = n.mentions || {};
  const enabled = check("Send notifications for this game", n.enabled ?? true);
  const hookSel = h("select", {}); // filled async
  const tpl = h("textarea", { placeholder: "Leave empty to use the global default template", value: n.template || "" });
  const username = h("input", { value: n.username || "", placeholder: "Webhook default" });
  const avatar = h("input", { value: n.avatarUrl || "", placeholder: "https://..." });
  const users = h("input", { value: (men.users || []).join(", "), placeholder: "Discord user IDs" });
  const roles = h("input", { value: (men.roles || []).join(", "), placeholder: "Discord role IDs" });
  const everyone = check("Mention @everyone", men.everyone ?? false);
  const embed = select([["", "Global default"], ["true", "Embed"], ["false", "Plain message"]], n.useEmbed == null ? "" : String(n.useEmbed));
  const tmode = select([["", "Global default"], ["utc", "UTC"], ["local", "Local timezone"]], n.timeMode || "");
  const tz = h("input", { value: n.timezone || "", placeholder: "e.g. America/New_York" });
  const mfmt = h("input", { value: n.manifestFormat || "", placeholder: "{depot_id}: {manifest_id}" });
  const incs = Object.fromEntries([["gameName", "Game name"], ["appId", "App ID"], ["buildIds", "Build IDs"], ["depotIds", "Depot IDs"], ["manifestIds", "Manifest IDs"], ["timestamps", "Timestamps"], ["links", "Links"]]
    .map(([k, l]) => [k, check(l, inc[k] ?? true)]));
  const sup = Object.fromEntries([["update", "Updates"], ["rollback", "Rollbacks"], ["initial", "Initial (first check)"]].map(([k, l]) => [k, check(l, (n.suppressKinds || []).includes(k))]));
  const preview = h("div");
  get("/webhooks").then((hooks) => hookSel.replaceChildren(h("option", { value: "" }, "Global default webhook"), ...hooks.map((x) => h("option", { value: x.id, selected: x.id === n.webhookId }, x.name))));
  const collect = () => ({
    enabled: enabled.input.checked, webhookId: hookSel.value ? Number(hookSel.value) : null, template: tpl.value.trim() || null,
    username: username.value.trim() || null, avatarUrl: avatar.value.trim() || null,
    mentions: { users: users.value.split(/[\s,]+/).filter(Boolean), roles: roles.value.split(/[\s,]+/).filter(Boolean), everyone: everyone.input.checked },
    include: Object.fromEntries(Object.entries(incs).map(([k, c]) => [k, c.input.checked])),
    suppressKinds: Object.entries(sup).filter(([, c]) => c.input.checked).map(([k]) => k),
    timeMode: tmode.value || null, timezone: tz.value.trim() || null, useEmbed: embed.value === "" ? null : embed.value === "true", manifestFormat: mfmt.value.trim() || null,
  });
  const doPreview = () => guard(async () => {
    const r = await post("/templates/preview", { template: tpl.value.trim() || undefined, watchId, notify: collect() });
    preview.replaceChildren(h("pre", {}, r.text), r.warnings.length ? h("p", { class: "err" }, r.warnings.join("; ")) : null,
      h("p", { class: "note" }, `${r.length}/2000 characters`), h("details", {}, h("summary", {}, "Discord payload"), h("pre", {}, JSON.stringify(r.payload, null, 2))));
  });
  const el = h("div", {},
    enabled.el, h("div", { class: "grid cols2" }, field("Webhook", hookSel), field("Message format", embed)),
    field("Message template", tpl, "Variables: {game_name} {app_id} {build_id} {manifest_id} {manifest_ids} {timestamp:F} {date:YYYY-MM-DD} ... see Notifications > Template reference."),
    h("div", { class: "row" }, h("button", { onclick: doPreview }, "Preview with sample data")), preview,
    h("div", { class: "grid cols2" }, field("Username override", username), field("Avatar URL", avatar)),
    h("div", { class: "grid cols2" }, field("Mention users", users), field("Mention roles", roles)), everyone.el,
    h("div", { class: "grid cols2" }, field("Timestamp mode", tmode), field("Timezone (when local)", tz)),
    field("Manifest display format", mfmt, "Used for {manifest_ids}. Variables: {depot_id} {manifest_id} {prev_manifest_id} {change}."),
    h("h3", {}, "Embed fields to include"), h("div", { class: "row" }, Object.values(incs).map((c) => c.el)),
    h("h3", {}, "Suppress notifications for"), h("div", { class: "row" }, Object.values(sup).map((c) => c.el)));
  return { el, collect };
}

export async function notifyPage({ refresh }) {
  const [hooks, settingsRes, help] = await Promise.all([get("/webhooks"), get("/settings"), get("/templates/help")]);
  const s = settingsRes.settings.notifications;

  const hookForm = (existing) => {
    const name = h("input", { value: existing?.name || "" }), url = h("input", { type: "password", placeholder: existing ? "Leave empty to keep the stored URL" : "https://discord.com/api/webhooks/...", autocomplete: "off" });
    const user = h("input", { value: existing?.username || "" }), av = h("input", { value: existing?.avatarUrl || "" });
    modal(existing ? `Edit ${existing.name}` : "Add Discord webhook", h("div", {}, field("Name", name), field("Webhook URL", url, "Stored encrypted. It is never shown again after saving."),
      h("div", { class: "grid cols2" }, field("Default username", user), field("Default avatar URL", av))), { actions: [
      { label: "Cancel", onclick: (c) => c() },
      { label: "Save", class: "primary", onclick: (c) => guard(async () => {
        const body = { name: name.value, username: user.value || null, avatarUrl: av.value || null }; if (url.value) body.url = url.value;
        if (existing) await patch(`/webhooks/${existing.id}`, body); else await post("/webhooks", body);
        c(); refresh();
      }) }] });
  };

  const tpl = h("textarea", { style: "min-height:120px" }, s.template);
  const tmode = select([["utc", "UTC"], ["local", "Local timezone"]], s.timeMode);
  const tz = h("input", { value: s.timezone });
  const mfmt = h("input", { value: s.manifestFormat });
  const embed = check("Use embeds by default", s.useEmbed);
  const custom = check("Allow non-Discord webhook hosts (SSRF-checked, HTTPS only)", s.allowCustomWebhookHosts);
  const defHook = select([["", "None"], ...hooks.map((x) => [x.id, x.name])], s.defaultWebhookId ?? "");
  const preview = h("div");
  const doPreview = () => guard(async () => {
    const r = await post("/templates/preview", { template: tpl.value, notify: { timeMode: tmode.value, timezone: tz.value, manifestFormat: mfmt.value } });
    preview.replaceChildren(h("pre", {}, r.text), r.warnings.length ? h("p", { class: "err" }, r.warnings.join("; ")) : null, h("p", { class: "note" }, `${r.length}/2000 characters`));
  });

  return h("div", {},
    h("h1", {}, "Notifications"),
    h("div", { class: "card" }, h("div", { class: "row" }, h("h2", {}, "Discord webhooks"), h("div", { class: "spacer" }), h("button", { class: "primary small", onclick: () => hookForm() }, "Add webhook")),
      table([
        { key: "name", label: "Name" }, { key: "urlHint", label: "URL", class: "mono" },
        { key: "def", label: "Default", sortable: false, render: (x) => (x.id === s.defaultWebhookId ? "yes" : "") },
        { key: "x", label: "", sortable: false, render: (x) => h("div", { class: "row" },
          h("button", { class: "small", onclick: () => guard(async () => { const r = await post(`/webhooks/${x.id}/test`, { template: tpl.value }); toast(r.ok ? "Test message sent" : `Failed: ${r.error}`, r.ok ? "ok" : "bad"); }) }, "Send test"),
          h("button", { class: "small", onclick: () => hookForm(x) }, "Edit"),
          h("button", { class: "small danger", onclick: async () => { if (await confirmDialog("Delete webhook?", `Games using "${x.name}" will fall back to the default webhook (or send nothing).`, "Delete")) guard(async () => { await del("/webhooks/" + x.id); refresh(); }); } }, "Delete")) },
      ], hooks, { empty: "No webhook yet. In Discord: Server Settings > Integrations > Webhooks > New Webhook > Copy Webhook URL." })),
    h("div", { class: "card" }, h("h2", {}, "Global defaults"),
      h("div", { class: "grid cols2" }, field("Default webhook", defHook), field("Timestamp mode", tmode)),
      field("Timezone (IANA name, used when mode is local)", tz), field("Message template", tpl), field("Manifest display format", mfmt),
      embed.el, custom.el,
      h("div", { class: "row", style: "margin-top:10px" }, h("button", { onclick: doPreview }, "Preview"), h("button", { class: "primary", onclick: () => guard(async () => {
        await fetchPut(); toast("Saved", "ok"); }) }, "Save defaults")), preview),
    h("div", { class: "card" }, h("h2", {}, "Template reference"),
      h("h3", {}, "Syntax"), table([{ key: "example", label: "Example", class: "mono" }, { key: "note", label: "Meaning" }], help.syntax, { sortable: false }),
      h("h3", {}, "Variables"), table([{ key: "0", label: "Variable", class: "mono", render: (r) => `{${r[0]}}` }, { key: "1", label: "Meaning" }], help.variables.map((v) => ({ 0: v[0], 1: v[1] })), { sortable: false }),
      h("h3", {}, "Dates and Discord timestamps"), table([{ key: "example", label: "Example", class: "mono" }, { key: "note", label: "Meaning" }], help.dates, { sortable: false }),
      h("p", { class: "note" }, "Format tokens: " + help.formatTokens), h("p", { class: "note" }, help.timezone)));

  async function fetchPut() {
    await put("/settings", { notifications: { defaultWebhookId: defHook.value ? Number(defHook.value) : null, template: tpl.value, timeMode: tmode.value, timezone: tz.value, manifestFormat: mfmt.value, useEmbed: embed.input.checked, allowCustomWebhookHosts: custom.input.checked } });
  }
}
