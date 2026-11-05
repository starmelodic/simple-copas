# HTTP API Reference — Simple Copas v2

Base URL: `http://<host>:<port>` (default `http://localhost:6000`).
All API responses are `application/json; charset=utf-8` unless noted.
Errors use the shape `{ "error": "<code>", "message": "<human readable>" }`.

Unknown `/api/*` paths return `404 {"error":"not_found"}` — never the SPA shell.

---

## Content types accepted

| Route | Accepted `Content-Type` |
|---|---|
| `POST /api/pastes` | `application/json` (JSON response) · `application/x-www-form-urlencoded` (legacy HTML response) |
| `DELETE /api/pastes/:id` | any; optional JSON body with `deleteToken` |

Request bodies are limited to `MAX_CONTENT_BYTES + 16 KiB`. A larger body
returns `413 {"error":"content_too_large"}`; malformed JSON returns
`400 {"error":"invalid_json"}`.

### JSON vs HTML response

`POST /api/pastes` returns JSON when **any** of these is true:

- query string contains `?format=json`
- `Content-Type: application/json`
- `Accept` contains `application/json` **and not** `text/html`

Otherwise the legacy HTML success page is returned (status is `201` in both cases).

---

## Paste object

Common fields (`summary`):

| Field | Type | Description |
|---|---|---|
| `id` | string | Short id, `4–32` chars of `[A-Za-z0-9_-]` |
| `title` | string \| null | Max 120 chars, trimmed; empty → `null` |
| `language` | string \| null | Lower-case token; `auto`, `text`, `plaintext` → `null` |
| `createdAt` | number | Unix epoch **milliseconds** |
| `expiresAt` | number \| null | Epoch ms; `null` = never expires |
| `views` | number | Read counter (incremented on `GET /raw/:id`) |
| `burnAfterRead` | boolean | One-time link |
| `size` | number | UTF-8 byte length of content |
| `lines` | number | Number of lines (`\n` split) |

Full paste (`GET /api/pastes/:id`) = summary + `content`.
Create response = summary + `content` + `url`, `rawUrl`, `deleteToken`.

---

## `POST /api/pastes` — create

**Body (JSON)**

```json
{
  "content": "hello world",
  "title": "Greeting",
  "language": "javascript",
  "expiresIn": "1h",
  "burnAfterRead": false
}
```

| Field | Required | Notes |
|---|---|---|
| `content` | ✅ | Must not be blank after trim. `\r\n`/`\r` normalized to `\n`. |
| `title` | | Truncated to 120 chars. |
| `language` | | Matched by `^[a-z0-9+#._-]{1,32}$` after lower-casing; invalid → `null`. |
| `expiresIn` | | `NNm`, `NNh`, `NNd`, or `never`/`""`/`0`/`false`. Ignored if omitted (see `DEFAULT_EXPIRY_DAYS`). |
| `burnAfterRead` | | `true` (JSON) or `"on"` (form). |

**Example**

```bash
curl -i -X POST http://localhost:6000/api/pastes \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -d '{"content":"npm install && npm start","language":"bash","expiresIn":"7d"}'
```

**`201 Created`**

```json
{
  "id": "V1StGX",
  "title": null,
  "language": "bash",
  "createdAt": 1736380000000,
  "expiresAt": 1736984800000,
  "views": 0,
  "burnAfterRead": false,
  "size": 22,
  "lines": 1,
  "content": "npm install && npm start",
  "url": "http://localhost:6000/V1StGX",
  "rawUrl": "http://localhost:6000/raw/V1StGX",
  "deleteToken": "k3Jf0Q9mA1uYzXbV2c4gPQ"
}
```

`deleteToken` is returned **only here**. It is stored server-side as a SHA-256
hash and cannot be recovered later.

**Errors**

| Status | `error` | When |
|---|---|---|
| `400` | `empty_content` | `content` missing, not a string, or whitespace-only |
| `400` | `invalid_expiry` | `expiresIn` not `NNm/NNh/NNd/never`, or exceeds `MAX_EXPIRY_DAYS` |
| `413` | `content_too_large` | UTF-8 bytes > `MAX_CONTENT_BYTES` (includes `maxBytes`) |
| `429` | `rate_limited` | Over `RATE_LIMIT_MAX` per window; includes `Retry-After` |

Rate-limit headers on every create attempt:
`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (epoch seconds).

---

## `GET /api/pastes/:id` — read (JSON)

```http
GET /api/pastes/V1StGX   → 200 full paste object (summary + content)
                         → 404 {"error":"not_found"}  (unknown, expired, or malformed id)
```

A malformed id (not matching `^[A-Za-z0-9_-]{4,32}$`) also returns `404`; no
lookup is attempted.

## `GET /raw/:id` — read (plain text)

| | |
|---|---|
| Success | `200 text/plain; charset=utf-8`, body = content |
| Headers | `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox` |
| Download | `GET /raw/:id?download=1` (or any `?download...`) → `Content-Disposition: attachment; filename="<id>[-<title-slug>].txt"` |
| Missing | `404 text/plain`, body `Paste not found` |
| Views | Increments `views` |
| Burn | If `burnAfterRead`, the paste is deleted **after** the response is sent |

---

## `DELETE /api/pastes/:id` — delete

Token is read from (in order): `X-Delete-Token` header, `?token=`, or JSON
body `deleteToken`.

```bash
curl -X DELETE http://localhost:6000/api/pastes/V1StGX \
  -H 'X-Delete-Token: k3Jf0Q9mA1uYzXbV2c4gPQ'
```

| Status | Body | When |
|---|---|---|
| `200` | `{"deleted":true,"id":"V1StGX"}` | ok |
| `403` | `{"error":"invalid_token", ...}` | missing/wrong token |
| `404` | `{"error":"not_found"}` | unknown, expired, or malformed id |

Token comparison is constant-time.

---

## `GET /api/pastes?limit=N` — recent pastes

Returns metadata only — **no content, no tokens**. Sorted newest-first.
`limit` is clamped to `1–100`, default `20`; non-numeric falls back to `20`.

```json
{ "pastes": [ { "id": "…", "title": "…", "language": "…", "createdAt": 0,
                "expiresAt": null, "views": 0, "burnAfterRead": false,
                "size": 11, "lines": 1 } ] }
```

## `GET /api/health` — health check

```json
{ "status": "ok", "version": "2.0.0", "pastes": 42, "uptime": 3600 }
```

Used by the Docker `HEALTHCHECK`.

---

## Legacy compatibility

| Shape | Behaviour |
|---|---|
| `POST /api/pastes` as `application/x-www-form-urlencoded` with `content` | Returns the v1 HTML success page with link and delete token |
| `GET /:id` | Returns the SPA shell (`public/index.html`) if the paste exists, else `404` with `public/404.html` |
| `pastes/*.txt` files | Imported once at boot from `LEGACY_PASTES_DIR` (files are not deleted) |

---

## URL surface summary

| Path | Purpose |
|---|---|
| `/` | SPA: create form + recent pastes |
| `/:id` (e.g. `/V1StGX`) | SPA: view paste (existence checked server-side) |
| `/p/:id` | SPA shell served without existence check (client then fetches `/api/pastes/:id`) |
| `/raw/:id` | Plain-text content |
| `/raw/:id?download=1` | Download as `.txt` |
| `/api/...` | JSON API (see above) |
| static | `/app.js`, `/styles.css`, `/favicon.svg` |
