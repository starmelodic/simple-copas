import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { nanoid, customAlphabet } from "nanoid";

const idAlphabet =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const randomId = customAlphabet(idAlphabet);

const TMP_SUFFIX = ".tmp";

/**
 * Storage is a JSONL log, loaded into memory on boot. The log holds two kinds
 * of lines:
 *
 *   - a full document  `{ id, title, content, ... }`
 *   - a mutation        `{ id, views }` or `{ id, deleted: true }`
 *
 * Mutations are folded into the in-memory document on load, so a view-count
 * update never rewrites (or loses) the paste itself. Compaction rewrites the
 * file from memory.
 *
 * Every write goes through one serial queue, and deletes/prunes delete from
 * memory only after the tombstone has been appended, so a failed write leaves
 * the store consistent with the file.
 *
 * All pastes live in memory, so reads never touch the disk.
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
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // Skip corrupted lines rather than failing the whole boot.
      }
      if (!entry || typeof entry.id !== "string") continue;

      const current = this.pastes.get(entry.id);
      if (typeof entry.content === "string") {
        // Full document.
        this.pastes.set(entry.id, entry);
      } else if (entry.deleted === true) {
        this.pastes.delete(entry.id);
      } else if (current && typeof entry.views === "number") {
        current.views = entry.views;
      }
    }
    await this.#compact();
  }

  /**
   * Rewrite the log atomically. Leftover temp files from a crashed run are
   * removed too, otherwise a killed process would leak them forever.
   */
  async #compact() {
    const lines = [];
    for (const doc of this.pastes.values()) {
      lines.push(JSON.stringify(doc));
    }
    const tmp = `${this.filePath}.${process.pid}${TMP_SUFFIX}`;
    const handle = await fs.open(tmp, "w");
    try {
      await handle.writeFile(lines.join("\n") + (lines.length ? "\n" : ""));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, this.filePath);
    await this.#removeStaleTemps();
  }

  async #removeStaleTemps() {
    const dir = path.dirname(this.filePath);
    const base = path.basename(this.filePath);
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(`${base}.`) && name.endsWith(TMP_SUFFIX)) {
        if (name === `${base}.${process.pid}${TMP_SUFFIX}`) continue;
        await fs.rm(path.join(dir, name), { force: true }).catch(() => {});
      }
    }
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

  async #append(entry) {
    await fs.appendFile(this.filePath, JSON.stringify(entry) + "\n");
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

  /**
   * Bump a paste's view counter. Best-effort: the in-memory counter is always
   * exact, the persisted one is retried by the next compaction.
   */
  recordView(id) {
    const doc = this.pastes.get(id);
    if (!doc) return Promise.resolve();
    doc.views += 1;
    return this.#serial(() => this.#append({ id, views: doc.views })).catch((err) => {
      console.error("Failed to persist view count:", err.message);
    });
  }

  async create({ title, content, language, expiresAt, burnAfterRead }) {
    return this.#serial(async () => {
      const doc = {
        id: this.#allocateId(),
        title: title || null,
        content,
        language: language || null,
        createdAt: Date.now(),
        expiresAt: expiresAt ?? null,
        views: 0,
        burnAfterRead: Boolean(burnAfterRead),
        deleteTokenHash: null,
      };
      const deleteToken = crypto.randomBytes(16).toString("base64url");
      doc.deleteTokenHash = hashToken(deleteToken);

      await this.#append(doc);
      this.pastes.set(doc.id, doc);
      return { doc, deleteToken };
    });
  }

  #allocateId() {
    const tries = 20;
    for (let attempt = 0; attempt < tries; attempt++) {
      const candidate = this.idLength === 6 ? nanoid(6) : randomId(this.idLength);
      if (!this.pastes.has(candidate)) return candidate;
    }
    throw new Error("Failed to allocate a unique paste id");
  }

  /**
   * Delete a one-time paste. The caller must check `burnAfterRead` first and
   * must not await this before the content has been sent.
   */
  async consumeBurnAfterRead(id) {
    const doc = this.pastes.get(id);
    if (!doc || !doc.burnAfterRead) return false;
    await this.#remove(id);
    return true;
  }

  verifyDeleteToken(id, token) {
    const doc = this.pastes.get(id);
    if (!doc || !doc.deleteTokenHash || !token) return false;
    if (typeof token !== "string") return false;
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
    await this.#serial(async () => {
      if (!this.pastes.has(id)) return;
      await this.#append({ id, deleted: true });
      this.pastes.delete(id);
      await this.#compact();
    });
  }

  /** Delete expired pastes and compact; returns how many were removed. */
  async pruneExpired(now = Date.now()) {
    return this.#serial(async () => {
      const expired = [];
      for (const [id, doc] of this.pastes) {
        if (this.isExpired(doc, now)) expired.push(id);
      }
      for (const id of expired) this.pastes.delete(id);
      if (expired.length === 0) return 0;
      await this.#compact();
      return expired.length;
    });
  }

  /** Total number of live, un-expired pastes. */
  size() {
    const now = Date.now();
    let n = 0;
    for (const doc of this.pastes.values()) if (!this.isExpired(doc, now)) n++;
    return n;
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
    const fullPath = path.join(dir, entry.name);
    const [content, stat] = await Promise.all([fs.readFile(fullPath, "utf8"), fs.stat(fullPath)]);
    // Insert directly so the recycled id is preserved.
    store.pastes.set(id, {
      id,
      title: null,
      content,
      language: null,
      createdAt: stat.mtimeMs || Date.now(),
      expiresAt: null,
      views: 0,
      burnAfterRead: false,
      deleteTokenHash: null,
    });
    imported++;
  }
  if (imported > 0) await store.compactNow();
  return imported;
}
