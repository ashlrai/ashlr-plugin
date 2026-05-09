# Error Monitoring

## Overview

Error monitoring is handled by `server/src/lib/sentry.ts`. Sentry is optional — the integration is a no-op when `SENTRY_DSN` is unset (local dev, tests). All errors are always logged via pino structured logs regardless.

## Setup

### Environment variables

| Variable | Purpose |
|---|---|
| `SENTRY_DSN` | Sentry DSN — obtainable from Sentry project settings → Client Keys. When absent, the module is never imported. |
| `SENTRY_ORG` | Org slug for `sentry-cli` source-map upload in CI. |
| `SENTRY_PROJECT` | Project slug for source-map upload in CI. |
| `SENTRY_INTERNAL_TOKEN` | Auth token for `sentry-cli` in CI (GitHub Actions secret). |

### Initialization

`initSentry(release?)` is called once at the top of `server/src/index.ts` before any routes are mounted. It reads `SENTRY_DSN` and, if present, dynamically imports `@sentry/bun` to avoid any side-effects in DSN-less environments (tests, local dev).

```ts
initSentry(`ashlr-server@${pluginVersion}`);
```

The `release` tag is set to `ashlr-server@<version>` read from `plugin.json`. This enables source-map lookup in Sentry for each deployed version.

### Error handler

`sentryErrorHandler` is mounted as Hono's `onError` hook (last in the chain):

```ts
app.onError(sentryErrorHandler);
```

It captures the exception with request metadata (method, path, x-request-id, user_id) and always returns `{"error": "Internal server error"}` with status 500.

### Manual capture

Use `captureException(err, extras?)` from `server/src/lib/sentry.ts` for non-HTTP errors (cron jobs, background workers):

```ts
import { captureException } from "../lib/sentry.js";
captureException(err, { job: "weekly-digest", userId });
```

## PII Redaction

Events are scrubbed before send via `beforeSend`. The following keys are redacted in the full event payload:

- `text`, `systemPrompt` — LLM content
- `email`, `authorization`, `cookie`, `password` — credentials and identity

The redactor does a deep JSON walk so nested occurrences are caught. Log extras passed to `captureException` are also scoped — never include raw email addresses, full URLs with tokens, or unhashed session IDs in the `extras` argument.

**Policy**: never pass raw `email` strings in extras. Use `user_id` (opaque UUID) instead. Never include `authorization` header values or Stripe/GitHub secrets in error context.

## Accessing dashboards

- Project: `https://sentry.io/organizations/<SENTRY_ORG>/projects/<SENTRY_PROJECT>/`
- Issues: filter by `release:ashlr-server@<version>` to scope to a specific deploy.
- Recommended alert: notify on first occurrence of any new issue with `level:error`.

## Trace sampling

`tracesSampleRate` is set to `0.1` (10%). Increase for debugging high-traffic paths; decrease or set to `0` in cost-sensitive environments.

## Fallback: pino logs

When Sentry is not configured, all exceptions still surface in pino JSON logs. In production, pipe logs to your preferred log aggregator (Datadog, Logtail, CloudWatch). The structured fields on every error log include `requestId`, `method`, `path`, and `user_id`.
