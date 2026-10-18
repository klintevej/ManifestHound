# Jobs

Common fields: name, game (or all), order, depot filter (run only if one of these depots changed), timeout, retries, stop-on-fail, output directory (default `<work>/<appid>/<job>-<id>`).
Shared `selection`: `root` (inside allowed roots) or `sourceJobId` (another job's output), `include` globs, `exclude` globs, `files`, `extensions`, `recursive`.
Optional `waitForBuild: { acfPath, timeoutSec }` waits for the local Steam install to reach the event's build.

- **collect**: copies selected files to `<out>/files`, writes `reports/<event>.{json,md,html}` with added/modified/removed/unchanged + SHA-256.
- **report**: same reports, no copy.
- **archive**: `{ selection, include: {files, metadata}, destinationIds, compressionLevel }` -> `<out>/<game>-<app>-b<build>-<time>.zip` (+`metadata.json`), uploaded and verified per destination.
- **decompile**: `{ selection, assemblies: ["Assembly-CSharp.dll", "Mods/*.dll"], languageVersion, onExisting: versioned|overwrite|skip|fail, nestedDirectories, removeDeadCode, copyInputs, strict }`. Output `<out>/src/<Assembly>/` (csproj + C#, no .sln, no token comments, `export-info.json`), originals in `<out>/input/`, native DLLs reported as `native`. Identical input hash is always skipped.
- **git**: `{ repoPath, init, branch, remoteName, remoteUrl, push, authorName, authorEmail, allowMetadataOnlyCommit, sources: [{ sourceJobId|path, path, dest, mirror, include, exclude }] }`. Subject: `Manifest <ids> <YYYY-MM-DDTHH-mm-ssZ>` (UTC, time = Steam update time, else detection time). Several manifests: ascending depot ID joined by `+`, max 3 then `+N`; none: `build-<id>`. The body lists all depots and a `ManifestHound-Event:` trailer used for idempotency. Secret-like files (`.env`, keys, tokens, `ssfn*`, logs) are never copied. No commit when only the metadata file would change (unless allowed).

Queue semantics: runs are rows in SQLite. Runs of one event execute by ascending order (equal order in parallel). Interrupted runs are re-queued on start (jobs are idempotent). Automatic runs are unique per (event, job); "Run again"/"Run now" create manual runs.
