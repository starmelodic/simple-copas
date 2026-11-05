import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";

let server;
let base;
let store;
let dataDir;
let app;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "copas-test-"));
  const created = await createApp({
    dataDir,
    port: 0,
    legacyPastesDir: null,
    cleanupIntervalMs: 0,
    maxPastesPerHour: 1000,
    maxContentBytes: 200 * 1024,
  });
  app = created.app;
  store = created.store;
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  app.locals.stop();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function postPaste(body, headers = {}) {
  return fetch(`${base}/api/pastes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("creates a paste and serves it via the API and raw endpoint", async () => {
  const res = await postPaste({ content: "hello world", title: "Greeting" });
  assert.equal(res.status, 201);
  const paste = await res.json();
  assert.match(paste.id, /^[A-Za-z0-9_-]{6}$/);
  assert.equal(paste.title, "Greeting");
  assert.equal(paste.content, "hello world");
  assert.ok(paste.deleteToken);
  assert.ok(paste.url.endsWith(`/${paste.id}`));

  const fetched = await (await fetch(`${base}/api/pastes/${paste.id}`)).json();
  assert.equal(fetched.content, "hello world");

  const raw = await fetch(`${base}/raw/${paste.id}`);
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await raw.text(), "hello world");
});

test("rejects empty content", async () => {
  const res = await postPaste({ content: "   " });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "empty_content");
});

test("enforces the content size limit", async () => {
  const res = await postPaste({ content: "x".repeat(200 * 1024 + 1) });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, "content_too_large");
});

test("rejects invalid expiry values and accepts valid ones", async () => {
  const bad = await postPaste({ content: "x", expiresIn: "soon" });
  assert.equal(bad.status, 400);

  const ok = await postPaste({ content: "x", expiresIn: "1h" });
  assert.equal(ok.status, 201);
  const paste = await ok.json();
  const delta = paste.expiresAt - Date.now();
  assert.ok(delta > 3500_000 && delta <= 3600_000);
});

test("expired pastes are invisible", async () => {
  const { doc } = await store.create({ content: "gone", expiresAt: Date.now() - 1000 });
  const res = await fetch(`${base}/api/pastes/${doc.id}`);
  assert.equal(res.status, 404);
  const raw = await fetch(`${base}/raw/${doc.id}`);
  assert.equal(raw.status, 404);
  assert.equal(await store.pruneExpired(), 1);
});

test("delete requires the correct token", async () => {
  const paste = await (await postPaste({ content: "delete me" })).json();

  const denied = await fetch(`${base}/api/pastes/${paste.id}`, {
    method: "DELETE",
    headers: { "X-Delete-Token": "wrong" },
  });
  assert.equal(denied.status, 403);

  const ok = await fetch(`${base}/api/pastes/${paste.id}`, {
    method: "DELETE",
    headers: { "X-Delete-Token": paste.deleteToken },
  });
  assert.equal(ok.status, 200);
  assert.equal((await fetch(`${base}/api/pastes/${paste.id}`)).status, 404);
});

test("burn-after-read pastes disappear after the raw read", async () => {
  const paste = await (await postPaste({ content: "secret", burnAfterRead: true })).json();
  const first = await fetch(`${base}/raw/${paste.id}`);
  assert.equal(await first.text(), "secret");
  const second = await fetch(`${base}/raw/${paste.id}`);
  assert.equal(second.status, 404);
});

test("rejects path traversal and malformed ids", async () => {
  for (const bad of ["..%2F..%2Fetc%2Fpasswd", "a.b", "__proto__"]) {
    const res = await fetch(`${base}/raw/${bad}`);
    assert.ok(res.status === 404, `${bad} should 404, got ${res.status}`);
  }
  const api = await fetch(`${base}/api/pastes/..%2F..%2Fetc`);
  assert.equal(api.status, 404);
});

test("escapes stored content when rendered as HTML (form post)", async () => {
  const body = new URLSearchParams({ content: `<script>alert(1)</script>` });
  const res = await fetch(`${base}/api/pastes`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
    body,
  });
  assert.equal(res.status, 201);
  const html = await res.text();
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("legacy form POST renders an HTML success page", async () => {
  const res = await fetch(`${base}/api/pastes`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ content: "legacy" }),
  });
  assert.equal(res.status, 201);
  assert.match(res.headers.get("content-type"), /text\/html/);
});

test("persists pastes across a restart", async () => {
  const paste = await (await postPaste({ content: "durable" })).json();
  const reopened = await createApp({
    dataDir,
    port: 0,
    legacyPastesDir: null,
    cleanupIntervalMs: 0,
    maxPastesPerHour: 1000,
  });
  try {
    assert.equal(reopened.store.get(paste.id).content, "durable");
  } finally {
    reopened.app.locals.stop();
  }
});

test("health and recent listings do not leak content or tokens", async () => {
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.status, "ok");

  const { pastes } = await (await fetch(`${base}/api/pastes?limit=5`)).json();
  assert.ok(Array.isArray(pastes));
  for (const p of pastes) {
    assert.equal(p.content, undefined);
    assert.equal(p.deleteToken, undefined);
    assert.equal(p.deleteTokenHash, undefined);
  }
});

test("serves the SPA shell for / and existing short URLs, 404 page otherwise", async () => {
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Simple Copas/);

  const paste = await (await postPaste({ content: "spa" })).json();
  const shortUrl = await fetch(`${base}/${paste.id}`);
  assert.equal(shortUrl.status, 200);

  const missing = await fetch(`${base}/doesnotexist`);
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /Paste not found/);
});

test("sets security headers and unknown API routes return JSON 404", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.ok(res.headers.get("content-security-policy"));
  assert.equal(res.headers.get("x-powered-by"), null);

  const api = await fetch(`${base}/api/nope`);
  assert.equal(api.status, 404);
  assert.match(api.headers.get("content-type"), /application\/json/);
});

test("rate limiter kicks in after the configured number of creates", async () => {
  const limited = await createApp({
    dataDir: await fs.mkdtemp(path.join(os.tmpdir(), "copas-rate-")),
    port: 0,
    legacyPastesDir: null,
    cleanupIntervalMs: 0,
    maxPastesPerHour: 2,
  });
  const srv = await new Promise((resolve) =>
    resolve(limited.app.listen(0, "127.0.0.1")),
  );
  const url = `http://127.0.0.1:${srv.address().port}/api/pastes`;
  try {
    const send = () =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "x" }),
      });
    assert.equal((await send()).status, 201);
    assert.equal((await send()).status, 201);
    const third = await send();
    assert.equal(third.status, 429);
    assert.ok(third.headers.get("retry-after"));
  } finally {
    limited.app.locals.stop();
    await new Promise((r) => srv.close(r));
  }
});
