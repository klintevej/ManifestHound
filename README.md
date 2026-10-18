# ManifestHound

*Track every build. Catch every change.*

Self-hosted Steam update watcher for Windows 10/11 and Debian/Ubuntu Linux (x64 and arm64). It polls Steam's app-info service (PICS) for build IDs and depot manifests, records every real change, sends customizable Discord notifications, and runs post-update jobs (file collection, change reports, ZIP + upload, ILSpy decompilation, Git commit/push). Dashboard: `http://127.0.0.1:4019`.

## Quick start

Requires Node.js 24+ (uses built-in `node:sqlite`), Git for Windows. Optional: `dotnet tool install -g ilspycmd` (decompile jobs).

```
npm install
npm run build
npm start                # production
npm run dev              # development (tsx watch)
npm test                 # automated tests
```

On first run an admin password is generated, printed once in the console and saved to `data/initial-admin-password.txt` (deleted when you change it in Settings > Security). Or set `MH_ADMIN_PASSWORD`.

Run continuously:
- **Windows**: `npm run build && npm run install-startup` (Task Scheduler, starts at logon, restarts on failure), or wrap `node dist/main.js` with NSSM.
- **Debian / Raspberry Pi OS / Ubuntu (x64 or arm64)**: `npm run build && sudo ./scripts/install-service.sh [user]` installs a systemd unit (`journalctl -u manifesthound -f`).

### Debian / arm64 install

```
sudo apt update && sudo apt install -y git unzip curl ca-certificates
# Node.js 24+ (official arm64 and x64 builds): e.g. via NodeSource or nvm
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt install -y nodejs
# optional, for decompile jobs (dotnet supports linux-arm64): see https://learn.microsoft.com/dotnet/core/install/linux-debian
dotnet tool install -g ilspycmd     # lands in ~/.dotnet/tools; ManifestHound finds it there automatically
npm install && npm run build && npm start
```

All dependencies are pure JavaScript (no native compilation), so the same code runs on x64 and arm64. The Linux setup is code-reviewed and path-handling is platform-neutral, but it was developed and tested on Windows; run `npm test` on your Debian box to confirm (the live ilspycmd test skips itself if .NET is absent). On Linux, example paths in the Jobs presets (`C:/Games/...`) must be replaced with your own, e.g. `/path/to/steamapps/common/Game`, and added to Settings > Storage > Allowed roots.

## Configuration

Copy `.env.example` to `.env`. Bootstrap settings (`MH_HOST`, `MH_PORT`, `MH_DATA_DIR`, `MH_ADMIN_PASSWORD`, `MH_SECRET_KEY`, `MH_LOG_LEVEL`, `MH_ALLOW_REMOTE`) can also live in `manifesthound.config.json` (see `manifesthound.config.example.json`). Everything else is edited in the dashboard and stored in SQLite (`data/manifesthound.db`).

Layout: `src/steam` (PICS, store metadata, login), `src/monitor` (detector, scheduler), `src/notify` (templates, Discord), `src/jobs` (queue + job types, uploads), `src/web` (API, auth), `web/` (dashboard), `tests/`, `docs/`.

## Setup guides

**Discord webhook**: Server Settings > Integrations > Webhooks > New Webhook > Copy URL. In ManifestHound: Notifications > Add webhook > Send test. The first webhook becomes the default. Template syntax: `docs/TEMPLATES.md` (also in the Notifications page).

**Add a game**: Games > Add game (search by name or enter an App ID). Choose to follow the overall build, specific depots, or all depots. The first successful check is a silent baseline unless you disable that option.

**Steam account** (only for apps/branches that need it): Settings > Steam accounts. Uses Valve's `steam-session` flow with Steam Guard (email code, mobile code, or mobile approval). The password goes to Steam only; the refresh token is stored encrypted. Tokens expire (~200 days); the UI shows `expired` and you sign in again. Steam may rate-limit or require extra verification on repeated attempts.

**Storage and safety**: Settings > Storage. Jobs may only touch the work directory and the *allowed roots* you list (game install folders, repositories). Everything else is rejected.

**Jobs** (Jobs page): types `collect`, `report`, `archive`, `decompile`, `git`. Each has a JSON config with a preset. Lower `order` runs first; equal order runs in parallel. Typical chain for a Unity game: `collect` (Managed DLLs) -> `decompile` (`assemblies`, `onExisting: overwrite`) -> `git` with source `{ "sourceJobId": <decompile id>, "path": "src", "dest": "GameName" }`. Details: `docs/JOBS.md`.

**Tools**: DepotDownloader and ilspycmd are downloaded automatically the first time a job needs them (into `<data dir>/tools`), or on demand with the Install button on the Diagnostics page. DepotDownloader comes from its GitHub release (checksum verified). ilspycmd is installed with `dotnet tool install`; if no .NET SDK is present, ManifestHound installs SDK 8 into `<data dir>/tools/dotnet` first using Microsoft's dotnet-install script (Linux needs `curl` or `wget`). Git cannot be installed for you. A custom path in Settings is never replaced.

**Decompiler**: `dotnet tool install -g ilspycmd`; set the path in Settings > Jobs and tools if it is not on PATH. ILSpy 8.x has no switches for token comments or solution files, so ManifestHound removes `.sln` files and token comments after export and records that in `export-info.json`.

**Git remotes**: set `remoteUrl` + `push: true` in the git job. Authentication uses your Git Credential Manager / SSH keys, or an HTTPS token stored encrypted in the job. Pushes are never forced; a rejected push fails the job but keeps the local commit, and retries do not duplicate commits.

**Upload destinations**: Settings > Upload destinations: `local`, `http` (PUT/POST), `s3` (any S3-compatible), `sftp` (host key pinned on first use). Use *Test* to verify. Private/LAN targets need the explicit per-destination toggle.

## Features

Implemented and covered by tests unless noted: PICS-based detection (build, depots, groups, rollback, baseline, restart-safe); atomic state+event+queue transaction; Discord notifications with template engine, retries, rate-limit handling, history; persistent job queue with ordering, parallel groups, timeouts, retries, stop-on-fail, restart recovery, per-event dedupe, manual runs; collect/report/archive/upload/decompile/git jobs; dashboard (overview, games, history, jobs, notifications, repositories, settings, diagnostics); auth with CSRF, Host checks, SSRF guard, path confinement, encrypted secrets, redacted logs and diagnostic bundle.

## Known limitations

- **Live-verified**: anonymous PICS against real Steam (App 480), real `ilspycmd`, real Git push to a local bare remote. **Not live-verified** (no credentials available): Steam account login/Guard flow, Discord delivery, SFTP and S3 uploads (code paths exist; tests use doubles or the local provider).
- Public Steam endpoints do not expose manifests; PICS needs a Steam connection. Apps you do not own may expose less (or nothing) anonymously; use an account that owns them. Password-protected branches are not accessible without authorization.
- ManifestHound does **not download depots**. File jobs read a game folder that Steam (or a tool such as DepotDownloader, for content you are entitled to) has already updated. Use `waitForBuild` (path to `appmanifest_<id>.acf`) to wait until the local install reaches the new build.
- Depots missing from a successful response keep their last known manifest (never treated as removal).
- Notification delivery is at-least-once: a crash between Discord accepting a message and the database update can resend it.
- Dashboard is plain HTTP; remote access needs a TLS reverse proxy (`docs/SECURITY.md`).
- `steam-user` pulls transitive dependencies with open `npm audit` advisories (protobufjs, adm-zip); they process data from Steam's servers, not user input. Update when upstream does.
- The frontend was syntax-checked and its assets/API served, but not exercised in a browser during development; expect minor UI rough edges.

## Troubleshooting

- *Port in use*: set `MH_PORT`. *Forgot password*: delete the `_admin_hash` row from `settings` in the DB, restart (a new one is generated), or set `MH_ADMIN_PASSWORD`.
- *`Branch "x" not found`*: the branch is private or misnamed. *`no depot information`*: app needs an authorised account.
- *ilspycmd fails to start*: needs a .NET runtime; ManifestHound sets `DOTNET_ROLL_FORWARD=Major`. Check Diagnostics.
- *Webhook rejected*: only `discord.com` webhook URLs are accepted unless enabled in Notifications settings.
- Logs: `data/logs/` (JSON lines, rotated daily); Diagnostics > Download bundle (redacted).

## License

MIT, see LICENSE.
