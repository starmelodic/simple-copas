# 📝 Simple Copas

Paste text or code, get a short link. Self-hosted, zero-config, single process.
No accounts — no database server — no build step for the frontend.

**v2** turns the original single-file demo into a complete fullstack app with
a JSON API, titles, syntax highlighting, expiring links, one-time links,
delete tokens, rate limiting, and a proper responsive UI.

## ✨ Features

| | |
|---|---|
| 🔗 **Short URLs** | 6-character Nanoid IDs (`domain.com/abc123`) |
| 📋 **Copy helpers** | Copy link, copy content, raw view, download as `.txt` |
| 🎨 **Syntax highlighting** | Language picker + Prism (lazy-loaded) |
| ⏳ **Expiring pastes** | `10m`, `1h`, `1d`, `7d`, `30d`, or never; auto-pruned |
| 🔥 **Burn after reading** | Link self-destructs after the first raw read |
| 🗑️ **Delete tokens** | Only the creator's browser holds the token needed to delete |
| 🔒 **Safe rendering** | Content escaped client-side *and* server-side; strict CSP |
| 🚦 **Rate limited** | Per-IP creation limit (default 30/hour) |
| 📦 **Persistent storage** | Append-only JSONL log + in-memory index |
| 🌗 **Dark / light theme** | Follows system, toggleable, remembered |
| 🧪 **Tested** | `node:test` integration suite |
| 🐳 **Docker ready** | Multi-stage image, healthcheck, compose file |
| 🔁 **Backward compatible** | Old `GET /:id`, `GET /raw/:id` and form posts still work; legacy `pastes/*.txt` imported on boot |

## 📦 Quick start

Requires **Node.js ≥ 20**.

```bash
git clone https://github.com/starmelodic/simple-copas.git
cd simple-copas
npm install
npm start
# → http://localhost:6000
```

Development (auto-restart on change):

```bash
npm run dev
```

Tests:

```bash
npm test
```

Create a paste from the terminal:

```bash
npm run paste -- "hello world" --title "Greeting" --language bash --expires 1h
echo "from stdin" | npm run paste
COPAS_URL=https://paste.example.com npm run paste -- --file notes.md --language markdown
```

The output is the paste URL, raw URL and delete token. `npm run paste` talks to
`COPAS_URL` (default `http://localhost:$PORT`), so the server must be running.
Run it directly with `node examples/create-paste.mjs --help` for all options
(`--title`, `--language`, `--expires`, `--burn`, `--file`, stdin).

## ⚙️ Configuration

All settings come from environment variables (see [`.env.example`](.env.example)):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `6000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `NODE_ENV` | `development` | `production` enables asset caching |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-*` (set when behind Nginx) |
| `BASE_URL` | derived from `Host` | Absolute origin used in API responses (`url`, `rawUrl`). Set it behind a proxy if forwarded headers are not trusted, e.g. `https://paste.example.com`. No trailing slash needed. |
| `DATA_DIR` | `./data` | Storage directory |
| `LEGACY_PASTES_DIR` | `./pastes` | Old `.txt` pastes imported once at boot |
| `ID_LENGTH` | `6` | Short-link length (6–32) |
| `MAX_CONTENT_BYTES` | `524288` | Max paste size (512 KiB) |
| `RATE_LIMIT_MAX` | `30` | Max creates per client per hour |
| `RATE_LIMIT_SCOPE` | `ip+ua` (`ip` if `TRUST_PROXY=true`) | Rate-limit key: `ip` or `ip+ua` |
| `DEFAULT_EXPIRY_DAYS` | `0` | Applied when the client omits `expiresIn` (0 = never) |
| `MAX_EXPIRY_DAYS` | `365` | Upper bound on expiry |
| `CLEANUP_INTERVAL_MS` | `600000` | How often expired pastes are purged (≤ 0 disables) |

> `npm start` does not load `.env` automatically — export the variables or use
> `node --env-file=.env index.js` (Node ≥ 20.6).

## 🛠️ HTTP API

Base URL: `/api`. All responses are JSON unless stated.
Full reference (all fields, headers, status codes, error table):
**[docs/API.md](docs/API.md)**. Deployment and operations:
**[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

### Create a paste

```http
POST /api/pastes
Content-Type: application/json
Accept: application/json

{
  "content": "hello world",
  "title": "Greeting",          // optional, ≤ 120 chars
  "language": "javascript",     // optional, used for highlighting
  "expiresIn": "1h",            // optional: 10m | 1h | 1d | 7d | 30d | never
  "burnAfterRead": false        // optional
}
```

`201 Created`:

```json
{
  "id": "V1StGX",
  "title": "Greeting",
  "language": "javascript",
  "createdAt": 1736380000000,
  "expiresAt": 1736383600000,
  "views": 0,
  "burnAfterRead": false,
  "size": 11,
  "lines": 1,
  "content": "hello world",
  "url": "http://localhost:6000/V1StGX",
  "rawUrl": "http://localhost:6000/raw/V1StGX",
  "deleteToken": "…"            // keep it to delete the paste later
}
```

Errors: `400 empty_content`, `400 invalid_expiry`, `413 content_too_large`,
`429 rate_limited` (with `Retry-After`).

**Legacy form post** — the same endpoint with
`Content-Type: application/x-www-form-urlencoded` and a `content` field
renders the HTML success page (as in v1).

### JavaScript / Node client

`src/client.js` is a zero-dependency wrapper around this API (Node ≥ 20,
browsers, Deno, Bun — anything with `fetch`):

```js
import { createClient, CopasError } from "simple-copas/src/client.js";

const copas = createClient({ baseUrl: "http://localhost:6000" });

const paste = await copas.create("npm install && npm start", {
  title: "Run it",
  language: "bash",
  expiresIn: "7d",
});
console.log(paste.url);         // share this
console.log(paste.deleteToken); // keep this to delete later

await copas.createUrl("just the link");     // → string url
await copas.get(paste.id);                  // → raw text content
await copas.getMeta(paste.id);              // → full paste object (JSON)
await copas.recent(10);                     // → metadata list
await copas.remove(paste.id, paste.deleteToken); // → true
copas.downloadUrl(paste.id);                // → /raw/:id?download=1
await copas.health();
```

Every failure throws `CopasError` with `.status` (e.g. `400`), `.code`
(e.g. `empty_content`, `invalid_token`, `not_found`) and `.body`.

### Get a paste

```http
GET /api/pastes/:id        → 200 JSON (paste + content) | 404
GET /raw/:id               → 200 text/plain            | 404
GET /raw/:id?download=1    → text/plain, Content-Disposition: attachment
```

### Delete a paste

```http
DELETE /api/pastes/:id
X-Delete-Token: <deleteToken>
```

`200 {"deleted":true,"id":"…"}` · `403 invalid_token` · `404 not_found`

### List recent pastes (metadata only — no content, no tokens)

```http
GET /api/pastes?limit=20   → { "pastes": [ { id, title, language, createdAt, expiresAt, views, size, lines, burnAfterRead } ] }
```

### Health

```http
GET /api/health            → { status, version, pastes, uptime }
```

### Examples

```bash
# create
curl -s -X POST localhost:6000/api/pastes \
  -H 'Content-Type: application/json' \
  -d '{"content":"npm install && npm start","language":"bash","expiresIn":"7d"}'

# read raw
curl localhost:6000/raw/V1StGX

# delete
curl -X DELETE localhost:6000/api/pastes/V1StGX -H 'X-Delete-Token: <token>'
```

## 📁 Project structure

```
simple-copas/
├── index.js              # entry point: starts the server
├── src/
│   ├── app.js            # Express app factory: middleware, security headers, routes
│   ├── routes.js         # JSON API + raw/download + legacy HTML fallbacks
│   ├── client.js         # zero-dependency JS client for the HTTP API
│   ├── store.js          # PasteStore: JSONL persistence, expiry, delete tokens
│   ├── config.js         # environment configuration
│   └── utils.js          # escaping, rate limiter, expiry parsing
├── public/               # frontend (no build step)
│   ├── index.html        # app shell
│   ├── app.js            # client router, create/view/delete views
│   ├── styles.css        # design system, dark/light themes
│   ├── 404.html          # server-rendered not-found page
│   └── favicon.svg
├── examples/
│   └── create-paste.mjs  # CLI: create a paste from the terminal (npm run paste)
├── docs/
│   ├── API.md            # full HTTP API reference
│   └── DEPLOYMENT.md     # config, Docker, PM2, Nginx, ops
├── test/api.test.js      # node:test integration suite
├── Dockerfile
├── docker-compose.yml
└── data/                 # created at runtime (git-ignored)
    └── pastes.jsonl
```

### How storage works

Pastes are appended to `data/pastes.jsonl`, one JSON document per line, and
indexed in memory at boot — reads never hit the disk. View-count updates
append a small `{id, views}` line; deletes append a tombstone and compact.
The file is compacted at boot, after each delete, and after each expiry
prune — not after every create. To switch to
SQLite/Postgres later, only `src/store.js` needs to change.

> The pastes file stores content in plain text, like v1 did. Don't treat
> this as encrypted storage; put it on a volume you control.

## 🚀 Deployment

Quick options below; see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full
guide (configuration, storage/backup, health checks, troubleshooting).

### PM2

```bash
npm install -g pm2
npm run pm2:start      # or: pm2 start index.js --name simple-copas
pm2 save
```

### Docker

```bash
docker compose up -d --build     # http://localhost:6000, data in a named volume
# or
docker build -t simple-copas .
docker run -d -p 6000:6000 -v copas-data:/data --name simple-copas simple-copas
```

### Nginx reverse proxy

```nginx
server {
    listen 443 ssl http2;
    server_name paste.example.com;

    # must be >= the app's MAX_CONTENT_BYTES + overhead
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

Run the app with `TRUST_PROXY=true` so rate limiting sees real client IPs.

## 🧪 Testing

```bash
npm test
```

The suite boots the app on an ephemeral port with a temporary data directory
and covers creation, validation, size limits, expiry, deletion auth,
burn-after-reading, path-traversal attempts, HTML escaping, persistence across
restarts, rate limiting, and security headers.

## 🔐 Security notes

- Stored content is never injected into HTML unescaped. The SPA escapes on
  render; the legacy form fallback escapes server-side.
- Paste IDs are validated against `^[A-Za-z0-9_-]{4,32}$` before any lookup,
  closing the path-traversal bug in v1's `/raw/:id`.
- Raw responses get `nosniff` and a sandboxing CSP.
- Delete tokens are 128-bit random and compared in constant time.
- Request bodies are capped at `MAX_CONTENT_BYTES` + overhead.

## 📝 License

MIT © W a N
