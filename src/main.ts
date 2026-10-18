import fs from "node:fs";
import { loadBootConfig } from "./config.js";
import { createServices, startServices, stopServices } from "./bootstrap.js";
import { createApp } from "./web/server.js";
import { AuthService } from "./web/auth.js";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

let boot;
try { boot = loadBootConfig(); }
catch (e) { console.error((e as Error).message); process.exit(2); }

const svc = createServices(boot);
const log = svc.ctx.logger.child("main");
const auth = new AuthService(svc.ctx);
const { generated } = auth.init();
svc.steamAuth?.refreshStatuses();

const app = createApp(svc, auth);
const server = app.listen(boot.port, boot.host, () => {
  log.info("ManifestHound listening", { url: `http://${boot.host}:${boot.port}`, dataDir: boot.dataDir });
  if (generated) {
    console.log("\n  First run: dashboard admin password generated.\n  Password : " + generated + `\n  Also saved to <data dir>/initial-admin-password.txt (deleted when you change the password).\n`);
  }
  if (!["127.0.0.1", "::1", "localhost"].includes(boot.host)) log.warn("Dashboard is reachable beyond localhost. Use HTTPS via a reverse proxy; see docs/SECURITY.md.");
  startServices(svc);
});
server.on("error", (e: NodeJS.ErrnoException) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${boot.port} is already in use. Set MH_PORT.` : `Server error: ${e.message}`);
  process.exit(1);
});

let closing = false;
async function shutdown(sig: string) {
  if (closing) return; closing = true;
  log.info("Shutting down", { sig });
  server.close();
  await stopServices(svc).catch(() => {});
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGBREAK", () => void shutdown("SIGBREAK"));
process.on("unhandledRejection", (e) => log.error("Unhandled rejection", { err: e as Error }));
process.on("uncaughtException", (e) => { log.error("Uncaught exception", { err: e }); void shutdown("uncaughtException"); });
