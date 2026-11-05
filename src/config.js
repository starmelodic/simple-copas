import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

const dataDir = path.resolve(ROOT, process.env.DATA_DIR || "./data");
const legacyPastesDir = path.resolve(ROOT, process.env.LEGACY_PASTES_DIR || "./pastes");

/**
 * Any env value that looks like a previous session secret is replaced so
 * sessions cannot leak between restarts by accident.
 */
export const config = {
  root: ROOT,
  port: envInt("PORT", 6000),
  host: process.env.HOST || "0.0.0.0",
  trustProxy: envBool("TRUST_PROXY", false),
  nodeEnv: process.env.NODE_ENV || "development",
  dataDir,
  legacyPastesDir,
  pastesFile: path.join(dataDir, "pastes.jsonl"),
  publicDir: path.join(ROOT, "public"),

  idLength: Math.min(32, Math.max(6, envInt("ID_LENGTH", 6))),
  maxContentBytes: envInt("MAX_CONTENT_BYTES", 512 * 1024), // 512 KiB
  maxTitleLength: 120,
  maxPastesPerHour: envInt("RATE_LIMIT_MAX", 30),
  rateWindowMs: 60 * 60 * 1000,
  // "ip" when the real client IP is trustworthy (TRUST_PROXY), otherwise
  // "ip+ua" so one NAT'd network or proxy doesn't exhaust everyone's quota.
  rateScope: process.env.RATE_LIMIT_SCOPE || (envBool("TRUST_PROXY", false) ? "ip" : "ip+ua"),
  defaultExpiryDays: envInt("DEFAULT_EXPIRY_DAYS", 0), // 0 = never
  maxExpiryDays: envInt("MAX_EXPIRY_DAYS", 365),
  cleanupIntervalMs: envInt("CLEANUP_INTERVAL_MS", 10 * 60 * 1000),
  baseUrl: process.env.BASE_URL || null,
  version: "2.0.0",
};
