# Operations Runbook — ashlr-server

This document covers monitoring, alerting, and incident response for the ashlr pro backend.

---

## What to Monitor

### Health Endpoints

| Endpoint | Purpose | Expected |
|----------|---------|---------|
| `GET /healthz` | Liveness — is the process alive? | 200 always |
| `GET /readyz` | Readiness — is SQLite reachable? | 200 in normal operation |

Configure your uptime monitor (e.g. Fly.io checks, Better Uptime, Checkly) to hit `/readyz` every 15–30 seconds with a 5-second timeout. Alert on 2+ consecutive failures.

### Prometheus Metrics

Scrape `GET /metrics` (Basic Auth or IP allowlist required). Key metrics to dashboard:

#### Request Traffic
```
# Total request rate
rate(ashlr_http_requests_total[5m])

# Error rate (5xx)
rate(ashlr_http_requests_total{status=~"5.."}[5m])

# p95 latency
histogram_quantile(0.95, rate(ashlr_http_request_duration_seconds_bucket[5m]))
```

#### Business Metrics
```
ashlr_users_total                    # total registered users
ashlr_subscriptions_active           # paying customers right now
ashlr_stats_uploads_total            # plugin upload volume
rate(ashlr_magic_links_sent_total[1h]) # sign-up velocity
rate(ashlr_llm_requests_total[5m])   # LLM usage by tier
```

#### LLM Token Spend
```
histogram_quantile(0.95, rate(ashlr_llm_request_tokens_bucket{type="input"}[5m]))
```

### Logs

All logs are structured JSON on stdout. Use your platform's log aggregator (Railway → `railway logs --service ashlr-plugin-api`, Datadog, Loki, etc.).

**Key log fields to alert on:**
- `level: "error"` — unexpected server errors
- `status: 502` — xAI Grok API failures
- `status: 429` on `/llm/summarize` at high rate — rate-limit flood

**PII note:** `authorization`, `cookie`, `email`, `text`, `systemPrompt` are always `[REDACTED]` in logs.

---

## Alert Thresholds (Recommended)

| Alert | Condition | Severity |
|-------|-----------|---------|
| DB down | `/readyz` returns non-200 for 2+ checks | Critical |
| High error rate | 5xx rate > 1% of requests over 5m | Warning |
| LLM unavailable | `/llm/summarize` returning 502 > 5 times / minute | Warning |
| Stripe webhook lag | No `billing/webhook` calls in 2h during business hours | Info |
| Rate-limit flood | `status=429` > 50/min on any single path | Warning |

---

## Runbooks

### DB Down (`/readyz` returning 503)

**Symptoms:** `/readyz` returns `{ "db": "error" }`. Authenticated routes returning 500.

**Likely causes:**
1. SQLite file on a volume that wasn't mounted (Fly.io machine restart without persistent volume).
2. Disk full on the volume.
3. WAL corruption from an unclean shutdown.

**Steps:**
1. `railway run --service ashlr-plugin-api -- bash -c 'df -h'` → check disk space on the volume backing the sqlite db.
2. Verify `ASHLR_DB_PATH` points to the mounted volume: `echo $ASHLR_DB_PATH`.
3. If the file exists, try `sqlite3 $ASHLR_DB_PATH "PRAGMA integrity_check;"`.
4. If corrupt: restore from the most recent backup. Backups should be scheduled via `fly volumes snapshots list`.
5. If disk full: delete old WAL files or scale up the volume.

### xAI Grok API Failure (502 on `/llm/summarize`)

**Symptoms:** LLM route returning 502. Sentry shows `Service temporarily unavailable` errors.

**Steps:**
1. Check [status.x.ai](https://status.x.ai) for an active incident.
2. Verify `XAI_API_KEY` is still valid: `railway variables --service ashlr-plugin-api --kv | grep XAI`.
3. If key rotated, update: `railway variables --service ashlr-plugin-api --set XAI_API_KEY=xai-...`.
4. Check if the error is transient — a retry after 60 seconds often resolves API blips.
5. If the xAI outage is prolonged, consider returning a user-friendly degraded-mode message and disabling the LLM route via a feature flag.

### Stripe Webhook Lag

**Symptoms:** Subscriptions not updating after payments. Billing status stale.

**Steps:**
1. In Stripe Dashboard → Developers → Webhooks → select the endpoint → view recent deliveries.
2. Look for failed deliveries (non-2xx responses from `/billing/webhook`).
3. If the server was down, Stripe retries automatically for up to 3 days — re-deliveries will self-heal.
4. If `STRIPE_WEBHOOK_SECRET` was rotated, update: `railway variables --service ashlr-plugin-api --set STRIPE_WEBHOOK_SECRET=whsec_...`.
5. For persistent failures, check Sentry for errors in the webhook handler and review the server logs around the timestamp of failed deliveries.

### Rate-Limit Flood

**Symptoms:** Spike in 429 responses. Possibly automated abuse of `/auth/send` or `/llm/summarize`.

**Steps:**
1. Check logs for the offending IP or user ID pattern:
   ```
   railway logs --service ashlr-plugin-api | grep '"status":429' | head -50
   ```
2. `/auth/send` is rate-limited per email (5/hour). A flood suggests credential stuffing — no immediate action needed if email enumeration is not exposed (it isn't — the endpoint always returns `{ sent: true }`).
3. `/llm/summarize` is rate-limited per API token (30/min). If a single user is flooding, you can revoke their token in the DB:
   ```sql
   DELETE FROM api_tokens WHERE user_id = '<uid>';
   ```
4. If a bot is probing unauthenticated endpoints, add their IP to a Fly.io firewall rule.

### Sentry Error Spike

**Symptoms:** Sentry alert for high error volume.

**Steps:**
1. Check the Sentry issue for the stack trace and `requestId`.
2. Correlate `requestId` to server logs for full context.
3. Check if the error is tied to a recent deploy: `fly releases`.
4. If a bad deploy: `fly deploy --image <previous-image>` to roll back.

---

## Deployment Checklist

Before deploying to production:

- [ ] `cd server && bun test` passes
- [ ] `cd site && bun run build` passes
- [ ] All required env vars set in Railway (see "Required environment variables" below)
- [ ] `XAI_API_KEY` is valid
- [ ] Stripe webhook endpoint is registered and `STRIPE_WEBHOOK_SECRET` matches
- [ ] `/readyz` returns 200 after deploy

---

## Required environment variables

The server reads these via `process.env`. Set them in the Railway dashboard
(Project > ashlr-plugin-api > Variables) or via `railway variables --service
ashlr-plugin-api --set KEY=value`.

### Core (required to boot)

| Variable | Purpose |
|----------|---------|
| `ASHLR_MASTER_KEY` | 32-byte base64 — encryption key for genome blob storage. Generate once: `openssl rand -base64 32`. **Rotating destroys access to all encrypted genomes.** |
| `NODE_ENV` | `production` |
| `FRONTEND_URL` | Magic-link redirect target. Default: `https://plugin.ashlr.ai` |

### Auth (GitHub OAuth)

| Variable | Purpose |
|----------|---------|
| `GITHUB_CLIENT_ID` | OAuth app client ID (GitHub > Settings > Developer settings > OAuth Apps) |
| `GITHUB_CLIENT_SECRET` | OAuth app client secret |
| `GITHUB_WEBHOOK_SECRET` | (Optional) Shared secret if you wire up a GitHub webhook |

### Email (magic-link sign-in)

| Variable | Purpose |
|----------|---------|
| `SENDGRID_API_KEY` | SendGrid API key, scope: "Sending access". Without it, magic-link tokens are printed to stderr (dev mode). |

### Billing (Stripe)

| Variable | Purpose |
|----------|---------|
| `STRIPE_SECRET_KEY` | `sk_live_...` for prod, `sk_test_...` for staging |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` from the webhook endpoint registered at `/billing/webhook` |

### LLM summarization

The hosted summarizer talks to xAI Grok (`grok-4-1-fast-reasoning`) via the
OpenAI-compatible endpoint at `https://api.x.ai/v1`. ~75% cheaper per
request than the prior Anthropic Haiku 4.5 path.

| Variable | Purpose |
|----------|---------|
| `XAI_API_KEY` | Powers `/llm/summarize`. Get one at https://console.x.ai/. Required for hosted summarization. |

### URLs (used in email templates, redirects, marketing copy)

| Variable | Default | Purpose |
|----------|---------|---------|
| `SITE_URL` | `https://ashlr.ai` | Main marketing site |
| `BASE_URL` | `https://api.ashlr.ai` | This API server's base |
| `API_BASE_URL` | mirror of `BASE_URL` | Alias used in some email links |
| `PLUGIN_BASE_URL` | `https://plugin.ashlr.ai` | Plugin landing page |
| `DOCS_BASE_URL` | `https://plugin.ashlr.ai/docs` | Docs link in emails |
| `STATUS_BASE_URL` | `https://status.ashlr.ai` | Status page link |

### Observability (optional but recommended)

| Variable | Purpose |
|----------|---------|
| `SENTRY_DSN` | Error tracking |
| `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_INTERNAL_TOKEN` | Source-map upload during build |
| `LOG_LEVEL` | `info` (default) / `debug` / `warn` |

### Admin metrics endpoint (optional)

| Variable | Purpose |
|----------|---------|
| `METRICS_USER`, `METRICS_PASS` | Basic-auth on `/metrics` |
| `METRICS_ALLOWED_IPS` | Comma-separated allowlist |

### Auto-provided by Railway (don't set)

- `PORT` — Railway injects this. The server respects it via `process.env.PORT`.

### Behavior toggles (rare)

| Variable | Purpose |
|----------|---------|
| `ASHLR_DB_PATH` | Override default sqlite path. Leave unset in prod. |
| `ASHLR_DISABLE_TRIAL` | `1` to disable the 7-day Pro trial |
| `LLM_COST_CAP_USD` | Per-user monthly cost cap on `/llm/summarize`. Default: `5`. |

---

## Useful Commands

```bash
# Tail live logs
railway logs --service ashlr-plugin-api

# Open a shell in the running container (Railway "Run" tab or CLI)
railway run --service ashlr-plugin-api -- bash

# List variables (names only, not values)
railway variables --service ashlr-plugin-api --kv

# View recent deploys
railway status --service ashlr-plugin-api

# Adjust resources (CPU / memory) via the dashboard:
#   Project > ashlr-plugin-api > Settings > Resources

# Prometheus scrape (local test)
curl -u prometheus:secret https://api.ashlr.ai/metrics
```
