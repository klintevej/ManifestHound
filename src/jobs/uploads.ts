import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { assertSafeUrl } from "../util/ssrf.js";
import { UserError, parseJson, resolveInsideRoots, safeJoin } from "../util/misc.js";
import { sha256File } from "./files.js";

const require = createRequire(import.meta.url);

export interface UploadResult { location: string; bytes: number; verified: boolean; detail?: string }
export interface UploadOpts { signal: AbortSignal; log: (m: string) => void }
export interface UploadProvider { upload(file: string, remoteName: string, o: UploadOpts): Promise<UploadResult> }

export const DestinationSchemas = {
  local: z.object({ dir: z.string().min(1) }),
  http: z.object({
    url: z.string().min(1),                 // may contain {filename}
    method: z.enum(["PUT", "POST"]).default("PUT"),
    authHeader: z.string().regex(/^[\w-]+$/).default("Authorization"),
    timeoutSec: z.number().int().min(5).max(7200).default(600),
  }),
  s3: z.object({
    endpoint: z.string().default(""), region: z.string().default("us-east-1"), bucket: z.string().min(1),
    prefix: z.string().default(""), forcePathStyle: z.boolean().default(true),
  }),
  sftp: z.object({
    host: z.string().min(1), port: z.number().int().min(1).max(65535).default(22), username: z.string().min(1),
    remoteDir: z.string().min(1), hostFingerprint: z.string().default(""),   // SHA256 hex, trust-on-first-use if empty
  }),
} as const;
export type DestType = keyof typeof DestinationSchemas;
export const DEST_TYPES = Object.keys(DestinationSchemas) as DestType[];

/** Secret fields per provider (stored encrypted, never returned by the API). */
export const SECRET_FIELDS: Record<DestType, string[]> = {
  local: [], http: ["authValue"], s3: ["accessKeyId", "secretAccessKey"], sftp: ["password", "privateKey", "passphrase"],
};

export interface DestRow { id: number; name: string; type: DestType; config_json: string; secrets_enc: string | null; allow_private: number }

export function validateDestinationConfig(type: string, config: unknown) {
  if (!(type in DestinationSchemas)) throw new UserError(`Unknown destination type "${type}"`);
  const p = DestinationSchemas[type as DestType].safeParse(config ?? {});
  if (!p.success) throw new UserError("Invalid destination config: " + p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return p.data;
}

const remoteSafe = (name: string) => path.basename(name).replace(/[^\w.@-]/g, "_");

export function createProvider(ctx: AppContext, row: DestRow): UploadProvider {
  const cfg: any = validateDestinationConfig(row.type, parseJson(row.config_json, {}));
  const secrets: Record<string, string> = row.secrets_enc ? JSON.parse(ctx.box.decrypt(row.secrets_enc)) : {};
  const allowPrivate = !!row.allow_private;

  switch (row.type) {
    case "local": return {
      async upload(file, name, o) {
        const dir = resolveInsideRoots(cfg.dir, ctx.settings.roots(), ctx.settings.workDir());
        await fsp.mkdir(dir, { recursive: true });
        const to = safeJoin(dir, remoteSafe(name));
        await fsp.copyFile(file, to);
        const ok = (await sha256File(to)) === (await sha256File(file));
        if (!ok) throw new Error("Verification failed: copied file hash differs");
        return { location: `local:${path.basename(to)}`, bytes: (await fsp.stat(to)).size, verified: true };
      },
    };

    case "http": return {
      async upload(file, name, o) {
        const target = cfg.url.replace("{filename}", encodeURIComponent(remoteSafe(name)));
        await assertSafeUrl(target, { protocols: allowPrivate ? ["https:", "http:"] : ["https:"], allowPrivate });
        const st = await fsp.stat(file);
        const sha = await sha256File(file);
        const headers: Record<string, string> = {
          "content-type": "application/zip", "content-length": String(st.size), "x-content-sha256": sha, "user-agent": "ManifestHound/1.0",
        };
        if (secrets.authValue) headers[cfg.authHeader.toLowerCase()] = secrets.authValue;
        const res = await fetch(target, {
          method: cfg.method, headers, body: Readable.toWeb(fs.createReadStream(file)) as any, duplex: "half",
          redirect: "error", signal: AbortSignal.any([o.signal, AbortSignal.timeout(cfg.timeoutSec * 1000)]),
        } as RequestInit);
        const text = (await res.text().catch(() => "")).slice(0, 300);
        if (!res.ok) throw new Error(`Upload endpoint returned HTTP ${res.status}: ${text}`);
        // If the endpoint echoes a hash, verify it; otherwise a 2xx is the best proof an arbitrary API can give.
        let echoed: string | undefined;
        try { const j = JSON.parse(text); echoed = j.sha256 ?? j.checksum; } catch { /* non-JSON */ }
        if (echoed && echoed.toLowerCase() !== sha) throw new Error("Verification failed: endpoint reported a different SHA-256");
        return { location: new URL(target).origin + new URL(target).pathname, bytes: st.size, verified: !!echoed, detail: echoed ? "hash echoed by server" : "HTTP 2xx (server did not echo a hash)" };
      },
    };

    case "s3": return {
      async upload(file, name, o) {
        const { S3Client, PutObjectCommand, HeadObjectCommand } = await import("@aws-sdk/client-s3");
        if (cfg.endpoint) await assertSafeUrl(cfg.endpoint, { protocols: allowPrivate ? ["https:", "http:"] : ["https:"], allowPrivate });
        if (!secrets.accessKeyId || !secrets.secretAccessKey) throw new Error("S3 credentials are not configured");
        const client = new S3Client({
          region: cfg.region, endpoint: cfg.endpoint || undefined, forcePathStyle: cfg.forcePathStyle,
          credentials: { accessKeyId: secrets.accessKeyId, secretAccessKey: secrets.secretAccessKey },
        });
        const Key = (cfg.prefix ? cfg.prefix.replace(/\/?$/, "/") : "") + remoteSafe(name);
        const st = await fsp.stat(file);
        const sha = Buffer.from(await sha256File(file), "hex").toString("base64");
        try {
          await client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key, Body: fs.createReadStream(file), ContentLength: st.size, ChecksumSHA256: sha }), { abortSignal: o.signal });
          const head = await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key }));
          if (Number(head.ContentLength) !== st.size) throw new Error(`Verification failed: remote size ${head.ContentLength} != ${st.size}`);
        } finally { client.destroy(); }
        return { location: `s3://${cfg.bucket}/${Key}`, bytes: st.size, verified: true, detail: "SHA-256 checksum sent; remote size verified" };
      },
    };

    case "sftp": return {
      async upload(file, name, o) {
        if (!allowPrivate) await assertSafeUrl(`https://${cfg.host}`, { allowPrivate: false });
        const SftpClient = require("ssh2-sftp-client");
        const sftp = new SftpClient();
        let seen = "";
        const opts: any = {
          host: cfg.host, port: cfg.port, username: cfg.username, readyTimeout: 20000,
          hostHash: "sha256",
          hostVerifier: (fp: string) => {
            seen = fp.toLowerCase();
            return cfg.hostFingerprint ? seen === cfg.hostFingerprint.toLowerCase() : true; // TOFU: recorded below
          },
        };
        if (secrets.privateKey) { opts.privateKey = secrets.privateKey; if (secrets.passphrase) opts.passphrase = secrets.passphrase; }
        else if (secrets.password) opts.password = secrets.password;
        else throw new Error("SFTP needs a password or private key");
        try {
          await sftp.connect(opts);
          if (!cfg.hostFingerprint && seen) {
            o.log(`SFTP: trusting host key ${seen} on first use and pinning it.`);
            ctxSaveFingerprint(ctx, row.id, cfg, seen);
          }
          const remote = path.posix.join(cfg.remoteDir, remoteSafe(name));
          await sftp.mkdir(cfg.remoteDir, true).catch(() => {});
          await sftp.fastPut(file, remote);
          const st = await fsp.stat(file);
          const rs = await sftp.stat(remote);
          if (Number(rs.size) !== st.size) throw new Error(`Verification failed: remote size ${rs.size} != ${st.size}`);
          return { location: `sftp://${cfg.host}${remote}`, bytes: st.size, verified: true, detail: "remote size verified" };
        } finally { await sftp.end().catch(() => {}); }
      },
    };
  }
  throw new UserError(`Unsupported destination type ${row.type}`);
}

function ctxSaveFingerprint(ctx: AppContext, id: number, cfg: any, fp: string) {
  ctx.db.run("UPDATE destinations SET config_json=? WHERE id=?", JSON.stringify({ ...cfg, hostFingerprint: fp }), id);
}
