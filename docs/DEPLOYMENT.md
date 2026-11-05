# Deployment & Operations — Simple Copas v2

Simple Copas is a single Node.js process (Node ≥ 20). It holds all paste
metadata in memory and persists to one append-only JSONL file. No external
database, no build step for the frontend.

---

## 1. Requirements

| | |
|---|---|
| Node.js | 20.x or newer (Docker image uses 22-alpine) |
| Disk | Space for `data/pastes.jsonl`; every paste lives in RAM, so RAM ≈ sum of all paste sizes × ~2 (JSON + parsed strings) |
| Port | `6000` by default |

> Because all pastes are held in memory, this is designed for small/medium
> communities. Tens of thousands of large pastes will need more RAM than disk.

---

## 2. Local / bare-metal

```bash
git clone https://github.com/starmelodic/simple-copas.git
cd simple-copas
npm install
npm start              # production-style start
# or
npm run dev            # auto-restart on file changes (node --watch)
```

Open <http://localhost:6000>.

`npm start` does **not** load `.env`. Either export variables in the shell, or:

```bash
cp .env.example .env
node --env-file=.env index.js      # Node ≥ 20.6
```

---

## 3. Configuration reference

All values are environment variables. Invalid integers fall back to the default.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `6000` | HTTP listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `NODE_ENV` | `development` | `production` enables 1-hour static asset caching |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-*`; **required** behind a reverse proxy |
| `BASE_URL` | derived from request | Absolute URL used for `url`/`rawUrl` in create responses |
| `DATA_DIR` | `./data` | Storage directory (resolved against project root) |
| `LEGACY_PASTES_DIR` | `./pastes` | Imported once at boot; missing directory is fine |
| `ID_LENGTH` | `6` | Short-link length, clamped to `6–32` |
| `MAX_CONTENT_BYTES` | `524288` (512 KiB) | Max paste size |
| `RATE_LIMIT_MAX` | `30` | Creates allowed per key per hour |
| `RATE_LIMIT_SCOPE` | `ip+ua` if `TRUST_PROXY=false`, else `ip` | Rate-limit key: `ip` or `ip+ua` |
| `DEFAULT_EXPIRY_DAYS` | `0` | Expiry applied when client omits `expiresIn`; `0` = never |
| `MAX_EXPIRY_DAYS` | `365` | Upper bound for client-supplied expiry |
| `CLEANUP_INTERVAL_MS` | `600000` | Interval for purging expired pastes; `≤0` disables |

Notes:

- `BASE_URL` is worth setting behind a proxy; otherwise the URL in responses is
  built from the `Host` header (and `X-Forwarded-Proto` when `TRUST_PROXY=true`).
- `RATE_LIMIT_SCOPE=ip+ua` (the default without `TRUST_PROXY`) isolates clients
  that share one NAT/proxy IP, but a client can evade it by changing
  User-Agent. With `TRUST_PROXY=true` the real client IP is used.

---

## 4. Storage & persistence

```
DATA_DIR/
└── pastes.jsonl      # one JSON object per line
```

- Append-only log, fully loaded into memory at boot; reads never touch disk.
- Writes (create, view-count update, delete tombstone) are appended.
- The file is compacted (rewritten from memory) at boot, after each delete,
  and after each expiry prune — not after every create. It therefore grows
  until one of those happens; this is intentional to avoid rewriting the whole
  file on every paste.
- Corrupt lines are skipped on load instead of failing startup.

**Backups:** back up `DATA_DIR/pastes.jsonl` (or the Docker volume). Paste
content is stored **in plain text** and is not encrypted at rest. Delete
tokens are stored only as SHA-256 hashes.

**Restart behaviour:** pastes and view counts survive restarts. Delete tokens
are lost if the client's `localStorage` is cleared (the server never reissues them).

### Legacy import

`.txt` files in `LEGACY_PASTES_DIR` whose name (sans extension) matches the id
pattern are imported once, keeping the same id. Already-present ids are skipped
and the files are not deleted.

---

## 5. Docker

```bash
docker compose up -d --build
# → http://localhost:6000, data in the named volume `copas-data`
```

or manually:

```bash
docker build -t simple-copas .
docker run -d --name simple-copas \
  -p 6000:6000 \
  -v copas-data:/data \
  -e TRUST_PROXY=true \
  -e BASE_URL=https://paste.example.com \
  simple-copas
```

The image runs as a non-root `app` user, stores data in `/data`, exposes
`6000`, and has a `HEALTHCHECK` against `/api/health`.

`docker-compose.yml` sets `TRUST_PROXY`, `MAX_CONTENT_BYTES` and
`RATE_LIMIT_MAX`; add more under `environment:` as needed.

---

## 6. PM2

```bash
npm install -g pm2
npm run pm2:start        # pm2 start index.js --name simple-copas
pm2 save
pm2 startup              # follow the printed instruction
pm2 logs simple-copas
```

The app handles `SIGINT`/`SIGTERM` by closing the HTTP server, stopping timers,
and exiting (with a 5-second forced timeout).

---

## 7. Nginx reverse proxy

```nginx
server {
    listen 80;
    server_name paste.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name paste.example.com;

    ssl_certificate     /etc/letsencrypt/live/paste.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/paste.example.com/privkey.pem;

    # must be >= MAX_CONTENT_BYTES + 16 KiB (body-parser overhead)
    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:6000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Run the app with `TRUST_PROXY=true` and ideally `BASE_URL=https://paste.example.com`.

---

## 8. Health & monitoring

- `GET /api/health` → `{ status: "ok", version, pastes, uptime }` (`uptime` in seconds).
- The endpoint is unauthenticated and cheap; use it for load-balancer checks.
- Log lines of interest: boot banner, `📦 Imported N legacy paste(s).`,
  `🧹 Removed N expired paste(s).`, `Failed to persist view count: …`.

---

## 9. Rate limiting

Fixed-window, in-memory, applies to `POST /api/pastes` only.

- Window: 1 hour.
- Limit: `RATE_LIMIT_MAX` per key (default 30).
- Response headers: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`.
- On exceed: `429` + `Retry-After` (seconds).

State is per-process: running multiple instances (e.g. `pm2 -i N`) means each
instance has its own counters. This app is designed for a single instance.

---

## 10. Security posture

| Item | Implementation |
|---|---|
| Security headers | `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer-when-downgrade`, `Permissions-Policy`, strict CSP (`script-src 'self' cdnjs`) |
| Raw endpoint | `text/plain` + `nosniff` + sandboxing CSP; not rendered as HTML |
| Id validation | `^[A-Za-z0-9_-]{4,32}$` before any lookup (no path traversal) |
| Delete tokens | 128-bit random (`crypto.randomBytes(16).base64url`), stored SHA-256, constant-time compare |
| HTML escaping | Server-rendered legacy pages escape everything; SPA escapes on render |
| Body size | Capped at `MAX_CONTENT_BYTES + 16 KiB` |
| `x-powered-by` | Disabled |

Not included out of the box: TLS termination, authentication, encryption at
rest, CSRF tokens (not needed for the JSON API; legacy form endpoint is same-site
only via CSP `form-action 'self'`).

---

## 11. Upgrading from v1

1. Stop the old process.
2. Place the old `pastes/*.txt` files in `LEGACY_PASTES_DIR` (default `./pastes`
   next to `index.js`) — they are imported on the next boot with the same ids.
3. Start v2. Old `GET /:id`, `GET /raw/:id` and form posts keep working.

Imported pastes have no delete token (cannot be deleted via API) and never expire.

---

## 12. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `url` in responses shows `http://` / wrong host | Behind proxy without `TRUST_PROXY=true` or `BASE_URL` |
| All users hit rate limit together | `RATE_LIMIT_MAX` too low, or proxy not configured with `TRUST_PROXY=true` |
| `413 content_too_large` from Nginx instead of JSON | Nginx `client_max_body_size` too small |
| Expired pastes still listed | Cleanup runs every `CLEANUP_INTERVAL_MS`; they are already hidden from reads, just not purged yet |
| Delete returns `403` | Wrong/expired token (e.g. browser storage cleared) |
| High memory | Expected: all pastes are in memory; lower `MAX_CONTENT_BYTES` or prune |

## 13. Testing

```bash
npm test           # node:test integration suite
npm run test:watch
```

The suite boots the app on an ephemeral port with a temporary data directory
and covers: create/read/raw, validation, size limits, expiry, delete auth,
burn-after-read, path traversal, HTML escaping, form posts, persistence across
restarts, listing/health redaction, SPA routing/404, security headers, and rate limiting.
