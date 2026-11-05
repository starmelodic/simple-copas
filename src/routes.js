import express from "express";
import { toPublic } from "./store.js";
import { baseUrlFor, escapeHtml, parseExpiry } from "./utils.js";

const ID_PATTERN = /^[A-Za-z0-9_-]{4,32}$/;

export function isPasteId(id) {
  return typeof id === "string" && ID_PATTERN.test(id);
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  // Normalize CRLF so line numbering and size are consistent.
  const normalized = value.replace(/\r\n?/g, "\n");
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

function wantsJson(req) {
  if (req.query.format === "json") return true;
  if (req.is("application/json")) return true;
  const accept = req.headers.accept || "";
  return accept.includes("application/json") && !accept.includes("text/html");
}

function normalizeLanguage(value) {
  if (typeof value !== "string") return null;
  const lang = value.trim().toLowerCase();
  if (!lang || lang === "auto" || lang === "text" || lang === "plaintext") return null;
  return /^[a-z0-9+#._-]{1,32}$/.test(lang) ? lang : null;
}

function boolLike(value) {
  return value === true || value === "true" || value === "on" || value === "1";
}

/**
 * @param {{ store: import("./store.js").PasteStore, config: object, createLimiter: Function }} deps
 */
export function createRouter({ store, config, createLimiter }) {
  const router = express.Router();

  // ------------------------------------------------------------------ API

  router.get("/api/health", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      status: "ok",
      version: config.version,
      pastes: store.size(),
      uptime: Math.round(process.uptime()),
    });
  });

  router.get("/api/pastes", (req, res) => {
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const base = baseUrlFor(req, config);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      pastes: store.recent(limit).map((paste) => ({
        ...paste,
        url: `${base}/${paste.id}`,
      })),
    });
  });

  router.post("/api/pastes", createLimiter, async (req, res) => {
    const body = req.body ?? {};

    const rawContent = typeof body.content === "string" ? body.content : "";
    const bytes = Buffer.byteLength(rawContent, "utf8");
    if (rawContent.trim() === "") {
      return res.status(400).json({
        error: "empty_content",
        message: "Paste content cannot be empty.",
      });
    }
    if (bytes > config.maxContentBytes) {
      return res.status(413).json({
        error: "content_too_large",
        message: `Paste content exceeds the ${Math.floor(config.maxContentBytes / 1024)} KiB limit.`,
        maxBytes: config.maxContentBytes,
      });
    }

    const title = cleanText(body.title, config.maxTitleLength).trim() || null;

    let expiresAt;
    if (body.expiresIn !== undefined) {
      const parsed = parseExpiry(body.expiresIn, { maxDays: config.maxExpiryDays });
      if (parsed.error) {
        return res.status(400).json({ error: "invalid_expiry", message: parsed.error });
      }
      expiresAt = parsed.expiresAt;
    } else {
      expiresAt =
        config.defaultExpiryDays > 0
          ? Date.now() + config.defaultExpiryDays * 86_400_000
          : null;
    }

    const { doc, deleteToken } = await store.create({
      title,
      content: rawContent.replace(/\r\n?/g, "\n"),
      language: normalizeLanguage(body.language),
      expiresAt,
      burnAfterRead: boolLike(body.burnAfterRead),
    });

    const base = baseUrlFor(req, config);

    if (wantsJson(req)) {
      return res.status(201).json({
        ...toPublic(doc),
        url: `${base}/${doc.id}`,
        rawUrl: `${base}/raw/${doc.id}`,
        deleteToken,
      });
    }

    // Legacy form-post behaviour: render the old success page so existing
    // clients and bookmarks keep working.
    res.status(201).send(renderCreatedPage({ doc, base, deleteToken }));
  });

  router.get("/api/pastes/:id", (req, res) => {
    const { id } = req.params;
    res.setHeader("Cache-Control", "no-store");
    if (!isPasteId(id)) return res.status(404).json({ error: "not_found" });
    const doc = store.get(id);
    if (!doc) return res.status(404).json({ error: "not_found", message: "Paste not found or expired." });
    res.json(toPublic(doc));
  });

  router.delete("/api/pastes/:id", async (req, res) => {
    const { id } = req.params;
    const token = req.headers["x-delete-token"] || req.query.token || req.body?.deleteToken;
    if (!isPasteId(id) || !store.get(id)) {
      return res.status(404).json({ error: "not_found" });
    }
    if (!store.verifyDeleteToken(id, token)) {
      return res.status(403).json({
        error: "invalid_token",
        message: "A valid delete token is required to delete this paste.",
      });
    }
    await store.delete(id, token);
    res.json({ deleted: true, id });
  });

  // ----------------------------------------------------------------- pages

  router.get("/raw/:id", (req, res) => {
    const { id } = req.params;
    if (!isPasteId(id)) return res.status(404).type("text/plain").send("Paste not found");
    const doc = store.get(id);
    if (!doc) return res.status(404).type("text/plain").send("Paste not found");

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Cache-Control", "no-store");
    if (req.query.download !== undefined) {
      const safeName = `${id}${doc.title ? "-" + slugify(doc.title) : ""}.txt`;
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    }

    // Capture the one-time flag *now*. It is consumed once the content has
    // actually been flushed to this client, so a client that disconnects
    // mid-transfer does not destroy the paste.
    const oneTime = doc.burnAfterRead;
    if (oneTime) {
      res.on("finish", () => {
        store.consumeBurnAfterRead(id).catch((err) => {
          console.error("Failed to burn paste:", err.message);
        });
      });
    }

    res.send(doc.content);
    store.recordView(id);
  });

  router.get("/robots.txt", (req, res) => {
    res.type("text/plain").send("User-agent: *\nDisallow: /api/\nDisallow: /raw/\n");
  });

  // Any other /api path is a JSON 404, never the SPA shell.
  router.use("/api", (req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  return router;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function renderCreatedPage({ doc, base, deleteToken }) {
  const id = escapeHtml(doc.id);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Paste created · Simple Copas</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; background: #f5f5f5; }
    .container { background: #fff; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,.1); }
    .url-box { margin: 20px 0; padding: 20px; background: #f8f9fa; border-radius: 8px; border: 1px solid #e9ecef; }
    .short-url { font-size: 1.8em; font-weight: bold; color: #007bff; word-break: break-all; text-decoration: none; }
    .btn { display: inline-block; background: #007bff; color: #fff; padding: 10px 20px; border-radius: 5px; text-decoration: none; margin: 4px 10px 4px 0; border: 0; cursor: pointer; }
    .btn-secondary { background: #6c757d; }
    code { background: #e9ecef; padding: 2px 6px; border-radius: 3px; word-break: break-all; }
  </style>
</head>
<body>
  <div class="container">
    <h1 style="color:#28a745;margin-top:0">✅ Paste created</h1>
    <div class="url-box">
      <div style="color:#666;margin-bottom:5px">🔗 Your paste URL:</div>
      <a class="short-url" href="/${id}">${escapeHtml(base)}/${id}</a>
      <div style="margin-top:12px">
        <button class="btn" onclick="navigator.clipboard.writeText(location.origin + '/${id}');this.textContent='✅ Copied!'">📋 Copy URL</button>
        <a class="btn btn-secondary" href="/raw/${id}">📄 Raw</a>
        <a class="btn btn-secondary" href="/">✏️ New paste</a>
      </div>
    </div>
    <p style="color:#666;font-size:.9em">
      Keep this delete token to remove the paste later:
      <code>${escapeHtml(deleteToken)}</code>
    </p>
  </div>
</body>
</html>`;
}
