import { h, get, post, put, del, guard, toast, modal, field, check, select, table, badge, ago, confirmDialog } from "./lib.js";

const PRESETS = {
  collect: { selection: { root: "C:/Games/Steam/steamapps/common/YourGame", include: ["**/Managed/*.dll"], exclude: ["**/*.pdb"], extensions: [".dll"], recursive: true } },
  report: { selection: { root: "C:/Games/Steam/steamapps/common/YourGame", extensions: [".dll", ".exe"], recursive: true } },
  archive: { selection: { sourceJobId: null, root: "", include: ["**/*"] }, include: { files: true, metadata: true }, destinationIds: [], compressionLevel: 6 },
  decompile: { selection: { root: "C:/Games/Steam/steamapps/common/YourGame" }, assemblies: ["Assembly-CSharp.dll"], languageVersion: "Latest", onExisting: "overwrite", copyInputs: true, strict: false },
  git: { repoPath: "", credentialId: null, authorName: "", authorEmail: "", init: true, branch: "main", push: false, remoteName: "origin", remoteUrl: "", allowMetadataOnlyCommit: false, sources: [{ sourceJobId: null, path: "src", dest: "YourGame", mirror: true }] },
};
const HELP = {
  collect: "Copies the selected files (globs, extensions, exclusions) into the job's output directory and writes added/modified/removed/unchanged reports with SHA-256 hashes.",
  report: "Like Collect, but only writes reports (Markdown, HTML, JSON). Nothing is copied.",
  archive: "Zips the selection plus metadata.json and uploads it to the destinations listed in destinationIds (configure them in Settings > Upload destinations).",
  decompile: "Runs ILSpy (ilspycmd) on the listed managed assemblies and exports C# projects (no .sln, no token comments). Native DLLs are reported and skipped. onExisting: versioned | overwrite | skip | fail.",
  git: "Mirrors source folders into a repository, commits \"Manifest <id> <timestamp>\" when files changed, optionally pushes. Use sources[].sourceJobId + path to take another job's output (e.g. the decompile job's \"src\" folder).",
};

export async function jobsPage({ refresh }) {
  const [jobs, watches, runs, creds] = await Promise.all([get("/jobs"), get("/watches"), get("/job-runs"), get("/git/credentials")]);
  const nameOf = (id) => (id == null ? "All games" : watches.find((w) => w.id === id)?.name ?? `#${id}`);

  function edit(j) {
    const isNew = !j;
    j = j || { type: "collect", name: "", enabled: true, ord: 10, timeoutSec: 1800, maxRetries: 1, stopOnFail: false, depotFilter: [], config: PRESETS.collect, watchId: watches[0]?.id ?? null, secretsSet: [] };
    const name = h("input", { value: j.name }), desc = h("input", { value: j.description || "" });
    const type = select(Object.keys(PRESETS).map((t) => [t, t]), j.type); if (!isNew) type.disabled = true;
    const game = select([["", "All games"], ...watches.map((w) => [w.id, w.name])], j.watchId ?? "");
    const ord = h("input", { type: "number", value: j.ord }), timeout = h("input", { type: "number", value: j.timeoutSec }), retries = h("input", { type: "number", value: j.maxRetries });
    const depots = h("input", { value: (j.depotFilter || []).join(", "), placeholder: "Only run when one of these depots changed (empty = always)" });
    const out = h("input", { value: j.outputDir || "", placeholder: "Default: <work dir>/<app id>/<job>" });
    const en = check("Enabled", j.enabled), stop = check("A failure stops later jobs for the same update", j.stopOnFail);
    const cfg = h("textarea", { style: "min-height:240px" }, JSON.stringify(j.config, null, 2));
    const help = h("p", { class: "note" }, HELP[j.type]);
    const credSel = select([["", "None (Git Credential Manager / SSH keys)"], ...creds.map((c) => [c.id, c.name + (c.kind === "pat" ? " (token)" : " (password)")])], j.config?.credentialId ?? "");
    const tokenField = field("Git push credential", credSel, "Manage under Settings > Git. Author name and email default to Settings > Git; override with authorName / authorEmail in the JSON.");
    credSel.addEventListener("change", () => { try { const c = JSON.parse(cfg.value); c.credentialId = credSel.value ? Number(credSel.value) : null; cfg.value = JSON.stringify(c, null, 2); } catch { toast("Fix the JSON first", "bad"); } });
    const syncType = () => { help.textContent = HELP[type.value]; tokenField.style.display = type.value === "git" ? "" : "none"; };
    type.addEventListener("change", () => { cfg.value = JSON.stringify(PRESETS[type.value], null, 2); syncType(); });
    syncType();
    modal(isNew ? "New job" : `Edit ${j.name}`, h("div", {}, h("div", { class: "grid cols2" }, field("Name", name), field("Type", type)), field("Description", desc),
      h("div", { class: "grid cols2" }, field("Game", game), field("Order (lower first; equal runs in parallel)", ord)),
      h("div", { class: "grid cols2" }, field("Timeout (s)", timeout), field("Retries", retries)),
      field("Depot filter", depots), field("Output directory", out, "Must be inside the work directory or an allowed root (Settings > Storage)."),
      en.el, stop.el, help, field("Configuration (JSON)", cfg), tokenField), { wide: true, actions: [
      { label: "Cancel", onclick: (c) => c() },
      { label: "Save", class: "primary", onclick: (c) => guard(async () => {
        let config; try { config = JSON.parse(cfg.value); } catch (e) { throw new Error("Configuration is not valid JSON: " + e.message); }
        const body = { name: name.value, description: desc.value || null, type: type.value, watchId: game.value ? Number(game.value) : null, ord: Number(ord.value), timeoutSec: Number(timeout.value),
          maxRetries: Number(retries.value), depotFilter: depots.value.split(/[\s,]+/).filter(Boolean), outputDir: out.value.trim() || null, enabled: en.input.checked, stopOnFail: stop.input.checked, config };
        if (isNew) await post("/jobs", body); else await put("/jobs/" + j.id, body);
        c(); refresh();
      }) }] });
  }

  return h("div", {},
    h("h1", {}, "Jobs"),
    h("div", { class: "card" }, h("div", { class: "row" }, h("h2", {}, "Post-update jobs"), h("div", { class: "spacer" }), h("button", { class: "primary small", onclick: () => edit() }, "New job")),
      table([
        { key: "ord", label: "Order" }, { key: "name", label: "Name", render: (j) => h("span", {}, j.name, j.enabled ? "" : h("span", { class: "muted" }, " (disabled)")) },
        { key: "type", label: "Type", render: (j) => badge("", j.type) }, { key: "watchId", label: "Game", render: (j) => nameOf(j.watchId), sort: (j) => nameOf(j.watchId) },
        { key: "lastStatus", label: "Last run", render: (j) => (j.lastStatus ? h("span", {}, badge(j.lastStatus), " ", ago(j.lastFinishedAt)) : "never") },
        { key: "x", label: "", sortable: false, render: (j) => h("div", { class: "row" },
          h("button", { class: "small", title: "Runs against the latest event (or current known state) using existing local files", onclick: () => guard(async () => { await post(`/jobs/${j.id}/run`); toast("Queued", "ok"); refresh(); }) }, "Run now"),
          h("button", { class: "small", onclick: () => edit(j) }, "Edit"),
          h("button", { class: "small danger", onclick: async () => { if (await confirmDialog("Delete job?", `"${j.name}" and its file snapshot are removed. Output files stay on disk.`, "Delete")) guard(async () => { await del(`/jobs/${j.id}?confirm=yes`); refresh(); }); } }, "Delete")) },
      ], jobs, { sortKey: "ord", empty: "No jobs yet." })),
    h("div", { class: "card" }, h("h2", {}, "Recent runs"),
      table([
        { key: "id", label: "#" }, { key: "job_name", label: "Job", render: (r) => h("a", { href: "#/history/" + r.event_id }, r.job_name + (r.manual ? " (manual)" : "")) },
        { key: "status", label: "Status", render: (r) => badge(r.status) }, { key: "attempts", label: "Tries" },
        { key: "finished_at", label: "Finished", render: (r) => (r.finished_at ? ago(r.finished_at) : "-") }, { key: "error", label: "Error", render: (r) => h("span", { class: "err" }, (r.error || "").slice(0, 120)) },
      ], runs, { sortKey: "id", sortDir: -1, empty: "Nothing has run yet." })));
}
