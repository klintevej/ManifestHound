import { h, get, table, badge, ago } from "./lib.js";

export async function diagPage() {
  const d = await get("/diagnostics");
  const kv = (obj) => h("table", {}, h("tbody", {}, Object.entries(obj).map(([k, v]) => h("tr", {}, h("td", { class: "muted" }, k), h("td", { class: "mono wrap" }, typeof v === "object" ? JSON.stringify(v) : String(v))))));
  return h("div", {},
    h("h1", {}, "Diagnostics"),
    h("div", { class: "toolbar" }, h("a", { class: "btn", href: "/api/diagnostics/export", download: true }, "Download diagnostic bundle (secrets redacted)")),
    h("div", { class: "grid cols2" },
      h("div", { class: "card" }, h("h2", {}, "Application"), kv({ ...d.app, memoryMb: d.memoryMb, schemaVersion: d.schemaVersion }), h("h3", {}, "Paths"), kv(d.paths)),
      h("div", { class: "card" }, h("h2", {}, "Queues"), kv(d.queues), h("h3", {}, "Counts"), kv(d.counts),
        h("h3", {}, "Tools"), table([{ key: "n", label: "Tool" }, { key: "ok", label: "Status", render: (t) => badge(t.ok ? "ok" : "error", t.ok ? "available" : "missing") }, { key: "detail", label: "Detail", class: "mono" }],
          Object.entries(d.tools).map(([n, t]) => ({ n, ...t })), { sortable: false }))),
    h("div", { class: "card" }, h("h2", {}, "Steam accounts"), table([{ key: "name", label: "Name" }, { key: "status", label: "Status", render: (a) => badge(a.status) }, { key: "status_detail", label: "Detail" }, { key: "last_validated_at", label: "Validated", render: (a) => ago(a.last_validated_at) }], d.accounts, { empty: "No accounts (anonymous access only)." })),
    h("div", { class: "card" }, h("h2", {}, "Monitoring errors"), table([{ key: "name", label: "Game" }, { key: "consecutive_failures", label: "Failures" }, { key: "last_error", label: "Error" }, { key: "last_check_at", label: "Checked", render: (w) => ago(w.last_check_at) }], d.watchErrors, { empty: "No errors." })),
    h("div", { class: "card" }, h("h2", {}, "Recent warnings and errors"), h("pre", {}, d.recentLogs.map((l) => `${l.ts} ${l.level.toUpperCase().padEnd(5)} [${l.component}] ${l.msg}${l.err ? " " + JSON.stringify(l.err.message ?? l.err) : ""}`).join("\n") || "(none)")));
}
