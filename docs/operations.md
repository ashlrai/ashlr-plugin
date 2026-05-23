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

The hosted summarizer talks to xAI Grok (`grok-4.3`) via the
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
| `ASHLR_PREFETCH` | `off` disables the Predictive Prefetch MVP (Q3 supporting pillar — fire-and-forget background import-graph pre-cache). Free tier is a no-op anyway; Pro caps at 3 neighbours, Team at 10. Hard 1.5s wallclock cap on the background task. |

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


---

# v1.32 Northstar Surfaces — On-Call Cheat Sheet

> *Audience: founder + on-call. Goal: find the right env var, endpoint, log, or dashboard in <30s at 2am.*

## 1. Production topology

```
                +-------------------------------+
                |   GitHub  (registry source)   |
                |   branch: main                |
                +---------------+---------------+
                                |
        +-----------------------+-----------------------+
        |                       |                       |
        v                       v                       v
+----------------+    +------------------+    +-------------------+
| Plugin         |    | Site (site/)     |    | Server (server/)  |
| (Claude Code   |    | Vercel — auto    |    | Railway —         |
|  plugin via    |    | deploy on push   |    | deploy via GH     |
|  main registry)|    | to main          |    | Actions workflow  |
+----------------+    +------------------+    +---------+---------+
                                                        |
                                                        v
                                              +-------------------+
                                              | bun:sqlite        |
                                              | (Railway volume)  |
                                              | ASHLR_DB_PATH     |
                                              +-------------------+
```

- **Plugin:** distributed as a Claude Code plugin; the public registry resolves from `main`.
- **Site:** `site/` auto-deploys to Vercel on every push to `main` (deploy-site.yml).
- **Server:** `server/` deploys to Railway via `.github/workflows/deploy-server.yml` on push to `main`.
- **DB:** `bun:sqlite` inside the Railway container, file at `$ASHLR_DB_PATH` on a persistent volume.

---

## 2. Secrets cheat sheet

| Var | Lives in | Read by | Generate | Blast radius if missing/wrong |
|-----|----------|---------|----------|-------------------------------|
| `ASHLR_MASTER_KEY` | Railway env | `server/` — genome blob crypto | `openssl rand -base64 32` (one-time, never rotate) | All encrypted genomes unreadable; team-cloud genome puller returns garbage. |
| `ASHLR_ADMIN_TRIGGER_TOKEN` | Railway env + GH Actions secret | `server/` admin-write routes (`/admin/jobs/*`) + daily-wad-d-aggregate cron | `openssl rand -hex 32`; set on Railway and as GH secret with identical value | Daily WAD-D cron 503s; discovery-propagation aggregate never runs. |
| `ASHLR_ADMIN_READ_TOKEN` | Vercel env (site) + Railway env (server) | `site/` admin pages → server admin-read routes (`/admin/wad-d-snapshots`, `/admin/sessions`, `/admin/discoveries/propagation`) | `openssl rand -hex 32`; set on **both** Vercel and Railway with identical value | All founder dashboards 404/401. |
| `ASHLR_API_BASE_URL` | Vercel env (site) | `site/` server components → server | `https://api.ashlr.ai` | Site → server calls fail; admin UI dead. |
| `ASHLR_ADMIN_URL` | GH Actions secret | `daily-wad-d-aggregate.yml`, `weekly-digest.yml` | `https://api.ashlr.ai` | Cron exits early; alarm fires on next morning's no-snapshot check. |
| `ANTHROPIC_API_KEY` | Railway env (optional) | `server/src/routes/llm.ts` fallback path | Anthropic console | Hosted summarizer falls back to xAI only; no immediate user impact. |
| `XAI_API_KEY` | Railway env | `server/` `/llm/summarize` primary path | https://console.x.ai/ | `/llm/summarize` 502s; plugin summarizers fall back to local. |
| `STRIPE_SECRET_KEY` | Railway env | `server/src/routes/billing.ts` | `sk_live_...` / `sk_test_...` | Checkout 500s; trials cannot start. |
| `STRIPE_WEBHOOK_SECRET` | Railway env | `/billing/webhook` HMAC verify | `whsec_...` from Stripe dashboard | Webhooks rejected; subs out of sync (Stripe auto-retries 3d — usually self-heals). |
| `STRIPE_PRICE_PRO` / `STRIPE_PRICE_TEAM` | Railway env | Checkout session creation (PR #68) | Stripe price IDs | Upgrade flow stuck on "loading"; checkout never starts. |
| `RAILWAY_TOKEN` | GH Actions secret | `deploy-server.yml` | Railway dashboard → Account → Tokens (project-scoped) | Server deploys fail with "Invalid RAILWAY_TOKEN". |
| `RAILWAY_PROJECT_ID` | Hardcoded in workflow | `deploy-server.yml` | `cc997995-c95d-4f1b-9d43-86cd41aa1d66` | Deploys to wrong project. |
| `RAILWAY_SERVICE_ID` | Hardcoded in workflow | `deploy-server.yml` | `82d8e992-81d5-4a30-88bf-8e90fbd3f044` | Deploys to wrong service. |

> **Secret rotation drill:** when rotating `ASHLR_ADMIN_TRIGGER_TOKEN` or `ASHLR_ADMIN_READ_TOKEN`, update **both** sides (Railway *and* the consumer — GH Actions or Vercel) within the same window or the next cron run / dashboard hit will 503/401.

---

## 3. New endpoints reference (PRs #67-83)

| Method | Path | Auth | Source | What it does |
|--------|------|------|--------|--------------|
| POST | `/stats/daily-active` | anonymous; identity-hash payload | PR #67 — `routes/daily-active.ts` | DAU counter; plugin emits one hashed ping per day. |
| POST | `/v1/session-events` | anonymous; session-id-hash payload | PR #79 — `routes/session-events.ts` | SessionEnd capture for session-graph (replay UI feeder). |
| POST | `/v1/events` | anonymous | existing — `routes/telemetry.ts` | Generic opt-in telemetry. |
| POST | `/webhooks/github` | GitHub HMAC | existing — extended by PR #75 | Now also writes genome cloud-deltas. |
| POST | `/admin/jobs/daily-wad-d-aggregate` | `Bearer $ASHLR_ADMIN_TRIGGER_TOKEN` | PR #73 — `routes/admin-jobs.ts` | Cron-invoked WAD-D snapshot aggregator; PR #83 chains discovery-propagation aggregate after. |
| GET | `/admin/wad-d-snapshots` | `Bearer $ASHLR_ADMIN_READ_TOKEN` | PR #74 — `routes/admin-wad-d.ts` | Dashboard read: WAD-D snapshot history + sparkline data (PR #81 added date-range filter). |
| GET | `/admin/wad-d-breakdown` | `Bearer $ASHLR_ADMIN_READ_TOKEN` | PR #78 — `routes/admin-wad-d-breakdown.ts` | Segment breakdown across the 6 WAD-D indicators. |
| GET | `/admin/sessions` | `Bearer $ASHLR_ADMIN_READ_TOKEN` | PR #82 — `routes/admin-sessions.ts` | Session replay index. |
| GET | `/admin/sessions/:session_id_hash` | `Bearer $ASHLR_ADMIN_READ_TOKEN` | PR #82 — `routes/admin-sessions.ts` | Single-session replay payload. |
| GET | `/admin/discoveries/propagation` | `Bearer $ASHLR_ADMIN_READ_TOKEN` | PR #83 — `routes/admin-discovery-propagation.ts` | Cross-session discovery propagation read. |
| GET | `/genome/cloud-deltas` | API token (Pro/Team gated) | PR #75 — `routes/genome-cloud-deltas.ts` | Pro/Team puller for team-cloud genome deltas. |

> Admin endpoints return **404 (not 401)** for missing/bad bearer to avoid leaking the surface — keep that in mind when debugging.

---

## 4. Cron + scheduled jobs

| Workflow | Cadence (UTC) | Calls | Notes |
|----------|---------------|-------|-------|
| `.github/workflows/daily-wad-d-aggregate.yml` | `0 2 * * *` (02:00 daily) | `POST $ASHLR_ADMIN_URL/admin/jobs/daily-wad-d-aggregate` with bearer | Computes WAD-D snapshot. Per PR #83, the aggregator now also runs the **discovery-propagation aggregate** as a chained step after the WAD-D snapshot completes. Fails fast on missing secrets (validates `ASHLR_ADMIN_URL` + `ASHLR_ADMIN_TRIGGER_TOKEN` first). |
| `.github/workflows/weekly-digest.yml` | `0 14 * * 0` (Sun 14:00) | Local digest job — reads server DB via Railway-shared `ASHLR_MASTER_KEY` | Sends the weekly digest email to all opted-in users. `dry_run` input available for manual runs. |

**Re-running a failed cron:** `gh workflow run "Daily WAD-D aggregate"` from the repo root (or the Actions tab → workflow → "Run workflow"). The aggregator is idempotent — same day re-runs overwrite the snapshot.

---

## 5. Logs + telemetry locations

### Server (Railway)
- **Logs:** structured JSON on stdout. `railway logs --service ashlr-plugin-api`.
- **Key events to grep for:**
  - `cron_start`, `cron_end` — daily WAD-D + discovery-propagation aggregator lifecycle.
  - `crash_report` — plugin crash dumps uploaded via `/v1/events`.
  - `"status":429` — rate-limit hits.
  - `"status":5` — server errors.
- **DB:** `$ASHLR_DB_PATH` on the persistent volume. Snapshot via `fly volumes snapshots list` (volume backups configured at the Railway level).

### Plugin (local, per-user)
- `~/.ashlr/hook-errors.jsonl` — every hook crash (one line per event).
- `~/.ashlr/hook-timings.jsonl` — per-hook latency (consumed by `/ashlr-hook-timings`).
- `~/.ashlr/stats.json` — running token-savings counter (consumed by `/ashlr-savings` and `/ashlr-dashboard`).
- `~/.ashlr/config.json` — `ASHLR_HOOK_MODE` and other per-user toggles.

### Genome (per project)
- `.ashlrcode/genome/manifest.json` — local genome manifest.
- `.ashlrcode/genome/knowledge/*.md` — local discoveries + architecture notes.
- Team-cloud copy at server-side (encrypted with `ASHLR_MASTER_KEY`); pulled via `/genome/cloud-deltas`.

---

## 6. Common-fire troubleshooting

### A. "Railway deploy failed"
- **Diagnose:** `gh run list --workflow="Deploy server to Railway" --limit 5`; then `gh run view <id> --log-failed`.
- **Common cause:** Stripe block from PR #69 — boot-time guard that aborts if `STRIPE_PRICE_PRO` / `STRIPE_PRICE_TEAM` are unset in prod. Check `Run tests` job for the assertion message.
- **Fix:** `railway variables --service ashlr-plugin-api --set STRIPE_PRICE_PRO=price_...` then re-run the workflow.

### B. "Daily WAD-D cron failed"
- **Diagnose:** `gh run list --workflow="Daily WAD-D aggregate" --limit 5` → `gh run view <id> --log-failed`.
- **Common causes:** (1) missing `ASHLR_ADMIN_URL` / `ASHLR_ADMIN_TRIGGER_TOKEN` GH secrets — workflow logs "secret is not configured"; (2) Railway server down — curl returns connection error; (3) token drift between GH and Railway — server returns 401/404.
- **Fix:** check `Validate required secrets` step output first. If tokens drifted, rotate both ends together.

### C. "/admin/wad-d-* returns 404"
- **Diagnose:** `curl -i -H "Authorization: Bearer $TOKEN" https://api.ashlr.ai/admin/wad-d-snapshots`. If the site UI is the caller, check Vercel env in dashboard → Settings → Environment Variables.
- **Common cause:** missing/wrong `ASHLR_ADMIN_READ_TOKEN` on Vercel. Admin routes deliberately 404 on bad bearer (not 401) so this masquerades as a missing route.
- **Fix:** set `ASHLR_ADMIN_READ_TOKEN` on Vercel to match Railway's; redeploy site (Vercel → Redeploy without cache).

### D. "/admin/jobs/* returns 503 (or cron job 503s)"
- **Diagnose:** Railway logs grep for `admin_jobs.unauthorized` or `cron_start` absence. `railway variables --service ashlr-plugin-api --kv | grep ASHLR_ADMIN_TRIGGER`.
- **Common cause:** missing/wrong `ASHLR_ADMIN_TRIGGER_TOKEN` on Railway, or the server hasn't picked up the new value after a rotation.
- **Fix:** `railway variables --service ashlr-plugin-api --set ASHLR_ADMIN_TRIGGER_TOKEN=...` then `railway redeploy --service ashlr-plugin-api`.

### E. "Plugin hook timing out"
- **Diagnose:** in the affected user's shell: `/ashlr-doctor` (look at the hook-perf surface) and `tail -50 ~/.ashlr/hook-errors.jsonl`. Per-hook p50/p95/max via `/ashlr-hook-timings`.
- **Common causes:** (1) `ASHLR_HOOK_MODE=redirect` on a host where MCP tools aren't loaded — switch to `nudge`; (2) MCP server crash — `/ashlr-status`; (3) genome retrieval hung — set `ASHLR_GENOME_RETRIEVAL=off` as the kill-switch (v1.30 shipped this).
- **Fix:** `~/.ashlr/config.json` → `{"ASHLR_HOOK_MODE":"nudge"}`; restart Claude Code session.

---

## 7. Tier gates summary

| Feature | Free | Pro | Team |
|---------|------|-----|------|
| Cloud sync (`/genome/cloud-deltas`) | off | on | on (shared team genome) |
| AI synthesis (hosted `/llm/summarize`) | off (local-only) | on (`LLM_COST_CAP_USD` default $5) | on (shared cap) |
| Predictive prefetch (`ASHLR_PREFETCH`) | no-op | 3 neighbours | 10 neighbours |
| Distributed orchestration (planned) | — | — | on (post-v1.32) |
| Session replay UI consumer | n/a (founder-only) | n/a | n/a |

---

## 8. Pre-existing test failures (don't chase these at 2am)

These failures exist on `main` already — they are **not** caused by the v1.32 changes:

- `server/tests/wadd-lead-indicators.test.ts:155` — server `tsc` type error; pre-existing on `main`.
- `site/app/source.ts:1` — site `tsc` error; pre-existing on `main`.
- `tests/ast-chunker.test.ts` — 40 tree-sitter timeouts in the ast-refactor suite; pre-existing flakes, not regressions.

If a PR check goes red on **only** these, the change is safe — verify the rest of the suite is green and merge.

---

## 9. References (local plan docs)

All under `~/.claude/plans/` on the founder's workstation (not committed to the repo):

- `integration-architecture-north-star.md` — v1.32 northstar spec.
- `genome-2-0-architecture.md` — Genome 2.0 architecture.
- `wad-d-instrumentation-genome-2-sequencing.md` — WAD-D + Genome 2.0 sequencing.
- `distributed-orchestration-design.md` — Distributed orchestration design (planned for post-v1.32).

In-repo:
- `.github/workflows/deploy-server.yml` — Railway deploy pipeline.
- `.github/workflows/daily-wad-d-aggregate.yml` — daily aggregator cron.
- `.github/workflows/weekly-digest.yml` — weekly digest cron.
- `server/src/routes/admin-*.ts` — admin read/write routes.
- `server/src/jobs/daily-wad-d-aggregate.ts`, `discovery-propagation-aggregate.ts` — aggregator job bodies.
