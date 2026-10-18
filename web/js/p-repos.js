import { h, get, table, badge, fmtDate, ago } from "./lib.js";

let selected = null;

export async function reposPage({ refresh }) {
  const repos = await get("/git/repos");
  if (selected == null && repos.length) selected = repos[0].jobId;
  const commits = selected != null && repos.find((r) => r.jobId === selected)?.exists ? await get(`/git/commits?jobId=${selected}`) : [];
  return h("div", {},
    h("h1", {}, "Repositories"),
    h("div", { class: "card" }, table([
      { key: "jobName", label: "Git job", render: (r) => h("a", { href: "#", onclick: (e) => { e.preventDefault(); selected = r.jobId; refresh(); } }, r.jobName + (r.jobId === selected ? " (selected)" : "")) },
      { key: "repoPath", label: "Path", class: "mono wrap" }, { key: "branch", label: "Branch" },
      { key: "head", label: "HEAD", class: "mono", render: (r) => r.head || "-" },
      { key: "remote", label: "Remote", render: (r) => r.remote || "local only" },
      { key: "push", label: "Push", render: (r) => (!r.push ? badge("", "disabled") : r.ahead > 0 ? badge("warn", `${r.ahead} unpushed`) : r.upstream ? badge("ok", "in sync") : badge("warn", "no upstream yet")) },
      { key: "error", label: "", render: (r) => h("span", { class: "err" }, r.error || (r.exists ? "" : "not created yet")) },
    ], repos, { sortable: false, empty: "No Git jobs configured. Create one under Jobs (type: git)." })),
    h("div", { class: "card" }, h("h2", {}, "Recent commits"),
      table([
        { key: "date", label: "Date", render: (c) => `${fmtDate(c.date)} (${ago(c.date)})`, sort: (c) => c.date },
        { key: "sha", label: "Commit", class: "mono", render: (c) => c.sha.slice(0, 10) },
        { key: "subject", label: "Message", class: "mono" },
        { key: "eventId", label: "Update event", render: (c) => (c.eventId ? h("a", { href: "#/history/" + c.eventId }, "view") : "-") },
        { key: "pushed", label: "Pushed", render: (c) => (c.pushed == null ? "n/a" : c.pushed ? badge("ok", "yes") : badge("warn", "no")) },
      ], commits, { sortKey: "date", sortDir: -1, empty: "No commits yet." })));
}
