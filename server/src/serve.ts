/**
 * serve.ts — thin entrypoint for integration tests and production use.
 *
 * Imports the Hono app from index.ts WITHOUT triggering Bun v1.3's auto-serve
 * behaviour (which fires when `bun run` detects `export default <fetch-app>`
 * and causes EADDRINUSE when import.meta.main also calls Bun.serve()).
 *
 * Usage: bun run server/src/serve.ts
 * Integration tests: startBackend({ serverFile: join(SERVER_ROOT, "src/serve.ts") })
 */

// Dynamic import prevents Bun from seeing a top-level `export default` with
// .fetch at parse time, so isServerConfig returns false for THIS file.
const { default: app, startHealthCheckWorker } = await import("./index.ts");

const PORT = Number(process.env["PORT"] ?? 3001);

// Import logger after index.ts so it shares the same singleton.
const { logger } = await import("./lib/logger.ts");

Bun.serve({ fetch: (app as { fetch: (r: Request) => Response | Promise<Response> }).fetch, port: PORT });
logger.info({ port: PORT, version: "unknown" }, "ashlr-server started");

if (typeof startHealthCheckWorker === "function") {
  startHealthCheckWorker();
}
