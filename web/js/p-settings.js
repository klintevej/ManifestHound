import { h, get, post, put, del, guard, toast, modal, field, check, select, table, badge, ago, confirmDialog } from "./lib.js";

let tab = "polling";
const TABS = [["polling", "Polling"], ["steam", "Steam accounts"], ["storage", "Storage"], ["jobs", "Jobs and tools"], ["git", "Git"], ["destinations", "Upload destinations"], ["logging", "Logging"], ["network", "Network"], ["security", "Security"]];

export async function settingsPage({ refresh }) {
  const data = await get("/settings");
  const s = data.settings;
  const save = (patch) => guard(async () => { await put("/settings", patch); toast("Saved", "ok"); });
  const num = (v, min = 0) => h("input", { type: "number", min, value: v });
  const body = h("div", { class: "card" });

  const panels = {
    polling() {
      const iv = num(s.polling.defaultIntervalSec, 5), mn = num(s.polling.minIntervalSec, 1), conc = num(s.polling.maxConcurrentChecks, 1);
      const base = check("New games: treat the first successful check as a baseline (no notification)", s.polling.baselineOnFirstCheck);
      const to = num(s.steam.requestTimeoutMs, 2000), rt = num(s.steam.retries, 0), gap = num(s.steam.minRequestGapMs, 0);
      const fb = check("Use third-party public mirror (api.steamcmd.net) as a fallback when Steam login fails", s.steam.usePublicFallback);
      return h("div", {}, h("h2", {}, "Polling defaults"),
        h("div", { class: "grid cols2" }, field("Default interval (s)", iv), field("Minimum allowed interval (s)", mn, "Aggressive polling can get your IP throttled by Steam.")),
        field("Concurrent checks", conc), base.el,
        h("h2", { style: "margin-top:18px" }, "Steam requests"), h("div", { class: "grid cols2" }, field("Request timeout (ms)", to), field("Retries per check", rt)),
        field("Minimum gap between requests (ms)", gap), fb.el, h("p", { class: "note" }, "Unofficial third-party service. Leave off to read everything directly from Steam."),
        h("button", { class: "primary", onclick: () => save({ polling: { defaultIntervalSec: +iv.value, minIntervalSec: +mn.value, maxConcurrentChecks: +conc.value, baselineOnFirstCheck: base.input.checked },
          steam: { requestTimeoutMs: +to.value, retries: +rt.value, minRequestGapMs: +gap.value, usePublicFallback: fb.input.checked } }) }, "Save"));
    },
    steam() {
      return h("div", {}, h("h2", {}, "Steam accounts"),
        h("p", { class: "note" }, "Only needed for apps or branches your account owns. Your password goes to Steam and is not stored."),
        h("div", { class: "toolbar" }, h("button", { class: "primary", onclick: () => loginDialog() }, "Add / re-authenticate account")),
        h("div", { id: "acct" }));
    },
    storage() {
      const wd = h("input", { value: s.paths.workDir, placeholder: data.paths.workDir }), roots = h("textarea", {}, s.paths.allowedRoots.join("\n"));
      return h("div", {}, h("h2", {}, "Storage paths"), field("Work directory (job outputs)", wd, `Empty = ${data.paths.workDir}`),
        field("Allowed roots, one per line", roots, "Jobs may only read or write inside the work directory and these folders: game install directories, depot download folders, Git repositories."),
        h("p", { class: "note" }, "Data directory is set with MH_DATA_DIR."),
        h("button", { class: "primary", onclick: () => save({ paths: { workDir: wd.value.trim(), allowedRoots: roots.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) } }) }, "Save"));
    },
    jobs() {
      const mc = num(s.jobs.maxConcurrent, 1), to = num(s.jobs.defaultTimeoutSec, 5);
      const il = h("input", { value: s.tools.ilspyCmdPath }), dd = h("input", { value: s.tools.depotDownloaderPath });
      return h("div", {}, h("h2", {}, "Job execution"), h("div", { class: "grid cols2" }, field("Max concurrent jobs", mc), field("Default timeout (s)", to)),
        h("h2", { style: "margin-top:18px" }, "Decompiler"), field("ilspycmd executable", il, "Install: dotnet tool install -g ilspycmd"),
        h("h2", { style: "margin-top:18px" }, "Depot downloader"), field("DepotDownloader executable", dd, "Release zip from github.com/SteamRE/DepotDownloader (windows-x64, linux-x64 or linux-arm64). Full path is fine."),
        h("button", { class: "primary", onclick: () => save({ jobs: { maxConcurrent: +mc.value, defaultTimeoutSec: +to.value }, tools: { ilspyCmdPath: il.value, depotDownloaderPath: dd.value.trim() } }) }, "Save"));
    },
    git() {
      const gp = h("input", { value: s.git.gitPath }), gn = h("input", { value: s.git.authorName }), ge = h("input", { value: s.git.authorEmail });
      return h("div", {}, h("h2", {}, "Commit identity"),
        h("p", { class: "note" }, "Used for all commits unless a job overrides it. This name and email are public in the repository history."),
        h("div", { class: "grid cols2" }, field("Author name", gn), field("Author email", ge)), field("git executable", gp),
        h("button", { class: "primary", onclick: () => save({ git: { gitPath: gp.value.trim(), authorName: gn.value.trim(), authorEmail: ge.value.trim() } }) }, "Save identity"),
        h("h2", { style: "margin-top:22px" }, "Push credentials"),
        h("p", { class: "note" }, "For https remotes. The secret is stored encrypted and only sent to the remote's host. SSH remotes use your SSH keys."),
        h("div", { id: "gitcreds" }));
    },
    destinations() { return h("div", {}, h("h2", {}, "Upload destinations"), h("div", { id: "dests" })); },
    logging() {
      const lv = select(["debug", "info", "warn", "error"].map((x) => [x, x]), s.logging.level), rd = num(s.logging.retentionDays, 1);
      return h("div", {}, h("h2", {}, "Logging"), h("div", { class: "grid cols2" }, field("Level", lv), field("Keep log files for (days)", rd)),
        h("button", { class: "primary", onclick: () => save({ logging: { level: lv.value, retentionDays: +rd.value } }) }, "Save"));
    },
    network() {
      const host = h("input", { value: data.network.host }), port = num(data.network.port, 1), remote = check("Allow remote (non-localhost) access", data.network.allowRemote);
      return h("div", {}, h("h2", {}, "Network"), h("div", { class: "banner" }, "Changes apply after restarting ManifestHound. The default (127.0.0.1) is only reachable from this PC."),
        h("div", { class: "grid cols2" }, field("Listen address", host), field("Port", port)), remote.el,
        h("p", { class: "note" }, "Remote access is plain HTTP unless you put a TLS proxy in front."),
        h("button", { class: "primary", onclick: () => guard(async () => { await put("/network", { host: host.value.trim(), port: +port.value, allowRemote: remote.input.checked }); toast("Saved. Restart to apply.", "ok"); }) }, "Save"));
    },
    security() {
      const ttl = num(s.security.sessionTtlHours, 1), base = h("input", { value: s.security.publicBaseUrl, placeholder: `http://127.0.0.1:${data.network.port}` });
      const cur = h("input", { type: "password", autocomplete: "current-password" }), nw = h("input", { type: "password", autocomplete: "new-password" });
      return h("div", {}, h("h2", {}, "Application security"), h("div", { class: "grid cols2" }, field("Session lifetime (hours)", ttl), field("Public base URL for dashboard links in messages", base)),
        h("button", { class: "primary", onclick: () => save({ security: { sessionTtlHours: +ttl.value, publicBaseUrl: base.value.trim() } }) }, "Save"),
        h("h2", { style: "margin-top:20px" }, "Admin password"), data.passwordFromEnv ? h("p", { class: "note" }, "Set through MH_ADMIN_PASSWORD; change it in your environment.")
          : h("div", {}, h("div", { class: "grid cols2" }, field("Current password", cur), field("New password (10+ characters)", nw)),
            h("button", { onclick: () => guard(async () => { await post("/auth/password", { current: cur.value, next: nw.value }); toast("Password changed. Signing out...", "ok"); setTimeout(() => location.reload(), 1200); }) }, "Change password")));
    },
  };

  const tabs = h("div", { class: "tabs" }, TABS.map(([id, l]) => h("button", { class: id === tab ? "active" : "", onclick: () => { tab = id; refresh(); } }, l)));
  body.append(panels[tab]());
  const page = h("div", {}, h("h1", {}, "Settings"), tabs, body);
  if (tab === "steam") renderAccounts(page.querySelector("#acct"), refresh);
  if (tab === "git") renderGitCreds(page.querySelector("#gitcreds"), refresh);
  if (tab === "destinations") renderDestinations(page.querySelector("#dests"), refresh);
  return page;
}

async function renderAccounts(el, refresh) {
  const accts = await get("/accounts");
  el.replaceChildren(table([
    { key: "name", label: "Name" }, { key: "username", label: "Steam login" }, { key: "status", label: "Session", render: (a) => badge(a.status, a.status === "valid" ? "valid" : a.status) },
    { key: "status_detail", label: "Detail" }, { key: "last_validated_at", label: "Validated", render: (a) => ago(a.last_validated_at) },
    { key: "x", label: "", sortable: false, render: (a) => h("div", { class: "row" },
      h("button", { class: "small", onclick: () => loginDialog(a) }, a.status === "valid" ? "Re-authenticate" : "Sign in again"),
      h("button", { class: "small danger", onclick: async () => { if (await confirmDialog("Remove account?", "Games using it fall back to anonymous access.", "Remove")) guard(async () => { await del(`/accounts/${a.id}?confirm=yes`); refresh(); }); } }, "Remove")) },
  ], accts, { empty: "No accounts. Monitoring uses anonymous Steam access." }));
}

function loginDialog(existing) {
  const name = h("input", { value: existing?.name || "", disabled: !!existing }), user = h("input", { value: existing?.username || "", autocomplete: "off" }), pw = h("input", { type: "password", autocomplete: "off" });
  const save = check("Save the password (encrypted) so downloads can use this account", !!existing?.has_password);
  const area = h("div");
  let pending = null, poll = null;
  const m = modal("Steam sign-in", h("div", {}, field("Account label", name), field("Steam account name", user), field("Password", pw, "Sent to Steam. Only kept if you tick the box below."), save.el, area), { actions: [
    { label: "Close", onclick: (c) => { clearInterval(poll); if (pending) del("/accounts/login/" + pending).catch(() => {}); c(); refresh(); } },
    { label: "Sign in", class: "primary", onclick: () => guard(async () => {
      const r = await post("/accounts/login", { name: name.value, username: user.value, password: pw.value, savePassword: save.input.checked }); pw.value = ""; pending = r.pendingId; show(r);
    }) }] });
  function show(r) {
    clearInterval(poll);
    if (r.state === "authenticated") { area.replaceChildren(h("p", { class: "ok" }, "Signed in. Session saved.")); pending = null; return; }
    if (r.state === "failed") return area.replaceChildren(h("p", { class: "err" }, r.error || "Sign-in failed"));
    const needsCode = r.actions.find((a) => a.type === "email_code" || a.type === "device_code");
    const confirm = r.actions.find((a) => a.type.endsWith("confirmation"));
    const code = h("input", { placeholder: "Steam Guard code", maxlength: 10 });
    area.replaceChildren(
      needsCode ? h("div", {}, h("p", {}, needsCode.type === "email_code" ? "Enter the code Steam emailed you." : "Enter the code from your Steam Mobile app."), code,
        h("button", { class: "primary", style: "margin-top:8px", onclick: () => guard(async () => show(await post(`/accounts/login/${pending}/code`, { code: code.value.trim() }))) }, "Submit code")) : null,
      confirm ? h("p", {}, confirm.type === "device_confirmation" ? "Approve this sign-in in your Steam Mobile app. This dialog continues automatically." : "Click the confirmation link Steam emailed you. This dialog continues automatically.") : null,
      !needsCode && !confirm ? h("p", { class: "muted" }, "Waiting for Steam...") : null);
    poll = setInterval(() => get("/accounts/login/" + pending).then((s) => { if (s.state !== "waiting") show(s); }).catch(() => clearInterval(poll)), 2500);
  }
  void m;
}

async function renderDestinations(el, refresh) {
  const dests = await get("/destinations");
  const FIELDS = {
    local: [["dir", "Directory (inside allowed roots)"]],
    http: [["url", "URL (may contain {filename})"], ["method", "Method (PUT or POST)"], ["authHeader", "Auth header name"], ["authValue", "Auth header value", true]],
    s3: [["endpoint", "Endpoint (empty = AWS)"], ["region", "Region"], ["bucket", "Bucket"], ["prefix", "Key prefix"], ["accessKeyId", "Access key ID", true], ["secretAccessKey", "Secret access key", true]],
    sftp: [["host", "Host"], ["port", "Port"], ["username", "Username"], ["remoteDir", "Remote directory"], ["password", "Password", true], ["privateKey", "Private key (PEM)", true], ["passphrase", "Key passphrase", true]],
  };
  function form(d) {
    const type = select(Object.keys(FIELDS).map((t) => [t, t]), d?.type || "s3"); if (d) type.disabled = true;
    const name = h("input", { value: d?.name || "" }), priv = check("Allow private/LAN addresses (needed for a NAS or local server)", d?.allowPrivate);
    const inputs = h("div");
    const vals = {};
    const draw = () => {
      inputs.replaceChildren(...FIELDS[type.value].map(([k, label, secret]) => {
        const cur = d?.config?.[k];
        const i = h("input", { type: secret ? "password" : "text", autocomplete: "off", value: secret ? "" : cur ?? "", placeholder: secret && d?.secretsSet?.includes(k) ? "Stored. Type to replace." : "" });
        if (k === "privateKey") i.setAttribute("type", "password");
        vals[k] = { i, secret }; return field(label, i);
      }));
    };
    type.addEventListener("change", draw); draw();
    modal(d ? `Edit ${d.name}` : "New upload destination", h("div", {}, h("div", { class: "grid cols2" }, field("Name", name), field("Type", type)), inputs, priv.el,
      h("p", { class: "note" }, "SFTP pins the host key on first connect.")), { actions: [
      { label: "Cancel", onclick: (c) => c() },
      { label: "Save", class: "primary", onclick: (c) => guard(async () => {
        const config = {}, secrets = {};
        for (const [k, { i, secret }] of Object.entries(vals)) { if (!FIELDS[type.value].some(([x]) => x === k)) continue; if (secret) { if (i.value) secrets[k] = i.value; } else if (i.value !== "") config[k] = k === "port" ? +i.value : i.value; }
        if (type.value === "s3") config.forcePathStyle = d?.config?.forcePathStyle ?? true;
        const b = { name: name.value, type: type.value, config, secrets, allowPrivate: priv.input.checked };
        if (d) await put("/destinations/" + d.id, b); else await post("/destinations", b);
        c(); refresh();
      }) }] });
  }
  el.replaceChildren(h("div", { class: "toolbar" }, h("button", { class: "primary", onclick: () => form() }, "New destination")),
    table([{ key: "name", label: "Name" }, { key: "type", label: "Type" }, { key: "config", label: "Target", class: "mono wrap", render: (d) => d.config.url || d.config.host || d.config.bucket || d.config.dir || "" },
      { key: "secretsSet", label: "Secrets", render: (d) => (d.secretsSet.length ? "stored" : "none") },
      { key: "x", label: "", sortable: false, render: (d) => h("div", { class: "row" },
        h("button", { class: "small", onclick: () => guard(async () => { toast("Uploading a small test file..."); const r = await post(`/destinations/${d.id}/test`); toast(r.ok ? `OK: ${r.location}${r.verified ? " (verified)" : ""}` : `Failed: ${r.error}`, r.ok ? "ok" : "bad"); }) }, "Test"),
        h("button", { class: "small", onclick: () => form(d) }, "Edit"),
        h("button", { class: "small danger", onclick: async () => { if (await confirmDialog("Delete destination?", `Archive jobs referencing "${d.name}" will fail until updated.`, "Delete")) guard(async () => { await del("/destinations/" + d.id); refresh(); }); } }, "Delete")) },
    ], dests, { empty: "No destinations. Archive jobs can still create local ZIPs." }));
}

async function renderGitCreds(el, refresh) {
  const creds = await get("/git/credentials");
  function form(c) {
    const name = h("input", { value: c?.name || "", placeholder: "e.g. GitHub PAT" });
    const kind = select([["pat", "Personal access token (GitHub, GitLab, Gitea...)"], ["password", "Username and account password"]], c?.kind || "pat");
    const user = h("input", { value: c?.username || "", autocomplete: "off" });
    const secret = h("input", { type: "password", autocomplete: "new-password", placeholder: c ? "Stored. Type to replace." : "" });
    const note = h("p", { class: "note" });
    const sync = () => {
      note.textContent = kind.value === "pat"
        ? "GitHub: create a token with Contents: read and write on the target repository (fine-grained) or the repo scope (classic). The username can stay empty."
        : "Works with servers that accept account passwords over HTTPS (Gitea, GitLab, Bitbucket Server...). GitHub no longer accepts passwords for git: use a token.";
    };
    kind.addEventListener("change", sync); sync();
    modal(c ? "Edit " + c.name : "New Git credential", h("div", {}, field("Name", name), field("Type", kind), field("Username", user, "Required for passwords. Optional for tokens."), field("Token / password", secret), note), { actions: [
      { label: "Cancel", onclick: (x) => x() },
      { label: "Save", class: "primary", onclick: (x) => guard(async () => {
        const body = { name: name.value, kind: kind.value, username: user.value };
        if (secret.value) body.secret = secret.value;
        if (c) await put("/git/credentials/" + c.id, body); else await post("/git/credentials", body);
        x(); refresh();
      }) }] });
  }
  function test(c) {
    const url = h("input", { placeholder: "https://github.com/you/repo.git" });
    const priv = check("Allow private/LAN address (self-hosted server)", false);
    modal("Test " + c.name, h("div", {}, field("Repository URL", url, "Runs git ls-remote with this credential. Nothing is changed."), priv.el), { actions: [
      { label: "Close", onclick: (x) => x() },
      { label: "Test", class: "primary", onclick: () => guard(async () => {
        const r = await post("/git/credentials/" + c.id + "/test", { url: url.value.trim(), allowPrivate: priv.input.checked });
        toast(r.ok ? "Credential works (" + r.branches + " branch(es) visible)" : "Failed: " + r.error, r.ok ? "ok" : "bad");
      }) }] });
  }
  el.replaceChildren(h("div", { class: "toolbar" }, h("button", { class: "primary", onclick: () => form() }, "New credential")),
    table([{ key: "name", label: "Name" }, { key: "kind", label: "Type", render: (c) => (c.kind === "pat" ? "Access token" : "Account password") }, { key: "username", label: "Username", render: (c) => c.username || "-" },
      { key: "x", label: "", sortable: false, render: (c) => h("div", { class: "row" },
        h("button", { class: "small", onclick: () => test(c) }, "Test"), h("button", { class: "small", onclick: () => form(c) }, "Edit"),
        h("button", { class: "small danger", onclick: async () => { if (await confirmDialog("Delete credential?", c.name + " is removed. Jobs using it must be pointed at another.", "Delete")) guard(async () => { await del("/git/credentials/" + c.id); refresh(); }); } }, "Delete")) },
    ], creds, { empty: "No credentials. Pushes use Git Credential Manager or SSH keys." }));
}
