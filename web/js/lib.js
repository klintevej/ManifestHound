// Tiny DOM helpers. All text goes through textContent / createTextNode, so server data cannot inject markup.
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (k === "checked" || k === "disabled" || k === "selected") el[k] = !!v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}

let csrf = "";
export const setCsrf = (t) => { csrf = t; };

export async function api(method, path, body) {
  const res = await fetch("/api" + path, {
    method, headers: { "content-type": "application/json", "x-csrf-token": csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && !path.startsWith("/login")) { location.hash = ""; location.reload(); throw new Error("Signed out"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
export const get = (p) => api("GET", p);
export const post = (p, b) => api("POST", p, b ?? {});
export const put = (p, b) => api("PUT", p, b);
export const patch = (p, b) => api("PATCH", p, b);
export const del = (p) => api("DELETE", p);

export function toast(msg, kind = "") {
  const t = h("div", { class: "toast " + kind }, msg);
  document.getElementById("toasts").append(t);
  setTimeout(() => t.remove(), kind === "bad" ? 9000 : 4000);
}
export async function guard(fn) { try { return await fn(); } catch (e) { toast(e.message, "bad"); } }

export function modal(title, body, { wide = false, actions = [] } = {}) {
  const back = h("div", { class: "modalback", onmousedown: (e) => { if (e.target === back) close(); } });
  const close = () => { back.remove(); document.removeEventListener("keydown", esc); };
  const esc = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", esc);
  const box = h("div", { class: "modal" + (wide ? " wide" : ""), role: "dialog", "aria-label": title }, h("h2", {}, title), body,
    actions.length ? h("div", { class: "actions" }, actions.map((a) => h("button", { class: a.class || "", onclick: () => a.onclick(close) }, a.label))) : null);
  back.append(box); document.body.append(back);
  return { close, el: box };
}

export function confirmDialog(title, message, confirmLabel = "Confirm") {
  return new Promise((resolve) => {
    const m = modal(title, h("p", {}, message), { actions: [
      { label: "Cancel", onclick: (c) => { c(); resolve(false); } },
      { label: confirmLabel, class: "danger", onclick: (c) => { c(); resolve(true); } }] });
    void m;
  });
}

export const fmtDate = (s) => (s ? new Date(s).toLocaleString() : "never");
export function ago(s) {
  if (!s) return "never";
  const sec = Math.round((Date.now() - new Date(s).getTime()) / 1000);
  if (sec < 5) return "just now"; if (sec < 90) return sec + "s ago"; if (sec < 5400) return Math.round(sec / 60) + "m ago";
  if (sec < 129600) return Math.round(sec / 3600) + "h ago"; return Math.round(sec / 86400) + "d ago";
}
export const statusClass = (s) => ({ ok: "ok", succeeded: "ok", delivered: "ok", valid: "ok", error: "bad", failed: "bad", expired: "bad", cancelled: "warn", paused: "warn", pending: "info",
  queued: "info", running: "info", sending: "info", skipped: "", suppressed: "", rollback: "warn", update: "info" }[s] || "");
export const badge = (s, label) => h("span", { class: "badge " + statusClass(s) }, label ?? s);
export const dot = (s) => h("span", { class: "dot " + (s === "ok" ? "ok" : s === "error" ? "bad" : s === "paused" || s === "pending" ? "warn" : "") });

export function field(label, input, note) { return h("div", {}, h("label", {}, label), input, note ? h("div", { class: "note" }, note) : null); }
export function check(label, checked) { const i = h("input", { type: "checkbox", checked }); return { el: h("label", { class: "inline" }, i, label), input: i }; }
export function select(options, value) {
  return h("select", {}, options.map(([v, l]) => h("option", { value: v, selected: String(v) === String(value) }, l)));
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied", "ok"); }
  catch { toast("Copy failed. Select the text and copy manually.", "bad"); }
}

/** Sortable table. cols: [{key, label, render?(row), sort?(row)}] */
export function table(cols, rows, { sortKey, sortDir = 1, onRow, empty = "Nothing here yet." } = {}) {
  const wrap = h("div", { class: "tablewrap" });
  let key = sortKey, dir = sortDir;
  const draw = () => {
    let data = [...rows];
    const col = cols.find((c) => c.key === key);
    if (col) data.sort((a, b) => { const x = (col.sort || ((r) => r[col.key]))(a), y = (col.sort || ((r) => r[col.key]))(b); return (x > y ? 1 : x < y ? -1 : 0) * dir; });
    wrap.replaceChildren(data.length ? h("table", {},
      h("thead", {}, h("tr", {}, cols.map((c) => h("th", { class: c.sortable === false ? "" : "sortable", onclick: () => { if (c.sortable === false) return; dir = key === c.key ? -dir : 1; key = c.key; draw(); } },
        c.label, key === c.key ? (dir > 0 ? " asc" : " desc") : "")))),
      h("tbody", {}, data.map((r) => h("tr", {}, cols.map((c) => h("td", { class: c.class || "" }, c.render ? c.render(r) : (r[c.key] ?? "")))))))
      : h("p", { class: "muted" }, empty));
  };
  draw();
  return wrap;
}
