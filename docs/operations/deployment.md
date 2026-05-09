# Deployment Guide

## Environment Variables

### Required for boot — server will not start without these

| Variable | What it does | Default when unset | How to get |
|---|---|---|---|
| `DATABASE_URL` | *(reserved — SQLite path uses `ASHLR_DB_PATH`)* | — | n/a |
| `ASHLR_DB_PATH` | Absolute path to the SQLite `.db` file | `server/ashlr.db` (sibling of `src/`) | Set to a persistent volume path in production (e.g. `/data/ashlr.db`) |
| `ASHLR_MASTER_KEY` | AES-256-GCM master key for encrypting secrets at rest (GitHub OAuth tokens, genome DEKs). Must decode to exactly 32 bytes base64. | Throws in production. Dev: set `ASHLR_MASTER_KEY_DEV=1` for an ephemeral key. | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |

### Required for features — server starts but feature degrades without these

| Variable | What it does | Default when unset |
|---|---|---|
| `SENDGRID_API_KEY` | Sends transactional email (magic-link auth, weekly digest, status alerts). | Email is silently skipped; log line emitted. |
| `STRIPE_SECRET_KEY` | Stripe API client for checkout sessions, portal, subscription management. | `getStripeClient()` throws; billing routes 500. |
| `STRIPE_WEBHOOK_SECRET` | Verifies Stripe webhook HMAC signatures (`/webhooks/stripe`). | Webhook handler returns 400 on every event. |
| `GITHUB_CLIENT_ID` | GitHub OAuth app client ID for `/auth/github/start` and scope-upgrade flow. | GitHub OAuth endpoints return 500. |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret. | Same as above. |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for validating GitHub push webhooks (`/webhooks/github`). | Webhook rejected with 400. |
| `SENTRY_DSN` | Sentry error-reporting DSN. | No-op; errors are still logged via pino. |

### Optional / overrides — have safe defaults

| Variable | What it does | Default |
|---|---|---|
| `PORT` | HTTP listen port. | `3001` |
| `NODE_ENV` | Controls pino pretty-print (`development`) vs JSON (`production`). | `development` |
| `LOG_LEVEL` | pino log level (`trace`, `debug`, `info`, `warn`, `error`). | `debug` in dev, `info` in production. |
| `BASE_URL` | Public API base URL, used in OAuth redirect URIs and Stripe callback URLs. | `https://api.ashlr.ai` |
| `SITE_URL` | Public site URL for Stripe cancel/return redirects. | `https://plugin.ashlr.ai` |
| `FRONTEND_URL` | Frontend app URL for GitHub OAuth callback redirects. | `https://plugin.ashlr.ai` |
| `ASHLR_SITE_URL` | Used by the weekly-digest cron for unsubscribe link base. | `https://plugin.ashlr.ai` |
| `STATUS_BASE_URL` | Base URL for status page links. | `https://status.ashlr.ai` |
| `API_BASE_URL` | API base for health-check worker synthetic probes. | `https://api.ashlr.ai` |
| `PLUGIN_BASE_URL` | Plugin CDN base for health-check worker probes. | `https://plugin.ashlr.ai` |
| `DOCS_BASE_URL` | Docs base for health-check worker probes. | `https://docs.ashlr.ai` |
| `ASHLR_DISABLE_TRIAL` | Set to `"1"` to disable free-trial eligibility on new Pro checkouts. | Trial enabled. |
| `ASHLR_MASTER_KEY_DEV` | Set to `"1"` to use an ephemeral (non-persistent) master key. Dev/test only. | Off. |
| `METRICS_USER` | HTTP Basic auth username for the `/metrics` endpoint. | Endpoint open to all IPs. |
| `METRICS_PASS` | HTTP Basic auth password for the `/metrics` endpoint. | — |
| `METRICS_ALLOWED_IPS` | Comma-separated IPs allowed to scrape `/metrics`. | All IPs allowed. |
| `SENTRY_ORG` | Sentry org slug for source-map upload in CI. | — |
| `SENTRY_PROJECT` | Sentry project slug for source-map upload in CI. | — |
| `SENTRY_INTERNAL_TOKEN` | Sentry auth token for source-map upload CLI in CI. | — |
| `TESTING` | Set to `"1"` by the test harness. Enables Stripe stub client and skips real email sends. | Off. |

---

## Deployment Checklist

### Secrets

- [ ] `ASHLR_MASTER_KEY` set to a fresh 32-byte base64 secret — **NOT the dev default**
- [ ] `SENDGRID_API_KEY` set (required for magic-link login and weekly digest)
- [ ] `STRIPE_SECRET_KEY` set (live key for production, test key for staging)
- [ ] `STRIPE_WEBHOOK_SECRET` set and Stripe webhook configured to POST to `https://<host>/webhooks/stripe`
- [ ] `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` set (GitHub OAuth App, callback URL: `https://<host>/auth/github/callback`)
- [ ] `GITHUB_WEBHOOK_SECRET` set and GitHub webhook configured on any repos using genome auto-build

### Infrastructure

- [ ] `ASHLR_DB_PATH` points to a persistent volume (not ephemeral container storage)
- [ ] Persistent volume backed up (SQLite WAL — snapshot the `.db` file and `-wal`/`-shm` when idle, or use Litestream)
- [ ] `PORT` set (or load balancer configured for default `3001`)
- [ ] `NODE_ENV=production` — enables JSON logging

### Observability

- [ ] `SENTRY_DSN` set — error tracking active (see `docs/operations/error-monitoring.md`)
- [ ] `LOG_LEVEL` set (recommend `info` for production)
- [ ] Metrics scraper configured — set `METRICS_USER`/`METRICS_PASS` or `METRICS_ALLOWED_IPS`, point Prometheus at `/metrics`
- [ ] `/healthz` returns `200` from the deployed instance
- [ ] `/readyz` returns `200` (confirms SQLite is reachable)

### CI / Cron

- [ ] `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_INTERNAL_TOKEN` added to GitHub Actions secrets (for source-map upload)
- [ ] Weekly-digest cron scheduled (GitHub Actions or Render Cron: `0 14 * * 0` → `bun server/src/jobs/weekly-digest-cron.ts`)
- [ ] Cron environment variables include `ASHLR_DB_PATH`, `ASHLR_MASTER_KEY`, `SENDGRID_API_KEY`, `ASHLR_SITE_URL`

### DNS / TLS

- [ ] TLS termination in place (reverse proxy or platform-managed)
- [ ] CORS origin list reviewed (`BASE_URL`, `FRONTEND_URL`)

---

## Running Migrations

Migrations run automatically on every server boot via `getDb()` in `server/src/db/connection.ts`. They are fully idempotent — safe to re-run on a running DB.

For CI pipelines, pre-deploy verification, or dry-run checks before a production deploy, use the migration CLI:

```sh
# Check what migrations are pending without applying them (exits 1 if any pending)
bun server/src/db/migrate.ts --check

# Apply all pending migrations (safe to run multiple times)
bun server/src/db/migrate.ts

# Target a specific DB file
bun server/src/db/migrate.ts --db /data/ashlr.db
```

The CLI reports each migration step and exits `0` when up-to-date, `1` if `--check` found pending migrations.
