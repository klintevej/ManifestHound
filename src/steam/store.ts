import { parseAppInfo, SteamDataError, type AppSnapshot } from "./appinfo.js";

const UA = "ManifestHound/1.0 (+local update watcher)";

async function getJson(url: string, timeoutMs: number): Promise<any> {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 429 || res.status >= 500) throw new SteamDataError(`HTTP ${res.status} from ${new URL(url).host}`, true);
  if (!res.ok) throw new SteamDataError(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

export interface GameSearchResult { appId: number; name: string; iconUrl: string }

export const iconUrlFor = (appId: number) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;

/** PUBLIC metadata only (Steam Store). Does not reveal builds or manifests. */
export async function searchGames(term: string, timeoutMs = 15000): Promise<GameSearchResult[]> {
  const j = await getJson(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=US`, timeoutMs);
  return (j.items ?? []).filter((i: any) => i.type === "app" || i.type == null).slice(0, 25)
    .map((i: any) => ({ appId: Number(i.id), name: String(i.name), iconUrl: iconUrlFor(Number(i.id)) }));
}

export async function storeAppName(appId: number, timeoutMs = 15000): Promise<string | null> {
  const j = await getJson(`https://store.steampowered.com/api/appdetails?appids=${appId}&filters=basic`, timeoutMs);
  const e = j?.[String(appId)];
  return e?.success ? String(e.data?.name ?? "") || null : null;
}

/**
 * Third-party public mirror of PICS data (unofficial; off by default). Same shape as appinfo,
 * so it goes through the same parser. Useful as a fallback when Steam login is unavailable.
 */
export async function fetchPublicMirror(urlTemplate: string, appId: number, branch: string, timeoutMs: number): Promise<AppSnapshot> {
  const j = await getJson(urlTemplate.replace("{appid}", String(appId)), timeoutMs);
  const info = j?.data?.[String(appId)];
  if (!info) throw new SteamDataError(`Public mirror has no data for app ${appId}`, true);
  return parseAppInfo(appId, info, branch, "public-mirror");
}
