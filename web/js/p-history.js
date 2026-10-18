import { h, get, post, guard, table, badge, fmtDate, ago, copyText, toast } from "./lib.js";

let query = { q: "", kind: "" };

export async function historyPage({ rest, refresh }) {
  if (rest[0]) return eventDetail(rest[0], refresh);
  const data = await get(`/events?limit=100&q=${encodeURIComponent(query.q)}${query.kind ? "&kind=" + query.kind : ""}`);
  const q = h("input", { type: "search", placeholder: "Search game, App ID, build or manifest ID...", value: query.q });
  q.addEventListener("keydown", (e) => { if (e.key === "Enter") { query.q = q.value.trim(); refresh(); } });
  const kind = h("select", {}, [["", "All kinds"], ["update", "Updates"], ["rollback", "Rollbacks"], ["baseline", "Baselines"], ["initial", "Initial"]].map(([v, l]) => h("option", { value: v, selected: v === query.kind }, l)));
  kind.addEventListener("change", () => { query.kind = kind.value; refresh(); });
  const summarize = (s) => (s ? [...new Set(s.split(","))].map((x) => badge(x)) : "-");
  return h("div", {},
    h("h1", {}, "Update history"),
    h("div", { class: "toolbar" }, q, kind, h("button", { onclick: () => { query.q = q.value.trim(); refresh(); } }, "Search"), h("span", { class: "muted" }, `${data.total} event(s)`)),
    h("div", { class: "card" }, table([
      { key: "detectedAt", label: "Detected", render: (e) => h("a", { href: "#/history/" + e.id }, fmtDate(e.detectedAt)), sort: (e) => e.detectedAt },
      { key: "gameName", label: "Game", render: (e) => `${e.gameName} (${e.appId})` },
      { key: "kind", label: "Kind", render: (e) => badge(e.kind) },
      { key: "build", label: "Build", class: "mono", render: (e) => (e.kind === "baseline" ? e.newBuild : `${e.prevBuild ?? "?"} to ${e.newBuild ?? "?"}`), sortable: false },
      { key: "depots", label: "Depots", class: "mono", render: (e) => e.changes.depots.map((d) => d.depotId).join(", ") || "-", sortable: false },
      { key: "notifStatus", label: "Notification", render: (e) => summarize(e.notifStatus), sortable: false },
      { key: "jobStatus", label: "Jobs", render: (e) => summarize(e.jobStatus), sortable: false },
    ], data.items, { sortKey: "detectedAt", sortDir: -1, empty: "No events match." })));
}

async function eventDetail(id, refresh) {
  const e = await get("/events/" + encodeURIComponent(id));
  const manifestText = e.changes.depots.map((d) => `${d.depotId}: ${d.to}`).join("\n");
  return h("div", {},
    h("p", {}, h("a", { href: "#/history" }, "Back to all events")),
    h("h1", {}, `${e.gameName} `, badge(e.kind)),
    h("div", { class: "card" },
      h("div", { class: "grid cols2" },
        h("div", {}, h("p", {}, h("span", { class: "muted" }, "App ID: "), e.appId), h("p", {}, h("span", { class: "muted" }, "Detected: "), fmtDate(e.detectedAt), ` (${ago(e.detectedAt)})`),
          h("p", {}, h("span", { class: "muted" }, "Steam update time: "), e.updateTime ? fmtDate(e.updateTime) : "unavailable (Steam did not report one)")),
        h("div", {}, h("p", {}, h("span", { class: "muted" }, "Build: "), h("span", { class: "mono" }, `${e.prevBuild ?? "unavailable"} to ${e.newBuild ?? "unavailable"}`)),
          h("p", {}, h("span", { class: "muted" }, "Branch / source: "), `${e.changes.branch ?? "public"} / ${e.changes.source ?? "?"}`),
          h("p", {}, h("span", { class: "muted" }, "Event ID: "), h("span", { class: "mono" }, e.id)))),
      e.changes.rollback ? h("p", {}, badge("rollback", "Build moved to an earlier build ID")) : null),
    h("div", { class: "card" }, h("div", { class: "row" }, h("h2", {}, "Depot changes"), h("div", { class: "spacer" }),
      h("button", { class: "small", onclick: () => copyText(manifestText || "unavailable") }, "Copy manifests"),
      h("button", { class: "small", onclick: () => copyText(JSON.stringify(e.changes, null, 2)) }, "Copy JSON")),
      table([
        { key: "depotId", label: "Depot", class: "mono" }, { key: "change", label: "Change", render: (d) => badge(d.change) },
        { key: "from", label: "Previous manifest", class: "mono", render: (d) => d.from ?? "-" }, { key: "to", label: "New manifest", class: "mono" },
        { key: "tracked", label: "Followed", render: (d) => (d.tracked ? "yes" : "detail only") },
      ], e.changes.depots, { sortable: false, empty: e.kind === "baseline" ? "Baseline: current state recorded, nothing compared." : "Build-only change (no depot manifest changed)." })),
    h("div", { class: "card" }, h("h2", {}, "Notifications"),
      table([
        { key: "status", label: "Status", render: (n) => badge(n.status) }, { key: "attempts", label: "Attempts" },
        { key: "http_status", label: "HTTP", render: (n) => n.http_status ?? "-" },
        { key: "detail", label: "Detail", render: (n) => n.last_error || n.detail || "" },
        { key: "delivered_at", label: "Delivered", render: (n) => (n.delivered_at ? fmtDate(n.delivered_at) : "-") },
        { key: "x", label: "", render: (n) => (["failed", "pending"].includes(n.status) && n.id ? h("button", { class: "small", onclick: () => guard(async () => { await post(`/notifications/${n.id}/retry`); toast("Retry queued", "ok"); refresh(); }) }, "Retry") : null) },
      ], e.notifications, { sortable: false, empty: e.kind === "baseline" ? "Baselines do not notify." : "No notification rows." })),
    h("div", { class: "card" }, h("h2", {}, "Jobs"),
      e.jobs.length ? e.jobs.map((j) => h("details", { open: j.status === "failed" },
        h("summary", {}, badge(j.status), ` ${j.job_name}${j.manual ? " (manual)" : ""}  `, h("span", { class: "muted" }, `attempt ${j.attempts}${j.finished_at ? ", finished " + ago(j.finished_at) : ""}`)),
        j.error ? h("p", { class: "err" }, j.error) : null, j.result?.summary ? h("p", {}, j.result.summary) : null,
        h("pre", {}, j.log || "(no log)"),
        h("div", { class: "row" }, h("button", { class: "small", onclick: () => guard(async () => { await post(`/job-runs/${j.id}/rerun`); toast("Re-run queued", "ok"); refresh(); }) }, "Run again"),
          ["queued", "running"].includes(j.status) ? h("button", { class: "small danger", onclick: () => guard(async () => { await post(`/job-runs/${j.id}/cancel`); refresh(); }) }, "Cancel") : null)))
        : h("p", { class: "muted" }, "No jobs ran for this event.")));
}
