#!/usr/bin/env node
// Create a paste via the HTTP API and print its URLs.
//
// Usage:
//   node examples/create-paste.mjs "isi paste"
//   echo "isi dari stdin" | node examples/create-paste.mjs --title "catatan"
//   node examples/create-paste.mjs --file src/routes.js --language js --expires 7d
//
// Env:
//   COPAS_URL   base URL of the server (default: http://localhost:${PORT:-6000})
//
// Exit codes: 0 success, 1 request/validation error.

import { readFile } from "node:fs/promises";
import { STDIN_FILENO, stdout } from "node:process";

const USAGE = `Usage: node examples/create-paste.mjs [options] [content]

Options:
  --title <text>        Paste title
  --language <lang>     Syntax hint (e.g. js, python); omit for plain text
  --expires <value>     Expiry, e.g. 10m, 1h, 7d, never
  --burn                Delete after the first read
  --file <path>         Read content from a file instead of arg/stdin
  -h, --help            Show this help
`;

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { content: null };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) fail(`Missing value for ${arg}`, 2);
      return value;
    };
    switch (arg) {
      case "-h":
      case "--help":
        stdout.write(USAGE);
        process.exit(0);
      case "--title":
        opts.title = next();
        break;
      case "--language":
        opts.language = next();
        break;
      case "--expires":
        opts.expiresIn = next();
        break;
      case "--file":
        opts.file = next();
        break;
      case "--burn":
        opts.burnAfterRead = true;
        break;
      default:
        if (arg.startsWith("-")) fail(`Unknown option: ${arg}\n\n${USAGE}`, 2);
        positional.push(arg);
    }
  }

  if (positional.length) opts.content = positional.join(" ");
  return opts;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  let content = opts.content ?? "";
  if (opts.file) content = await readFile(opts.file, "utf8");
  else if (!content) content = await readStdin();

  content = content.replace(/\r\n?/g, "\n");
  if (content.trim() === "") fail("Paste content is empty. Pass it as an argument, via --file, or on stdin.");

  const base = (process.env.COPAS_URL || `http://localhost:${process.env.PORT || 6000}`).replace(/\/+$/, "");

  const body = { content };
  if (opts.title !== undefined) body.title = opts.title;
  if (opts.language !== undefined) body.language = opts.language;
  if (opts.expiresIn !== undefined) body.expiresIn = opts.expiresIn;
  if (opts.burnAfterRead) body.burnAfterRead = true;

  let res;
  try {
    res = await fetch(`${base}/api/pastes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    fail(`Could not reach ${base}: ${err.message}`);
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    fail(`HTTP ${res.status}: unexpected non-JSON response:\n${text.slice(0, 500)}`);
  }

  if (!res.ok) {
    fail(`HTTP ${res.status} ${data.error ?? ""}: ${data.message ?? text}`);
  }

  stdout.write(
    [
      `URL:          ${data.url}`,
      `Raw URL:      ${data.rawUrl}`,
      `Delete token: ${data.deleteToken}`,
      `Expires:      ${data.expiresAt ? new Date(data.expiresAt).toISOString() : "never"}`,
      "",
    ].join("\n"),
  );
}

main().catch((err) => fail(`Unexpected error: ${err.message}`));
