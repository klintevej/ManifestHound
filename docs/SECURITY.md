# Security notes

- Binds to `127.0.0.1` by default. Non-loopback binds require `MH_ALLOW_REMOTE=true` (or Settings > Network) and a restart. The dashboard is always password-protected (scrypt hash, session cookie HttpOnly + SameSite=Strict, CSRF token, same-origin check, login lockout, DNS-rebinding Host check on loopback).
- Remote access is plain HTTP. Put it behind a TLS reverse proxy (and set the session cookie `secure` via the proxy) or use a VPN/SSH tunnel. Anyone with the password can run configured jobs and read job outputs on this PC.
- Secrets (Steam refresh tokens, webhook URLs, upload credentials, git token) are AES-256-GCM encrypted in SQLite with a key in `data/secret.key` (or `MH_SECRET_KEY`). Protect `data/` with NTFS permissions; anyone who can read both the DB and the key can decrypt.
- Logs and diagnostic bundles are redacted (webhook URLs, JWTs, credential-like keys).
- File access is confined to the work directory plus *allowed roots*; symlinks are not followed when scanning; user text is never passed to a shell (processes use argument arrays).
- Outbound URLs for uploads/webhooks are HTTPS-only, restricted to public addresses unless explicitly allowed per destination.
