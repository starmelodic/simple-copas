import crypto from "node:crypto";
import express from "express";
import path from "node:path";
import { PasteStore, migrateLegacyPastes } from "./store.js";
import { createRouter, isPasteId } from "./routes.js";
import { rateLimit, clientIp } from "./utils.js";
import { config as defaultConfig } from "./config.js";

/**
 * Build (but do not start) the Express app. Tests use this directly with an
 * isolated data directory; `index.js` starts it for real.
 */
export async function createApp(overrides = {}) {
  const config = { ...defaultConfig, ...overrides };
  if (overrides.dataDir) {
    config.pastesFile = path.join(overrides.dataDir, "pastes.jsonl");
  }

  const store = new PasteStore({
    filePath: config.pastesFile,
    idLength: config.idLength,
  });
  await store.init();
  if (config.legacyPastesDir) {
    const imported = await migrateLegacyPastes(store, config.legacyPastesDir);
    if (imported > 0) console.log(`📦 Imported ${imported} legacy paste(s).`);
  }

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.locals.store = store;
  app.locals.config = config;

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer-when-downgrade");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self' https://cdnjs.cloudflare.com",
        "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com",
        "img-src 'self' data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
      ].join("; "),
    );
    if (config.trustProxy) {
      res.setHeader("Strict-Transport-Security", "max-age=15552000");
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Delete-Token");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, DELETE, OPTIONS");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });

  if (config.basicAuth) {
    app.use(basicAuth(config.basicAuth));
  }

  app.use(express.json({ limit: `${Math.ceil(config.maxContentBytes / 1024) + 16}kb` }));
  app.use(
    express.urlencoded({
      extended: false,
      limit: `${Math.ceil(config.maxContentBytes / 1024) + 16}kb`,
    }),
  );

  const createLimiter = rateLimit({
    windowMs: config.rateWindowMs,
    max: config.maxPastesPerHour,
    // `trust proxy` off leaves req.ip as the raw socket, which would put every
    // client behind Nginx in the same bucket. Then every client gets its own.
    key:
      config.rateScope === "ip"
        ? (req) => clientIp(req)
        : (req) => `${clientIp(req)}|${req.headers["user-agent"] ?? ""}`,
  });
  app.locals.createLimiter = createLimiter;

  // Static assets (favicon, app.js, styles.css, etc.)
  app.use(
    express.static(config.publicDir, {
      index: false,
      maxAge: config.nodeEnv === "production" ? "1h" : 0,
      etag: true,
      setHeaders(res, filePath) {
        // The SPA reuses file names across releases; never let a stale
        // app.js outlive an upgrade.
        if (/\.(?:js|css|html)$/.test(filePath)) res.setHeader("Cache-Control", "no-cache");
      },
    }),
  );

  const router = createRouter({ store, config, createLimiter });
  app.use(router);

  // SPA entry points. The client router reads `location.pathname`.
  app.get(["/", "/p/:id"], (req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(config.publicDir, "index.html"));
  });

  // Legacy short-URL shape: `/abc123` renders the same SPA client-side.
  app.get("/:id", (req, res) => {
    const { id } = req.params;
    if (!isPasteId(id) || !store.get(id)) {
      return res.status(404).sendFile(path.join(config.publicDir, "404.html"));
    }
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(config.publicDir, "index.html"));
  });

  // Body-parser errors (payload too large / malformed JSON) as JSON.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.type === "entity.too.large") {
      return res.status(413).json({
        error: "content_too_large",
        message: "Request body is too large.",
      });
    }
    if (err.type === "entity.parse.failed") {
      return res.status(400).json({ error: "invalid_json", message: "Malformed JSON body." });
    }
    console.error(err);
    res.status(500).json({ error: "internal_error", message: "Something went wrong." });
  });

  app.locals.stop = () => {
    createLimiter.stop();
    if (app.locals.cleanupTimer) clearInterval(app.locals.cleanupTimer);
    app.locals.cleanupTimer = null;
  };

  if (config.cleanupIntervalMs > 0) {
    let pruning = false;
    app.locals.cleanupTimer = setInterval(async () => {
      if (pruning) return; // a slow disk must not pile up overlapping prunes
      pruning = true;
      try {
        const n = await store.pruneExpired();
        if (n > 0) console.log(`🧹 Removed ${n} expired paste(s).`);
      } catch (err) {
        console.error("Failed to prune expired pastes:", err.message);
      } finally {
        pruning = false;
      }
    }, config.cleanupIntervalMs);
    app.locals.cleanupTimer.unref?.();
  }

  return { app, store, config };
}

/**
 * Optional HTTP Basic auth. Credentials are parsed once and compared in
 * constant time. Browsers send them on every request after the first prompt.
 */
function basicAuth(spec) {
  const sep = spec.indexOf(":");
  const user = Buffer.from(sep === -1 ? spec : spec.slice(0, sep));
  const pass = Buffer.from(sep === -1 ? "" : spec.slice(sep + 1));

  return function basicAuthMiddleware(req, res, next) {
    const header = req.headers.authorization || "";
    const [scheme, encoded] = header.split(" ");
    if (scheme === "Basic" && encoded) {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      const u = Buffer.from(idx === -1 ? decoded : decoded.slice(0, idx));
      const p = Buffer.from(idx === -1 ? "" : decoded.slice(idx + 1));
      const okUser = u.length === user.length && crypto.timingSafeEqual(u, user);
      const okPass = p.length === pass.length && crypto.timingSafeEqual(p, pass);
      if (okUser && okPass) return next();
    }
    res.setHeader("WWW-Authenticate", 'Basic realm="Simple Copas", charset="UTF-8"');
    res.status(401).json({ error: "unauthorized", message: "Authentication required." });
  };
}
