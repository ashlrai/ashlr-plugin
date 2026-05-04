# Railway Deployment — Go-Live Runbook

Step-by-step guide to bringing the ashlr backend live on Railway. The
service is already configured (`railway.toml`, `Dockerfile`) — this doc
covers the external setup that only the operator can perform.

> **Reference:** for telemetry-specific deploy notes (v1.24), see
> `server/docs/telemetry-deployment.md`. This doc covers the full stack.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Railway account + project | <https://railway.app>. Free tier works for staging. |
| Railway CLI | `npm install -g @railway/cli` (pin v4.27.5+ for CI token support) |
| Postgres service | Add inside your Railway project — Railway provisions `DATABASE_URL` automatically |
| Stripe account | <https://stripe.com> — live or test mode |
| Resend account | <https://resend.com> — for magic-link auth emails |
| xAI API key | <https://x.ai> — Grok-4 Fast Reasoning for hosted summarizer (v1.26 switched from Anthropic Haiku) |

---

## Step 1 — Add a Postgres service

In the Railway dashboard, open your project and click **New → Database →
PostgreSQL**. Railway automatically injects `DATABASE_URL` into all
services in the same project. You do **not** need to set this manually.

Verify after provisioning:

```sh
railway variables --service ashlr-plugin-api | grep DATABASE_URL
```

---

## Step 2 — Set required environment variables

Run from your local shell (authenticated to Railway via `railway login`):

```sh
# Stripe
railway variables set STRIPE_SECRET=sk_live_...           --service ashlr-plugin-api
railway variables set STRIPE_WEBHOOK_SECRET=whsec_...     --service ashlr-plugin-api

# Resend (magic-link auth emails)
railway variables set RESEND_API_KEY=re_...               --service ashlr-plugin-api

# xAI Grok (hosted summarizer — POST /v1/llm/summarize)
railway variables set XAI_API_KEY=xai-...                 --service ashlr-plugin-api

# Auth signing material (generate with: openssl rand -hex 32)
railway variables set JWT_SECRET=$(openssl rand -hex 32)          --service ashlr-plugin-api
railway variables set SESSION_HASH_SALT=$(openssl rand -hex 32)   --service ashlr-plugin-api
```

### Variable reference

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | Postgres connection string. Railway sets this automatically when a Postgres service is in the same project. |
| `STRIPE_SECRET` | Yes | Stripe secret key (`sk_live_…` or `sk_test_…`). |
| `STRIPE_WEBHOOK_SECRET` | Yes | Stripe webhook signing secret (`whsec_…`). |
| `RESEND_API_KEY` | Yes | Resend API key for transactional email (magic-link auth, status alerts). |
| `XAI_API_KEY` | Yes | xAI Grok API key. The hosted summarizer (`POST /v1/llm/summarize`) uses `grok-4-1-fast-reasoning`. |
| `JWT_SECRET` | Yes | 32+ random hex chars. Used to sign session JWTs. Rotate = all sessions invalidated. |
| `SESSION_HASH_SALT` | Yes | 32+ random hex chars. Used by `looksLikePath()` redaction and per-session ID hashing in telemetry. |
| `PORT` | Auto | Railway sets this automatically. The server reads `process.env.PORT`. Do **not** set it manually. |

### Optional / override variables

| Variable | Default | Description |
|---|---|---|
| `ASHLR_TELEMETRY_URL` | *(plugin-side)* | Override the telemetry ingest URL in the plugin client. |
| `STATUS_BASE_URL` | `https://status.ashlr.ai` | Base URL for status-page email links. |
| `LOG_LEVEL` | `info` | Server log verbosity. |

---

## Step 3 — Deploy

Push a `server/**` change to `main` and CI runs `bun test` +
`railway up --service ashlr-plugin-api --detach`. Or trigger manually:

```sh
cd server
railway up --service ashlr-plugin-api --detach
```

Railway builds the `Dockerfile` at repo root, deploys to the service, and
exposes a `*.up.railway.app` public domain automatically.

---

## Step 4 — DNS

Add two CNAME records in your DNS provider:

```
telemetry.ashlr.ai  CNAME  <railway-public-domain>.up.railway.app
api.ashlr.ai        CNAME  <railway-public-domain>.up.railway.app
```

Get the Railway public domain:

```sh
railway domain --service ashlr-plugin-api
```

Then, in the Railway dashboard:
1. Open **ashlr-plugin-api → Settings → Networking → Custom Domain**.
2. Add both `telemetry.ashlr.ai` and `api.ashlr.ai`.
3. Railway auto-provisions Let's Encrypt TLS within ~2 minutes.

DNS propagation typically takes 5–30 minutes. You can monitor with:

```sh
watch -n 10 'dig +short CNAME telemetry.ashlr.ai'
```

---

## Step 5 — Verify the deploy

Once DNS has propagated:

```sh
# Health + readiness
curl https://api.ashlr.ai/healthz
# {"ok":true}

curl https://api.ashlr.ai/readyz
# {"ok":true}

# Telemetry ingest round-trip
curl -X POST https://telemetry.ashlr.ai/v1/events \
  -H 'content-type: application/json' \
  -d '{
    "sessionId": "0123456789abcdef",
    "events": [{
      "ts": 1746000000,
      "kind": "version",
      "sessionId": "0123456789abcdef",
      "pluginVersion": "1.27.0",
      "bunVersion": "1.2.0",
      "platform": "darwin",
      "arch": "arm64"
    }]
  }'
# {"accepted":1}
```

Or run the automated smoke runner from the repo root:

```sh
ASHLR_API_URL=https://api.ashlr.ai bun run scripts/cloud-smoke-test.ts
```

With a Pro token for full coverage:

```sh
ASHLR_API_URL=https://api.ashlr.ai \
ASHLR_PRO_TOKEN=<your-token> \
  bun run scripts/cloud-smoke-test.ts
```

See `server/docs/cloud-smoke-tests.md` for the full manual checklist.

---

## Step 6 — Stripe webhook

Register the webhook in Stripe:

1. Dashboard → Developers → Webhooks → **Add endpoint**.
2. URL: `https://api.ashlr.ai/webhooks/stripe`
3. Events: `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_succeeded`,
   `invoice.payment_failed`.

Then set the signing secret returned by Stripe:

```sh
railway variables set STRIPE_WEBHOOK_SECRET=whsec_...  --service ashlr-plugin-api
```

---

## First-24h monitoring checklist

After go-live, check each of the following within 24 hours:

- [ ] **Telemetry ingest rate** — Railway metrics should show steady POST
      `/v1/events` 200s from plugin clients with `ASHLR_TELEMETRY=on`.
      Alarm if 5xx rate > 1%.

- [ ] **Hosted summarizer** — spot-check a few `POST /v1/llm/summarize`
      calls in logs. Verify `modelUsed: "grok-4-1-fast-reasoning"`.
      Alarm if error rate > 5% or `cost` unexpectedly large.

- [ ] **`machine_count` growth** — `GET /v1/stats/aggregate` should show
      increasing `machine_count` as Pro users sync. A flat 0 after 6h
      means stats sync is broken client-side.

- [ ] **5xx rate** — Railway's built-in metrics panel. Target < 0.1%.
      Common root cause: missing env var → check `railway logs`.

- [ ] **Auth token validation** — a few `GET /user/me` 200s in logs
      confirms the JWT stack is healthy.

- [ ] **Stripe webhook** — trigger a test event from the Stripe dashboard.
      Should land in `railway logs` as a handled `invoice.payment_succeeded`.

---

## Rollback

```sh
# List deployments
railway deployments --service ashlr-plugin-api

# Roll back to a specific deployment
railway rollback <deployment-id> --service ashlr-plugin-api
```

The database migration is idempotent (`CREATE TABLE IF NOT EXISTS` /
`IF NOT EXISTS` columns) — no manual migration rollback needed.

---

## Cost / capacity estimates

| Resource | Estimate |
|---|---|
| Railway hobby plan | $5/month baseline; scales to usage |
| Postgres (Railway) | Included up to 1 GB; ~200–400 bytes/telemetry row |
| xAI Grok-4 Fast Reasoning | $0.20/1M input + $0.50/1M output tokens |
| Resend | Free tier: 3,000 emails/month |

At 1,000 active Pro users with daily stats sync + occasional LLM calls,
expect ~$20–40/month on xAI and negligible Railway/Resend costs.
