import { createApp } from "./src/app.js";
import { config } from "./src/config.js";

async function main() {
  const { app, store, config: cfg } = await createApp();
  const server = app.listen(cfg.port, cfg.host, () => {
    const host = cfg.host === "0.0.0.0" ? "localhost" : cfg.host;
    console.log(`
╔══════════════════════════════════════════════════════════╗
║  🚀 Simple Copas v${cfg.version} is running${" ".repeat(Math.max(0, 24 - cfg.version.length))}║
╠══════════════════════════════════════════════════════════╣
║  📍 Local:   http://${host}:${cfg.port}
║  🗄️  Storage: ${cfg.pastesFile}
║  📝 Pastes:  ${store.size()} stored
╚══════════════════════════════════════════════════════════╝
`);
  });

  async function shutdown(signal) {
    console.log(`\n${signal} received, shutting down…`);
    server.close(() => process.exit(0));
    app.locals.stop?.();
    setTimeout(() => process.exit(0), 5000).unref();
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Failed to start Simple Copas:", err);
  process.exit(1);
});

export { config };
