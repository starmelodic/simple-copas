/**
 * Escape a value for safe interpolation inside HTML text or attributes.
 * Used anywhere server-rendered data could contain `&<>"'`.
 */
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Safe target for `window.location` / raw `Location` headers. */
export function isSafeRelativeUrl(url) {
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//");
}

export function baseUrlFor(req, config) {
  if (config.baseUrl) return config.baseUrl.replace(/\/+$/, "");
  const host = req.headers.host || `localhost:${config.port}`;
  // Only trust forwarding headers when the operator opted in; otherwise a
  // client can make the API echo back arbitrary absolute URLs.
  const forwarded = config.trustProxy ? req.headers["x-forwarded-proto"] : null;
  const proto = forwarded || req.protocol || "http";
  return `${String(proto).split(",")[0].trim()}://${host}`;
}

export function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

/**
 * Fixed-window rate limiter keyed by an arbitrary key function.
 * In-memory only, which is fine for a single-process deployment.
 */
export function rateLimit({ windowMs, max, key = (req) => clientIp(req) }) {
  const buckets = new Map();

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) {
      if (b.resetAt <= now) buckets.delete(k);
    }
  }, windowMs);
  timer.unref?.();

  function middleware(req, res, next) {
    const now = Date.now();
    const k = key(req);
    let bucket = buckets.get(k);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(k, bucket);
    }
    bucket.count++;
    const remaining = Math.max(0, max - bucket.count);
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({
        error: "rate_limited",
        message: "Too many pastes created. Please slow down and try again later.",
      });
    }
    next();
  }

  middleware.stop = () => clearInterval(timer);
  return middleware;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Parse an expiry request into an absolute timestamp or null (never).
 * Accepts: `never`/empty, `1h`/`30m`-style durations, or `7d`.
 * Clamps to `maxDays` and rejects invalid values.
 */
export function parseExpiry(value, { maxDays, now = Date.now() }) {
  if (value === undefined || value === null) return { expiresAt: null };
  const raw = String(value).trim().toLowerCase();
  if (raw === "" || raw === "never" || raw === "0" || raw === "false") {
    return { expiresAt: null };
  }
  const match = /^(\d+)\s*(m|h|d)$/.exec(raw);
  if (!match) {
    return { error: "Expiry must look like 30m, 12h or 7d, or be 'never'." };
  }
  const amount = Number.parseInt(match[1], 10);
  if (amount <= 0) return { expiresAt: null };
  const unitMs = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : DAY_MS;
  const ms = amount * unitMs;
  if (maxDays > 0 && ms > maxDays * DAY_MS) {
    return { error: `Expiry cannot exceed ${maxDays} days.` };
  }
  return { expiresAt: now + ms };
}

export function expiresAtFromDays(days, now = Date.now()) {
  return days > 0 ? now + days * DAY_MS : null;
}

export { DAY_MS };
