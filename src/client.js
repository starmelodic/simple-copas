/**
 * JavaScript client / wrapper for the Simple Copas HTTP API.
 *
 * Zero dependencies — uses global `fetch` (Node >= 20, browsers, Deno, Bun).
 *
 * @example
 * import { createClient } from "simple-copas/src/client.js";
 *
 * const copas = createClient({ baseUrl: "http://localhost:6000" });
 * const paste = await copas.create("npm install && npm start", {
 *   language: "bash",
 *   expiresIn: "7d",
 * });
 * console.log(paste.url);        // http://localhost:6000/V1StGX
 * console.log(paste.deleteToken); // keep it to delete later
 */

/** Error thrown for any non-2xx API response (or network failure). */
export class CopasError extends Error {
  constructor(message, { status = 0, code = "network_error", body = null } = {}) {
    super(message);
    this.name = "CopasError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/**
 * @typedef {object} CopasClientOptions
 * @property {string} [baseUrl]  Server root, e.g. `http://localhost:6000`. Default `http://localhost:6000`.
 * @property {string} [token]    Bearer-style extra header value sent as `X-Delete-Token` on delete calls.
 * @property {Function} [fetch]  Custom fetch implementation (for tests / older runtimes).
 * @property {number} [retries]  GET retries on network errors. Default 0.
 */

/**
 * Create a client bound to one Simple Copas server.
 * @param {CopasClientOptions} [options]
 */
export function createClient(options = {}) {
  const baseUrl = (options.baseUrl || "http://localhost:6000").replace(/\/+$/, "");
  const fetchImpl = options.fetch || globalThis.fetch;
  const retries = options.retries ?? 0;

  if (typeof fetchImpl !== "function") {
    throw new Error("No fetch implementation available; pass `fetch` in options.");
  }

  async function request(method, pathname, { body, headers = {}, query, raw = false, retry = 0 } = {}) {
    let url = baseUrl + pathname;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) params.set(k, String(v));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: {
          Accept: raw ? "text/plain" : "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      if (retry < retries) return request(method, pathname, { body, headers, query, raw, retry: retry + 1 });
      throw new CopasError(`Request to ${url} failed: ${err.message}`, { code: "network_error" });
    }

    if (raw) {
      const text = await res.text();
      if (!res.ok) {
        throw new CopasError(text || res.statusText, {
          status: res.status,
          code: res.status === 404 ? "not_found" : "http_error",
          body: text,
        });
      }
      return { text, response: res };
    }

    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      throw new CopasError(payload?.message || res.statusText || "Request failed", {
        status: res.status,
        code: payload?.error || "http_error",
        body: payload,
      });
    }
    return payload;
  }

  /**
   * Create a paste.
   * @param {string} content  Text to store (required, non-blank).
   * @param {object} [opts]
   * @param {string} [opts.title]
   * @param {string} [opts.language]       e.g. `javascript`, `bash`
   * @param {string|number|false} [opts.expiresIn]  `30m`, `12h`, `7d`, `never`
   * @param {boolean} [opts.burnAfterRead] One-time link
   * @returns {Promise<{id:string,url:string,rawUrl:string,deleteToken:string,content:string,size:number,lines:number,expiresAt:number|null,createdAt:number,title:string|null,language:string|null,views:number,burnAfterRead:boolean}>}
   */
  function create(content, opts = {}) {
    const body = { content };
    if (opts.title !== undefined) body.title = opts.title;
    if (opts.language !== undefined) body.language = opts.language;
    if (opts.expiresIn !== undefined) body.expiresIn = opts.expiresIn;
    if (opts.burnAfterRead !== undefined) body.burnAfterRead = opts.burnAfterRead;
    return request("POST", "/api/pastes", { body });
  }

  /**
   * Create and return just the shareable URL.
   * @param {string} content
   * @param {object} [opts] Same as `create`.
   * @returns {Promise<string>}
   */
  async function createUrl(content, opts = {}) {
    return (await create(content, opts)).url;
  }

  /**
   * Fetch a paste (summary + content).
   * @param {string} id
   * @param {{ withMetadata?: boolean }} [opts]  `withMetadata: true` returns `{ content, rawUrl, paste }`.
   */
  async function get(id, opts = {}) {
    const { text, response } = await request("GET", `/raw/${id}`, { raw: true, retry: retries });
    if (!opts.withMetadata) return text;
    return { content: text, rawUrl: `${baseUrl}/raw/${id}`, response };
  }

  /** Fetch a paste including all metadata (no view increment). */
  function getMeta(id) {
    return request("GET", `/api/pastes/${encodeURIComponent(id)}`);
  }

  /**
   * Delete a paste. Requires the `deleteToken` returned on creation.
   * @returns {Promise<boolean>}
   */
  async function remove(id, deleteToken) {
    const token = deleteToken || options.token;
    if (!token) {
      throw new CopasError("A delete token is required.", { code: "missing_token" });
    }
    const result = await request("DELETE", `/api/pastes/${encodeURIComponent(id)}`, {
      headers: { "X-Delete-Token": token },
    });
    return result?.deleted === true;
  }

  /** Recent pastes (metadata only, newest first). @param {number} [limit] 1–100 */
  async function recent(limit = 20) {
    const result = await request("GET", "/api/pastes", { query: { limit } });
    return result?.pastes ?? [];
  }

  /** Health check. */
  function health() {
    return request("GET", "/api/health");
  }

  /**
   * Download URL for a paste's content as a `.txt` file.
   * @param {string} id
   */
  function downloadUrl(id) {
    return `${baseUrl}/raw/${encodeURIComponent(id)}?download=1`;
  }

  return {
    baseUrl,
    create,
    createUrl,
    get,
    getMeta,
    remove,
    delete: remove,
    recent,
    health,
    downloadUrl,
  };
}

export default createClient;
