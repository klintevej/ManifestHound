import { h, get, ago, badge, table } from "./lib.js";

export async function overviewPage() {
  const o = await get("/overview");
  const stat = (n, l, cls = "") => h("div", { class: "card stat" }, h("div", { class: "n " + cls }, n), h("div", { class: "l" }, l));
  const healthText = { ok: "Healthy", degraded: "Degraded: some games failing checks", idle: "No games monitored yet" }[o.health];
  return h("div", {},
    h("h1", {}, "Overview"),
    h("div", { class: "grid cols4" },
      stat(o.counts.watches, "Monitored games"), stat(o.counts.enabled, "Enabled jobs"),
      stat(o.active.length, "Active / queued tasks"), stat(o.failed.jobs.length + o.failed.notifications.length, "Failures needing attention", o.failed.jobs.length + o.failed.notifications.length ? "err" : "")),
    h("div", { class: "card" }, h("h2", {}, "Monitoring health"), h("span", { class: "dot " + (o.health === "ok" ? "ok" : o.health === "degraded" ? "bad" : "warn") }), healthText,
      o.counts.erroring ? h("span", { class: "muted" }, ` (${o.counts.erroring} game(s) with errors)`) : null),
    h("div", { class: "grid cols2" },
      h("div", { class: "card" }, h("h2", {}, "Most recent updates"),
        table([
          { key: "game_name", label: "Game", render: (r) => h("a", { href: "#/history/" + r.id }, r.game_name) },
          { key: "kind", label: "Kind", render: (r) => badge(r.kind) },
          { key: "new_build", label: "Build", class: "mono" },
          { key: "detected_at", label: "Detected", render: (r) => ago(r.detected_at) },
        ], o.recentEvents, { sortable: false, empty: "No updates detected yet." })),
      h("div", { class: "card" }, h("h2", {}, "Recent notification results"),
        table([
          { key: "game_name", label: "Game", render: (r) => h("a", { href: "#/history/" + r.event_id }, r.game_name) },
          { key: "status", label: "Status", render: (r) => badge(r.status) },
          { key: "attempts", label: "Tries" },
          { key: "created_at", label: "When", render: (r) => ago(r.created_at) },
        ], o.recentNotifs, { empty: "No notifications yet." }))),
    h("div", { class: "grid cols2" },
      h("div", { class: "card" }, h("h2", {}, "Active post-update tasks"),
        table([
          { key: "job_name", label: "Job", render: (r) => h("a", { href: "#/history/" + r.event_id }, r.job_name) },
          { key: "status", label: "Status", render: (r) => badge(r.status) },
          { key: "started_at", label: "Started", render: (r) => (r.started_at ? ago(r.started_at) : "waiting") },
        ], o.active, { empty: "Nothing running." })),
      h("div", { class: "card" }, h("h2", {}, "Failed tasks"),
        o.failed.jobs.length || o.failed.notifications.length ? h("div", {},
          o.failed.jobs.map((j) => h("p", {}, badge("failed"), " ", h("a", { href: "#/history/" + j.event_id }, j.job_name), h("span", { class: "muted" }, ` ${ago(j.finished_at)}: ${(j.error || "").slice(0, 140)}`))),
          o.failed.notifications.map((n) => h("p", {}, badge("failed", "notification"), " ", h("a", { href: "#/history/" + n.event_id }, n.game_name), h("span", { class: "muted" }, `: ${(n.last_error || "").slice(0, 140)}`))))
          : h("p", { class: "muted" }, "No failures."))),
    h("div", { class: "card" }, h("h2", {}, "Last successful check per game"),
      table([
        { key: "name", label: "Game", render: (g) => h("a", { href: "#/games" }, g.name) },
        { key: "appId", label: "App ID", class: "mono" },
        { key: "status", label: "Status", render: (g) => badge(g.status) },
        { key: "lastSuccessAt", label: "Last success", render: (g) => ago(g.lastSuccessAt), sort: (g) => g.lastSuccessAt || "" },
        { key: "lastError", label: "Error", render: (g) => h("span", { class: "err" }, (g.lastError || "").slice(0, 120)) },
      ], o.games, { empty: "Add a game under Games." })));
}
