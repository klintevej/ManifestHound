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

## Recipe: decompile and push with one folder per assembly at the repo root

1. `decompile` job (order 1): `assemblies` lists the DLLs (for example `Assembly-CSharp.dll`, `PhotonUnityNetworking.dll`), `onExisting: "overwrite"` so folder names stay stable.
2. `git` job (order 2): `sources: [{ "sourceJobId": <decompile job id>, "path": "src", "dest": "", "mirror": true }]`, plus `repoPath`, `branch`, `remoteUrl`, `push: true` and optionally `credentialId`.

Result: `Assembly-CSharp/`, `PhotonUnityNetworking/` and so on sit directly in the repository, with `manifesthound-metadata.json` at the root. With an empty `dest`, mirroring only prunes files inside those assembly folders. Everything else in the repository is left alone.

## Archive preset (download, decompile, commit and push)

Jobs page > **Archive** creates three chained jobs for one game:

1. `depotdownload`: runs DepotDownloader for the exact manifests of each detected update, into the job's output directory. `files` limits what is fetched (default `**/*_Data/Managed/*.dll`). `os` picks the Windows, Linux or macOS depots. `username` is for games your account owns.
2. `decompile`: reads the download folder. `assemblies` are globs relative to it: `Assembly-CSharp.dll`, `*_Data/Managed/*.dll`, `**/Photon*.dll`. `selection.exclude` skips framework DLLs.
3. `git`: mirrors each assembly folder to the repository root, commits `Manifest <id> <time>` and pushes.

Setup: DepotDownloader is downloaded automatically on first use. For an owned game, add the Steam account in Settings and tick the save password option, then pick that account in the job (`accountId`). The password is stored encrypted and sent to DepotDownloader on stdin, never on the command line. The first login needs approval in the Steam mobile app; DepotDownloader remembers the session after that.

How updates are noticed: the monitor polls Steam every interval (60s by default). A changed build or depot manifest creates an update event, which queues these jobs in order. A game with only a build change and no manifest change downloads all depots of the app.
