/**
 * ManifestHound message templates. See docs/TEMPLATES.md for the user-facing reference.
 *
 *   {var}                   variable (unknown value => "unavailable")
 *   {var:arg}               variable with argument ({timestamp:R}, {date:YYYY-MM-DD}, {manifest:228983})
 *   {var|upper|truncate:20} filters
 *   {#if var}..{#else}..{/if}   conditional (non-empty and not "unavailable")
 *   {#each depots}..{/each}     loop; inside use {depot_id} {manifest_id} {prev_manifest_id} {change}
 *   {{ and }}               literal braces
 */
export const UNAVAILABLE = "unavailable";

export interface TemplateContext {
  vars: Record<string, string | number | null | undefined>;
  dates: Record<string, Date | null | undefined>;
  depots: { depot_id: string; manifest_id: string; prev_manifest_id: string; change: string }[];
  timezone: string;       // IANA name
}

type Node =
  | { t: "text"; v: string }
  | { t: "expr"; raw: string }
  | { t: "if"; cond: string; yes: Node[]; no: Node[] }
  | { t: "each"; list: string; body: Node[] };

const DISCORD_STYLES = new Set(["t", "T", "d", "D", "f", "F", "R"]);

export function isValidTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

function parse(src: string): Node[] {
  let i = 0;
  function block(stop: string[]): { nodes: Node[]; end: string | null } {
    const nodes: Node[] = [];
    let text = "";
    const flush = () => { if (text) { nodes.push({ t: "text", v: text }); text = ""; } };
    while (i < src.length) {
      const c = src[i];
      if (c === "{" && src[i + 1] === "{") { text += "{"; i += 2; continue; }
      if (c === "}" && src[i + 1] === "}") { text += "}"; i += 2; continue; }
      if (c === "{") {
        const close = src.indexOf("}", i);
        if (close < 0) { text += src.slice(i); i = src.length; break; }
        const tag = src.slice(i + 1, close).trim();
        i = close + 1;
        if (tag.startsWith("#if ")) {
          flush();
          const yes = block(["#else", "/if"]);
          let no: Node[] = [];
          if (yes.end === "#else") no = block(["/if"]).nodes;
          nodes.push({ t: "if", cond: tag.slice(4).trim(), yes: yes.nodes, no });
        } else if (tag.startsWith("#each ")) {
          flush();
          nodes.push({ t: "each", list: tag.slice(6).trim(), body: block(["/each"]).nodes });
        } else if (stop.includes(tag)) { flush(); return { nodes, end: tag }; }
        else { flush(); nodes.push({ t: "expr", raw: tag }); }
        continue;
      }
      text += c; i++;
    }
    flush();
    return { nodes, end: null };
  }
  return block([]).nodes;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Format a date in an IANA timezone with Moment-style tokens: YYYY YY MMMM MMM MM M dddd ddd DD D HH H hh h mm m ss s SSS A a Z ZZ z X x. Use [text] to escape. */
export function formatDate(d: Date, fmt: string, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "long",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const Y = Number(get("year")), M = Number(get("month")), D = Number(get("day")), H = Number(get("hour")) % 24, m = Number(get("minute")), s = Number(get("second"));
  const wd = DAYS.indexOf(get("weekday"));
  // Offset: compare wall-clock-as-UTC against the real instant.
  const asUtc = Date.UTC(Y, M - 1, D, H, m, s);
  const offMin = Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
  const sign = offMin >= 0 ? "+" : "-";
  const oh = String(Math.floor(Math.abs(offMin) / 60)).padStart(2, "0"), om = String(Math.abs(offMin) % 60).padStart(2, "0");
  const tzName = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? tz;
  const p2 = (n: number) => String(n).padStart(2, "0");
  const map: Record<string, string> = {
    YYYY: String(Y), YY: String(Y).slice(-2), MMMM: MONTHS[M - 1], MMM: MONTHS[M - 1].slice(0, 3), MM: p2(M), M: String(M),
    dddd: DAYS[wd], ddd: DAYS[wd].slice(0, 3), DD: p2(D), D: String(D), HH: p2(H), H: String(H),
    hh: p2(H % 12 || 12), h: String(H % 12 || 12), mm: p2(m), m: String(m), ss: p2(s), s: String(s),
    SSS: String(d.getUTCMilliseconds()).padStart(3, "0"), A: H < 12 ? "AM" : "PM", a: H < 12 ? "am" : "pm",
    ZZ: `${sign}${oh}${om}`, Z: `${sign}${oh}:${om}`, z: tzName, X: String(Math.floor(d.getTime() / 1000)), x: String(d.getTime()),
  };
  return fmt.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DD|D|HH|H|hh|h|mm|m|ss|s|SSS|A|a|ZZ|Z|z|X|x/g, (tok, lit) => (lit !== undefined ? lit : map[tok]));
}

const FILTERS: Record<string, (v: string, arg?: string) => string> = {
  upper: (v) => v.toUpperCase(),
  lower: (v) => v.toLowerCase(),
  trim: (v) => v.trim(),
  code: (v) => (v === UNAVAILABLE ? v : "`" + v.replace(/`/g, "'") + "`"),
  escape: (v) => v.replace(/([\\*_~`|>])/g, "\\$1"),
  truncate: (v, a) => { const n = Math.max(1, Number(a) || 50); return v.length > n ? v.slice(0, Math.max(1, n - 3)) + "..." : v; },
  default: (v, a) => (v === UNAVAILABLE || v === "" ? a ?? "" : v),
};

export interface RenderResult { text: string; warnings: string[] }

export function render(template: string, ctx: TemplateContext): RenderResult {
  const warnings: string[] = [];
  const warn = (w: string) => { if (!warnings.includes(w)) warnings.push(w); };
  const ast = parse(template);

  const dateValue = (name: string, arg: string | undefined, scope: TemplateContext): string | null => {
    const known = ["timestamp", "detected_at", "update_time", "date", "time", "datetime", "unix", "iso"];
    if (!known.includes(name)) return null;
    // timestamp/detected_at/update_time are the real instants; date/time/datetime/unix/iso are views of the event time.
    const src = name === "detected_at" || name === "update_time" ? scope.dates[name] : scope.dates.timestamp;
    if (!src) return UNAVAILABLE;
    const tz = scope.timezone;
    switch (name) {
      case "unix": return String(Math.floor(src.getTime() / 1000));
      case "iso": return src.toISOString();
      case "date": return formatDate(src, arg || "YYYY-MM-DD", tz);
      case "time": return formatDate(src, arg || "HH:mm:ss", tz);
      case "datetime": return formatDate(src, arg || "YYYY-MM-DD HH:mm:ss z", tz);
      default:
        if (!arg) return `<t:${Math.floor(src.getTime() / 1000)}:F>`;
        if (DISCORD_STYLES.has(arg)) return `<t:${Math.floor(src.getTime() / 1000)}:${arg}>`;
        return formatDate(src, arg, tz);
    }
  };

  const value = (raw: string, scope: TemplateContext, loop?: Record<string, string>): string => {
    const [head, ...filters] = raw.split("|").map((s) => s.trim());
    const ci = head.indexOf(":");
    const name = (ci < 0 ? head : head.slice(0, ci)).trim();
    const arg = ci < 0 ? undefined : head.slice(ci + 1);
    let out: string;
    if (loop && name in loop) out = loop[name] || UNAVAILABLE;
    else if (name === "manifest" && arg) {
      out = scope.depots.find((d) => d.depot_id === arg.trim())?.manifest_id ?? UNAVAILABLE;
    } else {
      const d = dateValue(name, arg, scope);
      if (d !== null) out = d;
      else if (name in scope.vars) {
        const v = scope.vars[name];
        out = v === null || v === undefined || v === "" ? UNAVAILABLE : String(v);
      } else { warn(`Unknown variable {${name}}`); return `{${raw}}`; }
    }
    for (const f of filters) {
      const [fn, ...rest] = f.split(":");
      const impl = FILTERS[fn.trim()];
      if (!impl) { warn(`Unknown filter "${fn.trim()}"`); continue; }
      out = impl(out, rest.join(":"));
    }
    return out;
  };

  const truthy = (name: string, scope: TemplateContext, loop?: Record<string, string>) => {
    const neg = name.startsWith("!");
    const n = neg ? name.slice(1).trim() : name;
    const v = n === "depots" ? (scope.depots.length ? "y" : UNAVAILABLE) : value(n, { ...scope }, loop);
    const t = v !== UNAVAILABLE && v !== "" && v !== "0" && v !== "false";
    return neg ? !t : t;
  };

  const run = (nodes: Node[], scope: TemplateContext, loop?: Record<string, string>): string =>
    nodes.map((n) => {
      switch (n.t) {
        case "text": return n.v;
        case "expr": return value(n.raw, scope, loop);
        case "if": return run(truthy(n.cond, scope, loop) ? n.yes : n.no, scope, loop);
        case "each":
          if (n.list !== "depots") { warn(`Unknown list "${n.list}" (only "depots" is supported)`); return ""; }
          return scope.depots.map((d) => run(n.body, scope, d)).join("");
      }
    }).join("");

  return { text: run(ast, ctx), warnings };
}
