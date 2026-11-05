import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { createClient, CopasError } from "../src/client.js";

let server;
let dataDir;
let app;
let copas;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "copas-client-"));
  const created = await createApp({
    dataDir,
    port: 0,
    legacyPastesDir: null,
    cleanupIntervalMs: 0,
    maxPastesPerHour: 1000,
  });
  app = created.app;
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  copas = createClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
});

after(async () => {
  app.locals.stop();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("create returns url, rawUrl and deleteToken", async () => {
  const paste = await copas.create("hello", { title: "T", language: "text" });
  assert.match(paste.id, /^[A-Za-z0-9_-]{6}$/);
  assert.equal(paste.url, `${copas.baseUrl}/${paste.id}`);
  assert.equal(paste.rawUrl, `${copas.baseUrl}/raw/${paste.id}`);
  assert.ok(paste.deleteToken);
});

test("createUrl returns only the shareable url", async () => {
  const url = await copas.createUrl("link me", { expiresIn: "1h" });
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{6}$/);
});

test("get returns raw content; getMeta returns metadata", async () => {
  const { id } = await copas.create("body text");
  assert.equal(await copas.get(id), "body text");
  const meta = await copas.getMeta(id);
  assert.equal(meta.id, id);
  assert.equal(meta.content, "body text");
});

test("remove deletes with the token; wrong token raises CopasError", async () => {
  const { id, deleteToken } = await copas.create("bye");

  await assert.rejects(
    copas.remove(id, "wrong-token"),
    (err) => err instanceof CopasError && err.status === 403 && err.code === "invalid_token",
  );

  assert.equal(await copas.remove(id, deleteToken), true);
  await assert.rejects(
    copas.get(id),
    (err) => err instanceof CopasError && err.status === 404 && err.code === "not_found",
  );
});

test("remove without a token throws before calling the server", async () => {
  await assert.rejects(
    copas.remove("abcdef"),
    (err) => err instanceof CopasError && err.code === "missing_token",
  );
});

test("create rejects empty content with the API error code", async () => {
  await assert.rejects(
    copas.create("   "),
    (err) => err instanceof CopasError && err.status === 400 && err.code === "empty_content",
  );
});

test("recent lists metadata and downloadUrl points at the txt download", async () => {
  const { id } = await copas.create("listed");
  const list = await copas.recent(5);
  assert.ok(list.some((p) => p.id === id));
  assert.equal(list.find((p) => p.id === id).content, undefined);
  assert.equal(copas.downloadUrl(id), `${copas.baseUrl}/raw/${id}?download=1`);
  assert.equal((await copas.health()).status, "ok");
});
