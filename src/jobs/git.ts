import fsp from "node:fs/promises";
import path from "node:path";
import type { EventRecord } from "../events.js";
import { globToRegExp, listFiles, scanFiles, sha256File } from "./files.js";
import { validateConfig, outputDirFor, rowToJobDef, type JobCtx, type JobResult } from "./types.js";
import { KeyedLock, UserError, resolveInsideRoots, safeJoin, isInside } from "../util/misc.js";
import { cleanOutput, pkey, resolveTool, runProc } from "../util/proc.js";
import { containsHostPath, redactString } from "../util/redact.js";

const repoLocks = new KeyedLock();

/** Filename-safe UTC timestamp of the update event: 2026-10-17T21-30-00Z. */
export function eventTimestamp(e: Pick<EventRecord, "updateTime" | "detectedAt">): string {
  return new Date(e.updateTime ?? e.detectedAt).toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
}

/**
 * Deterministic manifest token for the commit subject.
 *  - one changed manifest: its ID
 *  - several: manifest IDs ordered by ascending depot ID, joined with "+", at most 3 shown then "+N"
 *    (every ID is in the commit body and metadata file)
 *  - none (build-only change): "build-<buildId>"
 */
export function manifestToken(e: Pick<EventRecord, "changes" | "newBuild">): string {
  const ids = Object.entries(e.changes.manifestIds).sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1)).map(([, m]) => m);
  if (!ids.length) return `build-${e.newBuild ?? "unknown"}`;
  if (ids.length <= 3) return ids.join("+");
  return `${ids.slice(0, 3).join("+")}+${ids.length - 3}`;
}

export const commitSubject = (e: EventRecord) => `Manifest ${manifestToken(e)} ${eventTimestamp(e)}`;
export const TRAILER = "ManifestHound-Event";

export function commitBody(e: EventRecord): string {
  const depots = e.changes.depots.map((d) => `  ${d.depotId}: ${d.from ?? "none"} -> ${d.to}`).join("\n") || "  (none)";
  return [`Game: ${e.gameName} (App ${e.appId})`, `Build: ${e.prevBuild ?? "unknown"} -> ${e.newBuild ?? "unknown"}`, `Update time: ${e.updateTime ?? e.detectedAt}`,
    `Depot manifests:\n${depots}`, "", `${TRAILER}: ${e.id}`].join("\n");
}

const SECRET_FILE = [
  "**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.pfx", "**/*.p12", "**/id_rsa*", "**/id_ed25519*", "**/*.token", "**/secret*", "**/ssfn*",
  "**/config.vdf", "**/loginusers.vdf", "**/*.tmp", "**/*.part", "**/*.log", "**/Thumbs.db", "**/.git/**", ".git/**", "**/steam_appid.txt.bak",
].map(globToRegExp);
export const isSecretLike = (rel: string) => SECRET_FILE.some((r) => r.test(rel.replace(/\\/g, "/")));

export interface GitCredential { id: number; name: string; kind: "pat" | "password"; username: string; secret: string }

export function loadGitCredential(app: JobCtx["app"], id: number): GitCredential | null {
  const r = app.db.get("SELECT * FROM git_credentials WHERE id=?", id);
  return r ? { id: r.id, name: r.name, kind: r.kind, username: r.username, secret: app.box.decrypt(r.secret_enc) } : null;
}

/**
 * Git environment that authenticates HTTPS requests to ONE origin only (git's url-scoped http.<url>.extraHeader),
 * so the secret is never sent to other hosts, e.g. after a redirect. Secret travels via env, not argv or logs.
 * A GitHub PAT works with any username; account passwords work on servers that still accept them (Gitea, GitLab, ...).
 */
export function gitAuthEnv(remoteUrl: string, cred: Pick<GitCredential, "username" | "secret">): NodeJS.ProcessEnv {
  let origin: string;
  try { const u = new URL(remoteUrl); if (u.protocol !== "https:") throw new Error("not https"); origin = u.origin; }
  catch { throw new UserError("Username/token authentication only works with https:// remotes. Use an SSH key (ssh:// or git@host:path) or a local path without a credential."); }
  const basic = Buffer.from(`${cred.username || "x-access-token"}:${cred.secret}`).toString("base64");
  return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `http.${origin}/.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` };
}

const REMOTE_OK = /^(https:\/\/[\w.-]+(:\d+)?\/[\w./~%-]+|ssh:\/\/[\w.@-]+(:\d+)?\/[\w./~%-]+|[\w.-]+@[\w.-]+:[\w./~%-]+)$/;

async function exists(p: string) { return fsp.stat(p).then(() => true, () => false); }

export async function gitHandler(c: JobCtx): Promise<JobResult> {
  const cfg = validateConfig("git", c.def.config);
  const s = c.app.settings.get();
  const roots = c.app.settings.roots();
  if (!cfg.repoPath) throw new Error("repoPath is required");
  const repo = resolveInsideRoots(cfg.repoPath, roots, c.app.settings.workDir());
  const e = c.event;
  const authorName = cfg.authorName || s.git.authorName, authorEmail = cfg.authorEmail || s.git.authorEmail;
  const gitBin = s.git.gitPath;

  const baseEnv: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: authorName, GIT_AUTHOR_EMAIL: authorEmail, GIT_COMMITTER_NAME: authorName, GIT_COMMITTER_EMAIL: authorEmail,
  };
  let cred: GitCredential | null = null;
  if (cfg.credentialId != null) {
    cred = loadGitCredential(c.app, cfg.credentialId);
    if (!cred) throw new Error(`Git credential #${cfg.credentialId} no longer exists. Pick another under Settings > Git.`);
  }
  const authEnv: NodeJS.ProcessEnv = {};   // filled once the remote URL is known
  const git = async (args: string[], opts: { allowFail?: boolean } = {}) => {
    const r = await runProc(gitBin, args, { cwd: repo, env: { ...baseEnv, ...authEnv }, signal: c.signal, timeoutMs: 10 * 60_000 });
    if (r.missing) throw new Error(`git executable not found: "${gitBin}". Install Git for Windows or set Settings > Git > gitPath.`);
    if (r.code !== 0 && !opts.allowFail) throw new Error(`git ${args[0]} failed (${r.code}): ${cleanOutput(r.stderr || r.stdout)}`);
    return r;
  };

  return repoLocks.run(repo, async () => {
    // --- repository
    if (!(await exists(path.join(repo, ".git")))) {
      if (!cfg.init) throw new Error(`${repo} is not a git repository and init=false`);
      await fsp.mkdir(repo, { recursive: true });
      await git(["init", "-b", cfg.branch]);
      c.log(`Initialised repository at ${repo}`);
    }
    const top = (await git(["rev-parse", "--show-toplevel"])).stdout.trim();
    if (pkey(path.resolve(top)) !== pkey(path.resolve(repo))) throw new Error(`${repo} lies inside another repository (${top}); refusing to commit there`);

    if (cfg.remoteUrl) {
      // Local bare repositories (NAS share, second disk) are allowed only inside the allowed roots.
      const remote = path.isAbsolute(cfg.remoteUrl) ? resolveInsideRoots(cfg.remoteUrl, roots) : cfg.remoteUrl;
      if (!path.isAbsolute(cfg.remoteUrl) && !REMOTE_OK.test(cfg.remoteUrl)) throw new UserError("remoteUrl must be https://, ssh://, scp-style git@host:path, or an absolute local path inside the allowed roots");
      const has = (await git(["remote", "get-url", cfg.remoteName], { allowFail: true })).code === 0;
      await git(has ? ["remote", "set-url", cfg.remoteName, remote] : ["remote", "add", cfg.remoteName, remote]);
    }
    if (cred) {
      const remoteNow = (await git(["remote", "get-url", cfg.remoteName], { allowFail: true })).stdout.trim();
      if (!remoteNow) throw new Error(`A Git credential is selected but remote "${cfg.remoteName}" is not configured (set remoteUrl).`);
      Object.assign(authEnv, gitAuthEnv(remoteNow, cred));
    }
    const cur = (await git(["symbolic-ref", "--short", "-q", "HEAD"], { allowFail: true })).stdout.trim();
    if (cur !== cfg.branch) {
      const exist = (await git(["rev-parse", "--verify", "-q", `refs/heads/${cfg.branch}`], { allowFail: true })).code === 0;
      await git(exist ? ["checkout", cfg.branch] : ["checkout", "-b", cfg.branch]);
    }

    // --- commit (idempotent per event via trailer)
    const result: { commit: Record<string, unknown>; push: Record<string, unknown> } = { commit: { status: "skipped" }, push: { status: "disabled" } };
    let sha = "";
    const prior = (await git(["log", "-n1", "--format=%H", "--fixed-strings", `--grep=${TRAILER}: ${e.id}`], { allowFail: true })).stdout.trim();
    if (prior && !c.manual) {
      sha = prior;
      result.commit = { status: "reused", sha, note: "commit for this event already exists" };
      c.log(`Commit for event already exists (${sha.slice(0, 10)}); not creating another.`);
    } else {
      const dests: string[] = [];
      for (const src of cfg.sources) {
        const rootDir = src.sourceJobId != null
          ? (src.path ? safeJoin(sourceJobOutput(c, src.sourceJobId), src.path) : sourceJobOutput(c, src.sourceJobId))
          : resolveInsideRoots(src.path, roots, c.app.settings.workDir());
        const dest = src.dest.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
        const destAbs = dest ? safeJoin(repo, dest) : repo;
        if (isInside(path.join(repo, ".git"), destAbs)) throw new UserError("dest may not be inside .git");
        const files = await scanFiles(rootDir, { root: "", sourceJobId: null, include: src.include, exclude: src.exclude, files: [], extensions: [], recursive: true, maxFiles: 200_000 }, c.signal);
        const keep = new Set<string>();
        let copied = 0, skippedSecret = 0;
        for (const f of files) {
          if (isSecretLike(f.path)) { skippedSecret++; continue; }
          keep.add(pkey(f.path));
          const to = safeJoin(destAbs, f.path);
          if ((await exists(to)) && (await sha256File(to)) === f.sha256) continue;
          await fsp.mkdir(path.dirname(to), { recursive: true });
          await fsp.copyFile(safeJoin(rootDir, f.path), to);
          copied++;
        }
        let removed = 0;
        // Empty dest = spread the source's top-level folders (e.g. Assembly-CSharp/) straight into the repo root.
        // Mirroring then only prunes inside those folders, never anything else in the repository.
        const top = [...new Set(files.filter((f) => !isSecretLike(f.path)).map((f) => f.path.split("/")[0]))];
        if (!dest && src.mirror) {
          for (const d of top.filter((t) => files.some((f) => f.path.startsWith(t + "/")))) {
            const dirAbs = safeJoin(repo, d);
            if (!(await exists(dirAbs))) continue;
            for (const old of await listFiles(dirAbs, { root: "", sourceJobId: null, include: [], exclude: [], files: [], extensions: [], recursive: true, maxFiles: 500_000 }, c.signal)) {
              if (!keep.has(pkey(d + "/" + old.path))) { await fsp.rm(safeJoin(dirAbs, old.path), { force: true }); removed++; }
            }
          }
        } else if (src.mirror && (await exists(destAbs))) {
          for (const old of await listFiles(destAbs, { root: "", sourceJobId: null, include: [], exclude: [], files: [], extensions: [], recursive: true, maxFiles: 500_000 }, c.signal)) {
            if (!keep.has(pkey(old.path)) && path.basename(old.path) !== METADATA) { await fsp.rm(safeJoin(destAbs, old.path), { force: true }); removed++; }
          }
        }
        if (!dest && src.mirror) {
          // An assembly folder whose DLL vanished from the game: drop it from the repo (only folders we exported, marked by export-info.json).
          for (const d of await fsp.readdir(repo, { withFileTypes: true })) {
            if (!d.isDirectory() || d.name === ".git" || top.includes(d.name)) continue;
            if (!(await exists(path.join(repo, d.name, "export-info.json")))) continue;
            await fsp.rm(path.join(repo, d.name), { recursive: true, force: true });
            if ((await git(["ls-files", "--", d.name])).stdout.trim()) dests.push(d.name);
            c.log("Removed assembly folder no longer in the game: " + d.name);
          }
        }
        c.log(`Source ${rootDir} -> ${dest || "."}: ${copied} copied, ${removed} removed, ${skippedSecret} secret-like files skipped`);
        if (dest) dests.push(dest); else dests.push(...top);
      }
      if (!dests.length) throw new Error("No sources configured: nothing to track in the repository");

      const metaDir = (cfg.metadataDir || (cfg.sources.some((x: { dest: string }) => !x.dest) ? "." : dests[0])).replace(/\\/g, "/");
      const metaRel = (metaDir === "." ? "" : metaDir + "/") + METADATA;
      await git(["add", "-A", "--", ...dests]);
      // Leak guard: refuse to commit anything containing a directory of THIS machine (data, work, allowed roots, home, temp).
      const patch = (await git(["diff", "--cached", "-U0", "--text", "--no-color", "--", ...dests])).stdout;
      const leaky = new Set<string>();
      let cur = "";
      for (const line of patch.split("\n")) {
        if (line.startsWith("+++ b/")) cur = line.slice(6);
        else if (line.startsWith("+") && containsHostPath(line)) leaky.add(cur);
      }
      if (leaky.size) {
        await git(["reset", "-q", "--", ...dests], { allowFail: true });
        throw new Error(`Refusing to commit: ${leaky.size} file(s) contain a path from this machine: ${[...leaky].slice(0, 5).join(", ")}. Exclude them with sources[].exclude or remove the path.`);
      }
      const staged = (await git(["diff", "--cached", "--name-only", "--", ...dests])).stdout.split("\n").map((x) => x.trim()).filter(Boolean);
      const contentChanges = staged.filter((p) => p !== metaRel);
      if (!contentChanges.length && !cfg.allowMetadataOnlyCommit) {
        result.commit = { status: "skipped", note: "no file changes; empty commit avoided" };
        c.log("No file changes to commit (empty commit avoided).");
      } else {
        const meta = {
          generator: "ManifestHound", eventId: e.id, appId: e.appId, gameName: e.gameName, buildId: e.newBuild, previousBuildId: e.prevBuild,
          manifestIds: e.changes.manifestIds, depots: e.changes.depots, updateTime: e.updateTime ?? e.detectedAt, detectedAt: e.detectedAt,
          tools: { git: (await git(["--version"])).stdout.trim(), ilspycmd: await toolVersionHint(c), node: process.version },
          filesChanged: contentChanges.length,
        };
        const metaAbs = safeJoin(repo, metaRel);
        await fsp.mkdir(path.dirname(metaAbs), { recursive: true });
        await fsp.writeFile(metaAbs, JSON.stringify(meta, null, 2) + "\n");
        await git(["add", "--", metaRel]);
        // --only + pathspec: commit just our paths even if the user staged unrelated files in this repo.
        const msg = `${commitSubject(e)}\n\n${commitBody(e)}`;
        await git(["commit", "--only", "-m", msg, "--", ...dests, metaRel]);
        sha = (await git(["rev-parse", "HEAD"])).stdout.trim();
        result.commit = { status: "created", sha, subject: commitSubject(e), files: contentChanges.length };
        c.log(`Committed ${sha.slice(0, 10)}: ${commitSubject(e)}`);
      }
    }

    // --- push (reported separately; never forced)
    let pushError = "";
    if (cfg.push) {
      const hasRemote = (await git(["remote", "get-url", cfg.remoteName], { allowFail: true })).code === 0;
      if (!hasRemote) { result.push = { status: "failed", error: `remote "${cfg.remoteName}" is not configured` }; pushError = "no remote"; }
      else {
        const r = await git(["push", "--set-upstream", cfg.remoteName, cfg.branch], { allowFail: true });
        if (r.code === 0) { result.push = { status: "pushed", remote: cfg.remoteName, branch: cfg.branch }; c.log(`Pushed ${cfg.branch} to ${cfg.remoteName}`); }
        else { pushError = redactString(cleanOutput(r.stderr || r.stdout)); result.push = { status: "failed", error: pushError }; c.log(`PUSH FAILED: ${pushError}`); }
      }
    }
    const summary = `commit ${result.commit.status}${sha ? " " + sha.slice(0, 10) : ""}; push ${result.push.status}`;
    if (pushError) throw Object.assign(new Error(`Push failed (commit is safe locally and will not be duplicated on retry): ${pushError}`), { data: result });
    return { summary, data: result };
  });
}

const METADATA = "manifesthound-metadata.json";

function sourceJobOutput(c: JobCtx, jobId: number): string {
  const row = c.app.db.get("SELECT * FROM job_defs WHERE id=?", jobId);
  if (!row) throw new UserError(`Source job ${jobId} no longer exists`);
  const d = rowToJobDef(c.app, row);
  return outputDirFor(c.app, d, c.event.appId);
}

async function toolVersionHint(c: JobCtx): Promise<string | null> {
  const r = await runProc(resolveTool(c.app.settings.get().tools.ilspyCmdPath), ["--version"], { timeoutMs: 15000, env: { DOTNET_ROLL_FORWARD: "Major" } }).catch(() => null);
  return r && r.code === 0 ? r.stdout.trim().split(/\r?\n/)[0] : null;
}
