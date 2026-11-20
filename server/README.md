# ashlr-server

Pro-tier backend for the ashlr plugin. Handles authentication, hosted badge generation, cross-device stats sync, LLM summarization, and Stripe billing.

## Stack

- Bun runtime
- Hono (HTTP framework)
- SQLite via `bun:sqlite` (single abstracted DB layer)
- Zod (request validation)
- Pino (structured logging)
- prom-client (Prometheus metrics)
- @sentry/bun (error tracking, opt-in)

## Setup

The server has its own dependencies, separate from the plugin at the repository root.

```bash
cd server
bun install
```

There is no `.env.example`. Bun loads `server/.env` automatically if you create one. For local development, one variable is enough:

```bash
ASHLR_MASTER_KEY_DEV=1   # ephemeral encryption key; encrypted data does not survive a restart
```

Without `ASHLR_MASTER_KEY` or `ASHLR_MASTER_KEY_DEV=1`, the first encrypt or decrypt call fails. Without `SENDGRID_API_KEY`, emails (including magic links) are written to stderr instead of sent. The SQLite database defaults to `./ashlr.db`.

## Development

```bash
bun run dev            # watch mode, port 3001 (PORT overrides)
bun run start          # run once, no watch
bun run typecheck      # type-check only
bun test               # test suite in tests/
bun run check          # typecheck + tests; what `bun run check` at the root runs here
bun run email:preview  # render the email templates at http://localhost:3333
```

Contributing a change here follows the same path as the rest of the repo: see [From branch to main](../CONTRIBUTING.md#from-branch-to-main). Some files here, such as `src/lib/auth.ts`, request a code owner review automatically ([`.github/CODEOWNERS`](../.github/CODEOWNERS)).

## Provisioning users

```bash
bun run issue-token user@example.com
# Prints the user id, email and token, then:
#   export ASHLR_PRO_TOKEN="<hex-token>"
```

`bun run cap-check` prints a user's LLM summarizer usage for today. It reads the API token from stdin so the token stays out of shell history.

## Endpoints

The core routes are below. Every route is defined under `src/routes/` and mounted in `src/index.ts`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | none | Legacy health check (backwards compat) |
| GET | `/healthz` | none | Liveness — always 200 if process is alive |
| GET | `/readyz` | none | Readiness — 200 only if SQLite is reachable |
| GET | `/metrics` | IP/Basic Auth | Prometheus metrics |
| GET | `/u/:userId/badge.svg` | none | SVG badge |
| POST | `/stats/sync` | token in body | Upload stats payload |
| GET | `/stats/aggregate` | Bearer token | Aggregated view across machines |
| POST | `/auth/send` | none | Request magic-link email |
| POST | `/auth/verify` | none | Exchange magic token for API token |
| POST | `/llm/summarize` | Bearer token (pro+) | Cloud LLM summarization |
| POST | `/billing/checkout` | Bearer token | Create Stripe Checkout session |
| GET | `/billing/portal` | Bearer token | Create Stripe Customer Portal session |
| GET | `/billing/status` | Bearer token | Current subscription state |
| POST | `/billing/webhook` | Stripe-Signature | Stripe webhook handler |

## Environment Variables

Key variables are below. [docs/operations.md](../docs/operations.md#required-environment-variables) has the full list the server reads.

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `PORT` | `3001` | no | HTTP port |
| `ASHLR_DB_PATH` | `./ashlr.db` | no | SQLite file path |
| `FRONTEND_URL` | `https://plugin.ashlr.ai` | no | Base URL for magic links |
| `SENDGRID_API_KEY` | — | prod | Email sending via SendGrid |
| `STRIPE_SECRET_KEY` | — | prod | Stripe API key |
| `STRIPE_WEBHOOK_SECRET` | — | prod | Stripe webhook verification |
| `ASHLR_MASTER_KEY` | — | prod | 32-byte base64 key for encrypted storage (`ASHLR_MASTER_KEY_DEV=1` in dev) |
| `XAI_API_KEY` | — | prod | xAI key behind `/llm/summarize` |
| `SENTRY_DSN` | — | no | Sentry error tracking (opt-in) |
| `METRICS_ALLOWED_IPS` | — | no | Comma-separated IPs allowed to scrape `/metrics` |
| `METRICS_USER` | — | no | Basic Auth username for `/metrics` |
| `METRICS_PASS` | — | no | Basic Auth password for `/metrics` |
| `LOG_LEVEL` | `info` | no | Pino log level |
| `NODE_ENV` | `development` | no | `production` → JSON logs; `development` → pretty |

## Observability

### Logging

All request logs are structured JSON (pino). Every log line includes:
- `requestId` — UUID, echoed in `x-request-id` response header
- `method`, `path`, `status`, `latencyMs`
- `user_id` when authenticated

`authorization`, `cookie`, `email`, `text`, `systemPrompt` are always redacted.

Sample log line (production):
```json
{"level":30,"time":1713388800000,"requestId":"a1b2c3d4-...","method":"POST","path":"/llm/summarize","status":200,"latencyMs":312,"user_id":"usr_abc123"}
```

### Sentry

Set `SENTRY_DSN` to enable. Without it, Sentry is a complete no-op — no imports are evaluated, tests pass identically.

### Prometheus

`GET /metrics` returns Prometheus text format. Secure with `METRICS_ALLOWED_IPS` or `METRICS_USER`/`METRICS_PASS`. See [docs/operations.md](../docs/operations.md) for the full metric catalog.

## Deploy

**Railway**: `railway init --name ashlr-plugin-api && railway link` from the `server/` directory. The build is driven by the local `Dockerfile` + `railway.json` (healthcheck on `/readyz`). Attach a Railway volume and set `ASHLR_DB_PATH=/data/ashlr.db` if you want the sqlite db to persist across deploys.

```bash
railway variables --service ashlr-plugin-api \
  --set SENTRY_DSN=<dsn> \
  --set SENDGRID_API_KEY=<key> \
  --set XAI_API_KEY=<key>
```

Production deploys run from `.github/workflows/deploy-server.yml` when `server/**` changes on `main`. See [docs/deploy.md](../docs/deploy.md) for the full setup and [docs/operations.md](../docs/operations.md#required-environment-variables) for the
full required environment-variable list.
