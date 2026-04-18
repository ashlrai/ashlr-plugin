/**
 * index.ts — ashlr pro backend, Phase 1 + Phase 2.
 *
 * Services:
 *   - Hosted badge:    GET  /u/:userId/badge.svg
 *   - Stats sync:      POST /stats/sync
 *   - Stats agg:       GET  /stats/aggregate
 *   - LLM summarize:   POST /llm/summarize   (Phase 2)
 *   - Health:          GET  /
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import badgeRouter from "./routes/badge.js";
import statsRouter from "./routes/stats.js";
import llmRouter   from "./routes/llm.js";

const app = new Hono();

// CORS: permissive for Phase 1; lock down post-auth in Phase 2.
app.use(
  "/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

// Health check
app.get("/", (c) => c.json({ ok: true, service: "ashlr-server", phase: 1 }));

// Mount routers
app.route("/", badgeRouter);
app.route("/", statsRouter);
app.route("/", llmRouter);

// 404 fallback
app.notFound((c) => c.json({ error: "Not found" }, 404));

const PORT = Number(process.env["PORT"] ?? 3001);

export default app;

if (import.meta.main) {
  Bun.serve({ fetch: app.fetch, port: PORT });
  console.log(`ashlr-server listening on http://localhost:${PORT}`);
}
