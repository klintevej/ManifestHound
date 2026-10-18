import { describe, expect, it } from "vitest";
import { detect, type PersistedState } from "../src/monitor/detector.js";
import type { AppSnapshot } from "../src/steam/appinfo.js";
import { parseAppInfo, SteamDataError } from "../src/steam/appinfo.js";

const snap = (build: string, depots: Record<string, string>, tu = 100): AppSnapshot => ({
  appId: 1, name: "G", branch: "public", buildId: build, timeUpdated: tu, source: "t", fetchedAt: "", depots: Object.fromEntries(Object.entries(depots).map(([k, v]) => [k, { manifest: v }])),
});
const rules = (o: Partial<{ followMode: "build" | "depots" | "all"; depotIds: string[]; baselineFirst: boolean }> = {}) => ({ followMode: "build" as const, depotIds: [], baselineFirst: true, ...o });
const state = (build: string, depots: Record<string, string>): PersistedState => ({ buildId: build, timeUpdated: 100, depots });

describe("detector", () => {
  it("first check is a silent baseline by default", () => {
    const d = detect(null, snap("10", { "1": "a" }), rules(), 1);
    expect(d.type).toBe("baseline");
    expect(d.next.buildId).toBe("10");
    expect(d.next.depots).toEqual({ "1": "a" });
  });

  it("first check becomes an 'initial' event when baseline is disabled", () => {
    const d = detect(null, snap("10", { "1": "a" }), rules({ baselineFirst: false }), 1);
    expect(d.type).toBe("initial");
  });

  it("restart with identical state reports nothing", () => {
    expect(detect(state("10", { "1": "a" }), snap("10", { "1": "a" }), rules(), 1).type).toBe("unchanged");
  });

  it("detects a build ID change", () => {
    const d = detect(state("10", { "1": "a" }), snap("11", { "1": "a" }), rules(), 1);
    expect(d.type).toBe("update");
    if (d.type === "update") { expect(d.changes.buildChange).toEqual({ from: "10", to: "11" }); expect(d.changes.trigger).toEqual(["build"]); expect(d.changes.depots).toHaveLength(0); }
  });

  it("groups several depot changes into ONE event and keeps per-depot details", () => {
    const d = detect(state("10", { "1": "a", "2": "b", "3": "c" }), snap("11", { "1": "a2", "2": "b2", "3": "c" }), rules({ followMode: "all" }), 1);
    expect(d.type).toBe("update");
    if (d.type === "update") {
      expect(d.changes.depots.map((x) => [x.depotId, x.from, x.to])).toEqual([["1", "a", "a2"], ["2", "b", "b2"]]);
      expect(d.changes.manifestIds).toEqual({ "1": "a2", "2": "b2" });
      expect(d.changes.trigger).toEqual(["build", "depot"]);
    }
  });

  it("depot mode ignores changes in unfollowed depots but still advances stored state", () => {
    const prev = state("10", { "1": "a", "2": "b" });
    const d = detect(prev, snap("11", { "1": "a", "2": "b2" }), rules({ followMode: "depots", depotIds: ["1"] }), 1);
    expect(d.type).toBe("unchanged");
    expect(d.next.buildId).toBe("11");
    expect(d.next.depots["2"]).toBe("b2");
  });

  it("depot mode fires when a followed depot changes", () => {
    const d = detect(state("10", { "1": "a", "2": "b" }), snap("10", { "1": "a9", "2": "b" }), rules({ followMode: "depots", depotIds: ["1"] }), 1);
    expect(d.type).toBe("update");
    if (d.type === "update") expect(d.changes.depots.map((x) => x.depotId)).toEqual(["1"]);
  });

  it("flags a move to an earlier build as a rollback", () => {
    const d = detect(state("200", { "1": "new" }), snap("150", { "1": "old" }), rules({ followMode: "all" }), 1);
    expect(d.type).toBe("rollback");
  });

  it("a newly appearing depot is 'added'; a depot missing from the response is not treated as a change", () => {
    const d = detect(state("10", { "1": "a" }), snap("10", { "2": "z" }), rules({ followMode: "all" }), 1);
    expect(d.type).toBe("update");
    if (d.type === "update") expect(d.changes.depots[0]).toMatchObject({ depotId: "2", change: "added", from: null });
    // depot 1 is retained, so when it comes back unchanged nothing fires
    if (d.type === "update") expect(detect(d.next, snap("10", { "1": "a", "2": "z" }), rules({ followMode: "all" }), 1).type).toBe("unchanged");
  });

  it("dedupe key is stable for the same transition and differs across transitions", () => {
    const a = detect(state("10", { "1": "a" }), snap("11", { "1": "b" }), rules({ followMode: "all" }), 1);
    const b = detect(state("10", { "1": "a" }), snap("11", { "1": "b" }), rules({ followMode: "all" }), 1);
    const c = detect(state("11", { "1": "b" }), snap("12", { "1": "c" }), rules({ followMode: "all" }), 1);
    if (a.type !== "update" || b.type !== "update" || c.type !== "update") throw new Error("expected updates");
    expect(a.dedupeKey).toBe(b.dedupeKey);
    expect(a.dedupeKey).not.toBe(c.dedupeKey);
  });
});

describe("parseAppInfo", () => {
  const info = { common: { name: "X" }, depots: { branches: { public: { buildid: "5", timeupdated: "1700000000" }, beta: { buildid: "6", pwdrequired: "1" } },
    "10": { manifests: { public: { gid: "111", size: "5" } } }, "11": { manifests: { public: "222" } }, "12": { config: { oslist: "linux" } }, baselanguages: "english" } };
  it("extracts build, update time and per-depot manifests", () => {
    const s = parseAppInfo(1, info, "public", "t");
    expect(s.buildId).toBe("5"); expect(s.timeUpdated).toBe(1700000000);
    expect(s.depots).toEqual({ "10": { manifest: "111", size: "5" }, "11": { manifest: "222" } });
  });
  it("reports unknown branches explicitly instead of guessing", () => {
    expect(() => parseAppInfo(1, info, "nope", "t")).toThrow(SteamDataError);
  });
  it("skips depots that expose no manifest on the branch (no invented IDs)", () => {
    expect(parseAppInfo(1, info, "beta", "t").depots).toEqual({});
  });
});
