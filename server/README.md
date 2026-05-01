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

```bash
cd server
cp .env.example .env   # fill in real values
bun install
```

## Development

```bash
bun run dev          # watch mode, port 3001
bun run start        # production
bun run typecheck    # type-check only
bun test             # run test suite
```

## Provisioning users

```bash
bun run issue-token mason@example.com
# Prints:
#   Token: <hex-token>
#   export ASHLR_PRO_TOKEN="<hex-token>"
```

## Endpoints

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

See `.env.example` for the full list with descriptions. Key variables:

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `PORT` | `3001` | no | HTTP port |
| `ASHLR_DB_PATH` | `./ashlr.db` | no | SQLite file path |
| `FRONTEND_URL` | `https://plugin.ashlr.ai` | no | Base URL for magic links |
| `SENDGRID_API_KEY` | — | prod | Email sending via SendGrid |
| `STRIPE_SECRET_KEY` | — | prod | Stripe API key |
| `STRIPE_WEBHOOK_SECRET` | — | prod | Stripe webhook verification |
| `ANTHROPIC_API_KEY` | — | prod | Claude API access |
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

`GET /metrics` returns Prometheus text format. Secure with `METRICS_ALLOWED_IPS` or `METRICS_USER`/`METRICS_PASS`. See `docs/operations.md` for the full metric catalog.

## Deploy

**Railway**: `railway init --name ashlr-plugin-api && railway link` from the `server/` directory. The build is driven by the local `Dockerfile` + `railway.json` (healthcheck on `/readyz`). Attach a Railway volume and set `ASHLR_DB_PATH=/data/ashlr.db` if you want the sqlite db to persist across deploys.

```bash
railway variables --service ashlr-plugin-api \
  --set SENTRY_DSN=https://... \
  --set SENDGRID_API_KEY=SG... \
  --set ANTHROPIC_API_KEY=sk-ant-...
```

See `docs/deploy.md` for the full setup and `docs/operations.md` for the
full required environment-variable list.
