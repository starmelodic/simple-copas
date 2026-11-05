import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { nanoid, customAlphabet } from "nanoid";

const idAlphabet =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const randomId = customAlphabet(idAlphabet);

/**
 * Storage is an append-only JSONL file, loaded into memory on boot and
 * compacted after every write. Every paste lives entirely in memory, so
 * reads never touch the disk; deletions and expiry rewrites go through a
 * single serial queue to keep the log consistent.
 *
 * Document shape:
 *   { id, title, content, language, createdAt, expiresAt, views, burnAfterRead,
 *     deleteTokenHash, deleted }
 */
export class PasteStore {
  #queue = Promise.resolve();

  constructor({ filePath, idLength = 6 }) {
    this.filePath = filePath;
    this.idLength = idLength;
    /** @type {Map<string, object>} */
    this.pastes = new Map();
    this.ready = false;
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await this.#load();
    this.ready = true;
  }

  async #load() {
    let raw = "";
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const doc = JSON.parse(line);
        if (doc && typeof doc.id === "string") {
          this.pastes.set(doc.id, doc);
        }
      } catch {
        // Skip corrupted lines rather than failing the whole boot.
      }
    }
    // Apply tombstones: `deleted: true` removes the id from the live map.
    // (Tombstones are written as a separate line with the same id; the
    // in-memory Map keeps the latest entry, so a tombstone replaces it.)
    for (const [id, doc] of this.pastes) {
      if (doc.deleted) this.pastes.delete(id);
    }
    await this.#compact();
  }

  async #compact() {
    const lines = [];
    for (const doc of this.pastes.values()) {
      lines.push(JSON.stringify(doc));
    }
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, lines.join("\n") + (lines.length ? "\n" : ""));
    await fs.rename(tmp, this.filePath);
  }

  /** Force a rewrite of the log from the in-memory state. */
  compactNow() {
    return this.#serial(() => this.#compact());
  }

  #serial(fn) {
    const run = this.#queue.then(fn, fn);
    // Keep the queue alive even if this operation rejects.
    this.#queue = run.catch(() => {});
    return run;
  }

  async #persist(doc) {
    await fs.appendFile(this.filePath, JSON.stringify(doc) + "\n");
  }

  isExpired(doc, now = Date.now()) {
    return doc.expiresAt !== null && doc.expiresAt <= now;
  }

  /** Get a live paste; expired pastes are treated as missing. */
  get(id) {
    const doc = this.pastes.get(id);
    if (!doc) return null;
    if (this.isExpired(doc)) return null;
    return doc;
  }

  async create({ title, content, language, expiresAt, burnAfterRead }) {
    return this.#serial(async () => {
      let id;
      for (let attempt = 0; attempt < 20; attempt++) {
        const candidate = this.idLength === 6 ? nanoid(6) : randomId(this.idLength);
        if (!this.pastes.has(candidate)) {
          id = candidate;
          break;
        }
      }
      if (!id) throw new Error("Failed to allocate a unique paste id");

      const now = Date.now();
      const deleteToken = crypto.randomBytes(16).toString("base64url");
      const doc = {
        id,
        title: title || null,
        content,
        language: language || null,
        createdAt: now,
        expiresAt: expiresAt ?? null,
        views: 0,
        burnAfterRead: Boolean(burnAfterRead),
        deleteTokenHash: hashToken(deleteToken),
      };
      this.pastes.set(id, doc);
      await this.#persist(doc);
      return { doc, deleteToken };
    });
  }

  /**
   * Increment the view counter. Fire-and-forget from the route's perspective:
   * the persisted counter is best-effort, the in-memory read is exact.
   */
  async recordView(id) {
    const doc = this.pastes.get(id);
    if (!doc) return;
    doc.views += 1;
    try {
      await this.#serial(() => this.#persist({ id, views: doc.views }));
    } catch (err) {
      console.error("Failed to persist view count:", err.message);
    }
  }

  async consumeBurnAfterRead(id) {
    const doc = this.pastes.get(id);
    if (!doc || !doc.burnAfterRead) return;
    await this.#remove(id);
  }

  verifyDeleteToken(id, token) {
    const doc = this.pastes.get(id);
    if (!doc || !doc.deleteTokenHash || !token) return false;
    const expected = Buffer.from(doc.deleteTokenHash, "hex");
    const actual = Buffer.from(hashToken(token), "hex");
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  async delete(id, token) {
    if (!this.verifyDeleteToken(id, token)) return false;
    await this.#remove(id);
    return true;
  }

  async #remove(id) {
    if (!this.pastes.delete(id)) return;
    await this.#serial(async () => {
      await this.#persist({ id, deleted: true });
      await this.#compact();
    });
  }

  /** Delete expired pastes and compact; returns how many were removed. */
  async pruneExpired(now = Date.now()) {
    const expired = [];
    for (const [id, doc] of this.pastes) {
      if (this.isExpired(doc, now)) expired.push(id);
    }
    if (expired.length === 0) return 0;
    for (const id of expired) this.pastes.delete(id);
    await this.#serial(() => this.#compact());
    return expired.length;
  }

  /** Total number of live, un-expired pastes. */
  size() {
    return this.pastes.size;
  }

  /** Newest-first list of public-facing summaries (no content, no tokens). */
  recent(limit = 20) {
    const out = [];
    for (const doc of this.pastes.values()) {
      if (this.isExpired(doc)) continue;
      out.push(toSummary(doc));
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out.slice(0, limit);
  }
}

export function toSummary(doc) {
  return {
    id: doc.id,
    title: doc.title,
    language: doc.language,
    createdAt: doc.createdAt,
    expiresAt: doc.expiresAt,
    views: doc.views,
    burnAfterRead: Boolean(doc.burnAfterRead),
    size: Buffer.byteLength(doc.content, "utf8"),
    lines: doc.content.split("\n").length,
  };
}

export function toPublic(doc) {
  return { ...toSummary(doc), content: doc.content };
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * One-time migration for the old flat-file storage: every `<id>.txt` in the
 * legacy folder becomes a paste. Existing rows are left untouched, and the
 * files are ignored afterwards (not deleted, in case anything was shared).
 */
export async function migrateLegacyPastes(store, dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return 0;
    throw err;
  }
  let imported = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".txt")) continue;
    const id = entry.name.slice(0, -4);
    if (!/^[A-Za-z0-9_-]{4,32}$/.test(id)) continue;
    if (store.pastes.has(id)) continue;
    const content = await fs.readFile(path.join(dir, entry.name), "utf8");
    const stat = await fs.stat(path.join(dir, entry.name));
    const doc = {
      id,
      title: null,
      content,
      language: null,
      createdAt: stat.mtimeMs || Date.now(),
      expiresAt: null,
      views: 0,
      burnAfterRead: false,
      deleteTokenHash: null,
    };
    // Insert directly so the recycled id is preserved.
    store.pastes.set(id, doc);
    imported++;
  }
  if (imported > 0) await store.compactNow();
  return imported;
}
