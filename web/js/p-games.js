import { h, get, post, patch, del, toast, guard, modal, field, check, select, table, ago, dot } from "./lib.js";
import { notifyEditor } from "./p-notify.js";

export async function gamesPage({ refresh }) {
  const [watches, accounts] = await Promise.all([get("/watches"), get("/accounts")]);
  const q = h("input", { type: "search", placeholder: "Search games..." });
  const holder = h("div");
  const draw = () => {
    const f = q.value.toLowerCase();
    const rows = watches.filter((w) => !f || w.name.toLowerCase().includes(f) || String(w.appId).includes(f));
    holder.replaceChildren(table([
      { key: "name", label: "Game", render: (w) => h("span", {}, h("img", { class: "icon", src: w.iconUrl, alt: "", loading: "lazy", onerror: (e) => { e.target.style.visibility = "hidden"; } }), w.name) },
      { key: "appId", label: "App ID", class: "mono" },
      { key: "buildId", label: "Build", class: "mono", render: (w) => w.buildId || "-" },
      { key: "lastUpdateAt", label: "Last update", render: (w) => (w.lastUpdateAt ? ago(w.lastUpdateAt) : "none seen"), sort: (w) => w.lastUpdateAt || "" },
      { key: "manifests", label: "Manifests", class: "mono wrap", sortable: false, render: (w) => {
        const e = Object.entries(w.manifests); if (!e.length) return "-";
        const shown = w.followMode === "depots" ? e.filter(([d]) => w.depotIds.includes(d)) : e;
        return h("details", {}, h("summary", {}, `${shown.length} depot(s)`), shown.map(([d, m]) => h("div", {}, `${d}: ${m}`)));
      } },
      { key: "intervalSec", label: "Poll", render: (w) => w.intervalSec + "s" },
      { key: "followMode", label: "Follows", render: (w) => w.followMode + (w.followMode === "depots" ? ` (${w.depotIds.length})` : "") },
      { key: "status", label: "Status", render: (w) => h("span", {}, dot(w.status), w.status, w.lastCheckAt ? h("div", { class: "note" }, "checked " + ago(w.lastCheckAt)) : null) },
      { key: "accountName", label: "Account", render: (w) => w.accountName || "anonymous" },
      { key: "lastError", label: "Last error", render: (w) => h("span", { class: "err" }, (w.lastError || "").slice(0, 100)), sort: (w) => w.lastError || "" },
      { key: "x", label: "", sortable: false, render: (w) => h("div", { class: "row" },
        h("button", { class: "small", onclick: () => guard(async () => { const r = await post(`/watches/${w.id}/check`); toast(r.ok ? (r.eventId ? `Check done: ${r.kind} recorded` : "Check done: no change") : r.error || r.skipped, r.ok ? "ok" : "bad"); refresh(); }) }, "Check"),
        h("button", { class: "small", onclick: () => guard(async () => { await post(`/watches/${w.id}/${w.enabled ? "pause" : "resume"}`); refresh(); }) }, w.enabled ? "Pause" : "Resume"),
        h("button", { class: "small", onclick: () => editWatch(w) }, "Edit"),
        h("button", { class: "small danger", onclick: () => removeWatch(w) }, "Remove")) },
    ], rows, { sortKey: "name", empty: "No games yet. Click Add game." }));
  };
  q.addEventListener("input", draw);

  function removeWatch(w) {
    const hist = check("Also delete this game's update history, notifications and job logs", false);
    const m = modal(`Remove ${w.name}?`, h("div", {},
      h("p", {}, "Monitoring stops and this game's job definitions are deleted. Files already written to output directories and Git repositories are never touched."),
      hist.el, h("p", { class: "note" }, "If unchecked, past events stay in Update history (marked as orphaned).")), { actions: [
      { label: "Cancel", onclick: (c) => c() },
      { label: "Remove", class: "danger", onclick: (c) => guard(async () => { await del(`/watches/${w.id}?confirm=yes${hist.input.checked ? "&deleteHistory=1" : ""}`); c(); refresh(); }) }] });
    void m;
  }

  function watchForm(w, appInfo) {
    const mode = select([["build", "Overall build ID"], ["depots", "Specific depots"], ["all", "All depots of the game"]], w.followMode);
    const depots = h("input", { value: (w.depotIds || []).join(", "), placeholder: "e.g. 481, 482" });
    const branch = h("input", { value: w.branch || "public" });
    const interval = h("input", { type: "number", min: 1, value: w.intervalSec ?? 60 });
    const acct = select([["", "Anonymous (no account)"], ...accounts.map((a) => [a.id, `${a.name} (${a.status})`])], w.accountId ?? "");
    const baseline = check("Treat the first successful check as a baseline (no notification, no jobs)", w.baselineFirst ?? true);
    const enabled = check("Enabled", w.enabled ?? true);
    const name = h("input", { value: w.name || appInfo?.name || "", placeholder: "Detected automatically" });
    const body = h("div", {},
      field("Name", name), h("div", { class: "grid cols2" }, field("Follow", mode), field("Poll interval (seconds)", interval)),
      field("Depot IDs", depots, "Used when following specific depots. Find IDs on SteamDB or in the manifest list after the first check."),
      h("div", { class: "grid cols2" }, field("Branch", branch, "Password-protected branches need an authorised account."), field("Steam account", acct, "Anonymous access sees public apps. Depot data for apps your account owns may need that account.")),
      baseline.el, enabled.el);
    const collect = () => ({
      name: name.value.trim() || undefined, followMode: mode.value, depotIds: depots.value.split(/[\s,]+/).filter(Boolean), branch: branch.value.trim() || "public",
      intervalSec: Number(interval.value), accountId: acct.value ? Number(acct.value) : null, baselineFirst: baseline.input.checked, enabled: enabled.input.checked,
    });
    return { body, collect };
  }

  function editWatch(w) {
    const f = watchForm(w);
    const nb = h("div");
    const ne = notifyEditor(w.notify, w.id);
    nb.append(ne.el);
    const tabs = h("div", {});
    const m = modal(`Edit ${w.name}`, tabs, { wide: true, actions: [
      { label: "Cancel", onclick: (c) => c() },
      { label: "Save", class: "primary", onclick: (c) => guard(async () => { await patch(`/watches/${w.id}`, { ...f.collect(), notify: ne.collect() }); c(); refresh(); }) }] });
    tabs.append(h("h3", {}, "Monitoring"), f.body, h("h3", {}, "Notifications"), nb);
    void m;
  }

  function addGame() {
    const term = h("input", { placeholder: "Game name or App ID", autofocus: true });
    const results = h("div");
    const picked = { appId: null };
    const formHolder = h("div");
    const search = () => guard(async () => {
      const r = await get(`/steam/search?q=${encodeURIComponent(term.value)}`);
      results.replaceChildren(h("p", { class: "note" }, r.note || ""), ...r.results.map((g) => h("div", { class: "row", style: "margin:4px 0" },
        h("img", { class: "icon", src: g.iconUrl, alt: "" }), h("span", { class: "grow" }, `${g.name} `, h("span", { class: "muted mono" }, g.appId)),
        h("button", { class: "small primary", onclick: () => choose(g) }, "Select"))));
    });
    let form;
    const choose = (g) => {
      picked.appId = g.appId; form = watchForm({ name: g.name }, g);
      formHolder.replaceChildren(h("h3", {}, `${g.name} (${g.appId})`), form.body);
    };
    term.addEventListener("keydown", (e) => { if (e.key === "Enter") search(); });
    modal("Add game", h("div", {}, h("div", { class: "row" }, h("div", { class: "grow" }, term), h("button", { onclick: search }, "Search")), results, formHolder), { wide: true, actions: [
      { label: "Cancel", onclick: (c) => c() },
      { label: "Add and check now", class: "primary", onclick: (c) => guard(async () => {
        if (!picked.appId) { const n = Number(term.value); if (n > 0) choose({ appId: n, name: "" }); else return toast("Search and select a game, or enter an App ID", "bad"); }
        await post("/watches", { appId: picked.appId, ...form.collect() }); c(); refresh();
      }) }] });
  }

  draw();
  return h("div", {},
    h("h1", {}, "Games"),
    h("div", { class: "toolbar" }, q, h("div", { class: "spacer" }), h("button", { class: "primary", onclick: addGame }, "Add game")),
    h("div", { class: "card" }, holder));
}
