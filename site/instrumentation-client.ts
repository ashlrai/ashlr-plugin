/**
 * instrumentation-client.ts — Sentry browser-side init (Next 15 / Turbopack).
 *
 * Replaces the legacy `sentry.client.config.ts`. Under Turbopack, the old file
 * was pulled into the *server* bundle and evaluated during SSR, where the
 * browser SDK touches `localStorage` — which doesn't exist server-side, so it
 * threw `localStorage.getItem is not a function` and 500'd every page in
 * `next dev`. Next loads `instrumentation-client.ts` in the browser ONLY, which
 * is the supported fix.
 *
 * Only active when NEXT_PUBLIC_SENTRY_DSN is set. PII (email, tokens, cookie
 * values) is scrubbed before sending.
 */

import * as Sentry from "@sentry/nextjs";

const dsn = process.env["NEXT_PUBLIC_SENTRY_DSN"];

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,

    // Only instrument authenticated app pages; skip marketing routes.
    tracePropagationTargets: [/\/dashboard/, /\/signin/, /\/billing/],

    beforeSend(event) {
      return scrubEvent(event);
    },

    beforeBreadcrumb(breadcrumb) {
      return scrubBreadcrumb(breadcrumb);
    },
  });
}

// Instrument client-side navigations (Sentry's documented hook for the App Router).
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

// ---------------------------------------------------------------------------
// PII scrubbers
// ---------------------------------------------------------------------------

const PII_KEYS = new Set(["email", "authorization", "token", "cookie", "password", "text", "systemPrompt"]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scrubEvent(event: any): any {
  return JSON.parse(
    JSON.stringify(event, (key, value) => {
      if (PII_KEYS.has(key) && typeof value === "string") return "[REDACTED]";
      return value;
    }),
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scrubBreadcrumb(breadcrumb: any): any {
  if (breadcrumb?.data) {
    for (const key of Object.keys(breadcrumb.data)) {
      if (PII_KEYS.has(key)) breadcrumb.data[key] = "[REDACTED]";
    }
  }
  return breadcrumb;
}
