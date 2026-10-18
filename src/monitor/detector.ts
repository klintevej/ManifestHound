import { createHash } from "node:crypto";
import type { AppSnapshot } from "../steam/appinfo.js";

export type FollowMode = "build" | "depots" | "all";

export interface WatchRules { followMode: FollowMode; depotIds: string[]; baselineFirst: boolean }
export interface PersistedState { buildId: string | null; timeUpdated: number | null; depots: Record<string, string> }

export interface DepotChange { depotId: string; change: "added" | "changed"; from: string | null; to: string; tracked: boolean }
export interface Changes {
  buildChange: { from: string | null; to: string | null } | null;
  depots: DepotChange[];
  rollback: boolean;
  trigger: ("build" | "depot")[];
  /** Latest manifest per changed depot, convenient for templates. */
  manifestIds: Record<string, string>;
}

export type Detection =
  | { type: "baseline"; next: PersistedState }                       // first check, silent
  | { type: "initial"; next: PersistedState; changes: Changes }      // first check, user opted to treat as an update
  | { type: "unchanged"; next: PersistedState }
  | { type: "update" | "rollback"; next: PersistedState; changes: Changes; dedupeKey: string };

const big = (s: string | null) => { try { return s == null ? null : BigInt(s); } catch { return null; } };

export function snapshotToState(prev: PersistedState | null, snap: AppSnapshot): PersistedState {
  // Depots absent from a successful response keep their last known manifest: a partial answer must not look like a change later.
  const depots: Record<string, string> = { ...(prev?.depots ?? {}) };
  for (const [id, d] of Object.entries(snap.depots)) depots[id] = d.manifest;
  return { buildId: snap.buildId ?? prev?.buildId ?? null, timeUpdated: snap.timeUpdated ?? prev?.timeUpdated ?? null, depots };
}

export function trackedDepots(rules: WatchRules, snapDepots: string[]): Set<string> {
  if (rules.followMode === "all") return new Set(snapDepots);
  if (rules.followMode === "depots") return new Set(rules.depotIds);
  return new Set();
}

export function detect(prev: PersistedState | null, snap: AppSnapshot, rules: WatchRules, watchId: number): Detection {
  const next = snapshotToState(prev, snap);

  const changeSet = (): Changes => {
    const tracked = trackedDepots(rules, Object.keys(snap.depots));
    const depots: DepotChange[] = [];
    for (const [id, d] of Object.entries(snap.depots).sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1))) {
      const old = prev?.depots[id] ?? null;
      if (old === d.manifest) continue;
      depots.push({ depotId: id, change: old === null ? "added" : "changed", from: old, to: d.manifest, tracked: tracked.has(id) });
    }
    const buildChange = prev?.buildId !== next.buildId ? { from: prev?.buildId ?? null, to: next.buildId } : null;
    const trigger: Changes["trigger"] = [];
    if (buildChange && (rules.followMode === "build" || rules.followMode === "all")) trigger.push("build");
    if (depots.some((d) => d.tracked)) trigger.push("depot");
    const pb = big(prev?.buildId ?? null), nb = big(next.buildId);
    const rollback = pb !== null && nb !== null && nb < pb;
    // In "depots" mode only tracked depots are reported; in "build" mode all changed depots are kept as detail.
    const shown = rules.followMode === "depots" ? depots.filter((d) => d.tracked) : depots;
    return {
      buildChange: rules.followMode === "depots" && !trigger.length ? null : buildChange,
      depots: shown, rollback, trigger,
      manifestIds: Object.fromEntries(shown.map((d) => [d.depotId, d.to])),
    };
  };

  if (!prev) {
    if (rules.baselineFirst) return { type: "baseline", next };
    return { type: "initial", next, changes: changeSet() };
  }
  const changes = changeSet();
  if (!changes.trigger.length) return { type: "unchanged", next };

  const keyMaterial = [watchId, prev.buildId, next.buildId, snap.timeUpdated ?? "", ...changes.depots.map((d) => `${d.depotId}:${d.from}>${d.to}`)].join("|");
  return {
    type: changes.rollback ? "rollback" : "update",
    next, changes,
    dedupeKey: createHash("sha1").update(keyMaterial).digest("hex"),
  };
}
