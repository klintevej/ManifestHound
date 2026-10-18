import { h, get, post, setCsrf, toast, guard } from "./lib.js";
import { overviewPage } from "./p-overview.js";
import { gamesPage } from "./p-games.js";
import { historyPage } from "./p-history.js";
import { jobsPage } from "./p-jobs.js";
import { notifyPage } from "./p-notify.js";
import { reposPage } from "./p-repos.js";
import { settingsPage } from "./p-settings.js";
import { diagPage } from "./p-diag.js";

const PAGES = [
  ["overview", "Overview", overviewPage], ["games", "Games", gamesPage], ["history", "Update history", historyPage], ["jobs", "Jobs", jobsPage],
  ["notifications", "Notifications", notifyPage], ["repos", "Repositories", reposPage], ["settings", "Settings", settingsPage], ["diagnostics", "Diagnostics", diagPage],
];
const root = document.getElementById("app");
let timer = null;
let sessionInfo = {};

function loginView() {
  const pw = h("input", { type: "password", placeholder: "Admin password", autocomplete: "current-password", autofocus: true });
  const go = async () => {
    try { const r = await post("/login", { password: pw.value }); setCsrf(r.csrf); start(); }
    catch (e) { toast(e.message, "bad"); }
  };
  pw.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  root.replaceChildren(h("div", { class: "login card" },
    h("h1", {}, "ManifestHound"), h("p", { class: "muted" }, "Track every build. Catch every change."),
    pw, h("div", { style: "margin-top:12px" }, h("button", { class: "primary", onclick: go }, "Sign in"))));
}

function route() {
  const [, page = "overview", ...rest] = location.hash.split("/");
  return { page: page.split("?")[0] || "overview", rest };
}

async function render() {
  const { page, rest } = route();
  const def = PAGES.find((p) => p[0] === page) || PAGES[0];
  const main = h("main", {}, h("p", { class: "muted" }, "Loading..."));
  root.replaceChildren(h("div", { class: "shell" },
    h("nav", {}, h("div", { class: "brand" }, "ManifestHound", h("small", {}, "Track every build.")),
      PAGES.map(([id, label]) => h("a", { href: "#/" + id, class: id === def[0] ? "active" : "" }, label)),
      h("div", { class: "foot" }, h("a", { href: "#", onclick: async (e) => { e.preventDefault(); await post("/logout"); location.hash = ""; location.reload(); } }, "Sign out"))),
    main));
  clearInterval(timer);
  const draw = async () => {
    if (document.querySelector(".modalback") || main.contains(document.activeElement) && ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) return;
    try {
      const content = await def[2]({ rest, refresh: draw, session: sessionInfo });
      if (sessionInfo.remote) content.prepend(h("div", { class: "banner" }, "Remote access is enabled. Anyone who can reach this port and guess the password can manage this machine's jobs. Put it behind HTTPS and see docs/SECURITY.md."));
      main.replaceChildren(content);
    } catch (e) { main.replaceChildren(h("p", { class: "err" }, e.message)); }
  };
  await draw();
  if (def[0] !== "settings" && def[0] !== "notifications") timer = setInterval(draw, 5000);
}

async function start() {
  const s = await get("/session").catch(() => ({}));
  if (!s.authenticated) return loginView();
  setCsrf(s.csrf); sessionInfo = s;
  render();
}
window.addEventListener("hashchange", () => { if (document.querySelector(".shell")) render(); });
guard(start);
