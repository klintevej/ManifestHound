export interface DepotInfo { manifest: string; size?: string }

/** Normalised view of what a Steam metadata source says about one app branch. */
export interface AppSnapshot {
  appId: number;
  name: string | null;
  branch: string;
  buildId: string | null;
  /** Unix seconds of the branch's last update as reported by Steam, if present. */
  timeUpdated: number | null;
  depots: Record<string, DepotInfo>;
  source: string;
  fetchedAt: string;
}

export class SteamDataError extends Error {
  constructor(message: string, public retryable = false) { super(message); this.name = "SteamDataError"; }
}

const manifestGid = (v: any): { gid: string; size?: string } | null => {
  if (v == null) return null;
  if (typeof v === "string" || typeof v === "number") return /^\d+$/.test(String(v)) ? { gid: String(v) } : null;
  if (typeof v === "object" && v.gid != null && /^\d+$/.test(String(v.gid))) return { gid: String(v.gid), size: v.size != null ? String(v.size) : undefined };
  return null;
};

/**
 * Parse the `appinfo` KeyValues tree (as returned by PICS or by public mirrors of it) into a snapshot.
 * Only depots that expose a manifest for the requested branch are listed; depots with encrypted or missing
 * manifests (e.g. no access on that branch) are skipped rather than invented.
 */
export function parseAppInfo(appId: number, appinfo: any, branch: string, source: string): AppSnapshot {
  if (!appinfo || typeof appinfo !== "object") throw new SteamDataError(`No app info returned for app ${appId}`, true);
  const depotsNode = appinfo.depots;
  if (!depotsNode || typeof depotsNode !== "object") {
    throw new SteamDataError(`App ${appId} exposes no depot information (not accessible anonymously, or the app has no depots)`);
  }
  const br = depotsNode.branches?.[branch];
  if (!br) {
    const known = Object.keys(depotsNode.branches ?? {}).join(", ") || "none visible";
    throw new SteamDataError(`Branch "${branch}" not found for app ${appId} (visible branches: ${known}). Password-protected branches need an authorised account.`);
  }
  const depots: Record<string, DepotInfo> = {};
  for (const [id, node] of Object.entries<any>(depotsNode)) {
    if (!/^\d+$/.test(id) || !node || typeof node !== "object") continue;
    const m = manifestGid(node.manifests?.[branch]);
    if (m) depots[id] = { manifest: m.gid, ...(m.size ? { size: m.size } : {}) };
  }
  const tu = Number(br.timeupdated);
  return {
    appId,
    name: appinfo.common?.name ?? null,
    branch,
    buildId: br.buildid != null ? String(br.buildid) : null,
    timeUpdated: Number.isFinite(tu) && tu > 0 ? tu : null,
    depots,
    source,
    fetchedAt: new Date().toISOString(),
  };
}
