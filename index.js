import { createApp } from "./src/app.js";
import { config } from "./src/config.js";

async function main() {
  const { app, store } = await createApp();
  const cfg = app.locals.config;
  const server = app.listen(cfg.port, cfg.host, () => {
    const host = cfg.host === "0.0.0.0" || cfg.host === "::" ? "localhost" : cfg.host;
    console.log(
      `🚀 Simple Copas v${cfg.version} listening on http://${host}:${cfg.port} ` +
        `(${cfg.nodeEnv}, ${store.size()} paste(s), data: ${cfg.pastesFile})`,
    );
  });
  server.on("error", (err) => {
    console.error(`Failed to listen on ${cfg.host}:${cfg.port}:`, err.message);
    process.exit(1);
  });

  // A crash in an async handler must not take the paste store down silently
  // mid-write. log it, and let the supervisor restart us.
  process.on("unhandledRejection", (err) => {
    console.error("Unhandled rejection:", err);
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down…`);
    app.locals.stop();
    setTimeout(() => process.exit(0), cfg.nodeEnv === "production" ? 10000 : 5000).unref();
    server.close(() => {
      // Persist any counters that only live in memory.
      Promise.race([
        store.compactNow(),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ])
        .catch((err) => console.error("Final compact failed:", err.message))
        .finally(() => process.exit(0));
    });
    server.closeIdleConnections?.();
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Failed to start Simple Copas:", err);
  process.exit(1);
});

export { config };
