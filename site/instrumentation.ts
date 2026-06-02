/**
 * instrumentation.ts — Sentry server/edge init for Next 15.
 *
 * Next calls register() once per server runtime. We load the server Sentry
 * config there (the supported replacement for a top-level sentry.server.config
 * import) and export onRequestError so server-side render/route errors are
 * captured.
 */

import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" || process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.server.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
