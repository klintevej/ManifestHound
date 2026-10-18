import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** AES-256-GCM envelope: "v1:" + base64(iv|tag|ciphertext). */
export class SecretBox {
  constructor(private key: Buffer) {
    if (key.length !== 32) throw new Error("Secret key must be 32 bytes");
  }
  static load(dataDir: string, envKey?: string): SecretBox {
    if (envKey) {
      if (!/^[0-9a-f]{64}$/i.test(envKey)) throw new Error("MH_SECRET_KEY must be 64 hex characters");
      return new SecretBox(Buffer.from(envKey, "hex"));
    }
    const f = path.join(dataDir, "secret.key");
    if (!fs.existsSync(f)) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(f, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
    }
    return new SecretBox(Buffer.from(fs.readFileSync(f, "utf8").trim(), "hex"));
  }
  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return "v1:" + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
  }
  decrypt(blob: string): string {
    if (!blob.startsWith("v1:")) throw new Error("Unknown secret format");
    const b = Buffer.from(blob.slice(3), "base64");
    const d = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
  }
}

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(pw, salt, 64).toString("hex")}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const h = scryptSync(pw, Buffer.from(salt, "hex"), 64);
  const expect = Buffer.from(hash, "hex");
  return h.length === expect.length && timingSafeEqual(h, expect);
}
