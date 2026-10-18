import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import type { Services } from "../services.js";
import { AuthService } from "./auth.js";
import { apiRouter } from "./routes.js";
import { scrubDeep } from "../util/redact.js";
import { UserError } from "../util/misc.js";

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");

export function createApp(svc: Services, auth: AuthService) {
  const { ctx } = svc;
  const log = ctx.logger.child("http");
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);

  const loopback = ["127.0.0.1", "::1", "localhost"].includes(ctx.boot.host);
  // DNS-rebinding guard: when bound to loopback only accept loopback Host headers.
  app.use((req, res, next) => {
    if (loopback) {
      const host = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
      if (!["127.0.0.1", "localhost", "::1"].includes(host)) return void res.status(400).json({ error: "Invalid Host header" });
    }
    res.set({
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data: https://cdn.cloudflare.steamstatic.com https://shared.fastly.steamstatic.com; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store",
    });
    next();
  });
  app.use(express.json({ limit: "1mb" }));

  // Defence in depth: scrub host paths from every API response, except endpoints that echo the admin's own configuration
  // (edit forms must round-trip the exact paths they typed). Error bodies are always scrubbed.
  const CONFIG_ECHO = ["/api/jobs", "/api/settings", "/api/destinations", "/api/network"];
  app.use("/api", (req, res, next) => {
    const url = req.originalUrl.split("?")[0];
    const echo = CONFIG_ECHO.some((p) => url === p || url.startsWith(p + "/"));
    const orig = res.json.bind(res);
    res.json = (body: unknown) => orig(echo && res.statusCode < 400 ? body : scrubDeep(body));
    next();
  });

  app.get("/health", (_req, res) => res.json({ status: "ok", uptimeSec: Math.round((Date.now() - svc.startedAt) / 1000) }));

  app.post("/api/login", (req, res) => {
    const { csrf } = auth.login(req, res, String(req.body?.password ?? ""));
    res.json({ ok: true, csrf });
  });
  app.get("/api/session", (req, res) => {
    const s = auth.session(req);
    res.json({ authenticated: !!s, csrf: s?.csrf, remote: !loopback });
  });
  app.post("/api/logout", (req, res) => { auth.logout(req, res); res.json({ ok: true }); });

  app.use("/api", auth.middleware, apiRouter(svc, auth));
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

  app.use(express.static(WEB_DIR, { extensions: ["html"], index: "index.html", setHeaders: (r) => r.set("Cache-Control", "no-cache") }));

  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof UserError) return void res.status(err.status).json({ error: err.message });
    if (err instanceof ZodError) return void res.status(400).json({ error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    if (err?.type === "entity.parse.failed") return void res.status(400).json({ error: "Invalid JSON body" });
    if (err?.type === "entity.too.large") return void res.status(413).json({ error: "Request body too large" });
    log.error("Unhandled request error", { path: req.path, err });
    res.status(500).json({ error: "Internal error. See the application log." });
  });
  return app;
}
