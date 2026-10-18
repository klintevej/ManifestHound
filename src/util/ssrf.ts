import dns from "node:dns/promises";
import net from "node:net";
import { UserError } from "./misc.js";

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  if (l.startsWith("::ffff:")) return isPrivateIp(l.slice(7));
  return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe8") || l.startsWith("fe9") ||
    l.startsWith("fea") || l.startsWith("feb");
}

export interface UrlPolicy { allowedHosts?: string[]; allowPrivate?: boolean; protocols?: string[] }

/** Validates scheme/host and that every resolved address is public (unless allowPrivate). Throws UserError. */
export async function assertSafeUrl(raw: string, policy: UrlPolicy = {}): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new UserError("Invalid URL"); }
  const protocols = policy.protocols ?? ["https:"];
  if (!protocols.includes(u.protocol)) throw new UserError(`URL scheme must be ${protocols.join(" or ")}`);
  if (u.username || u.password) throw new UserError("Credentials in URLs are not allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (policy.allowedHosts && !policy.allowedHosts.some((h) => host === h || host.endsWith("." + h)))
    throw new UserError(`Host not allowed: ${host}`);
  if (!policy.allowPrivate) {
    const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => {
      throw new UserError(`Cannot resolve host: ${host}`);
    });
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address)))
      throw new UserError(`Host resolves to a private/loopback address (enable "allow private network" on the destination if intended): ${host}`);
  }
  return u;
}
