# Deploy Guide

This document covers end-to-end deployment of the ashlr site (Vercel) and API server (Railway), DNS configuration, smoke testing, rollback procedures, and expected costs.

---

## Table of Contents

1. [Vercel — site deployment](#1-vercel--site-deployment)
2. [Fly.io — API server deployment](#2-flyio--api-server-deployment)
3. [DNS configuration](#3-dns-configuration)
4. [Smoke test](#4-smoke-test)
5. [Rollback procedures](#5-rollback-procedures)
6. [Cost expectations](#6-cost-expectations)

---

## Signing up — email setup (SendGrid)

ashlr uses [SendGrid](https://sendgrid.com) to send magic-link sign-in emails from
`noreply@ashlr.ai`. Before users can self-serve sign up, a domain-verified
sender must be configured:

1. Create a SendGrid account at https://sendgrid.com and add your sending domain
   (e.g. `ashlr.ai`). Follow their
   [domain verification guide](https://docs.sendgrid.com/ui/sending-email/sender-verification)
   to add the required DNS records (SPF, DKIM, DMARC).
2. Once the domain is verified, create an API key in the SendGrid dashboard
   (Developers > API Keys). Scope it to "Sending access" only.
3. Store the key as a Railway variable alongside your other server variables
   (Project > ashlr-plugin-api > Variables, or via CLI):
   ```
   railway variables --service ashlr-plugin-api --set SENDGRID_API_KEY=SG...
   ```
4. Set the `FRONTEND_URL` variable to your site origin so magic-link URLs point
   to the right place (default: `https://plugin.ashlr.ai`):
   ```
   railway variables --service ashlr-plugin-api --set FRONTEND_URL=https://plugin.ashlr.ai
   ```

**Dev / test mode:** If `SENDGRID_API_KEY` is unset, or if `TESTING=1`, no email
is sent. The magic token is printed to stderr instead — safe for local
development and CI.

---

## Stripe webhook setup

After deploying the API server, register the billing webhook in the Stripe dashboard:

1. Go to Stripe Dashboard > Developers > Webhooks > Add endpoint.
2. Set the endpoint URL to `https://api.ashlr.ai/billing/webhook`.
3. Select the following events to listen for:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
4. After saving, reveal the signing secret (`whsec_...`) and store it as a Railway variable:

```sh
railway variables --service ashlr-plugin-api --set STRIPE_WEBHOOK_SECRET=whsec_...
railway variables --service ashlr-plugin-api --set STRIPE_SECRET_KEY=sk_live_...
```

5. Bootstrap Stripe products and prices (run once per environment):

```sh
railway run --service ashlr-plugin-api -- bun run src/cli/stripe-setup.ts
```

The setup script is idempotent — re-running it is safe.

---

## 1. Vercel — site deployment

The `site/` Next.js app is deployed to Vercel via `.github/workflows/deploy-site.yml`. Pushes to `main` that touch `site/**` trigger a production deploy. Pull requests get a preview URL posted as a comment.

### Step 1 — Create the Vercel project

1. Go to [vercel.com](https://vercel.com) and sign in.
2. Click **Add New Project**, select your GitHub repo (`ashlrai/ashlr-plugin`).
3. Set the **Root Directory** to `site`.
4. Set the **Framework Preset** to `Next.js`.
5. Leave build/output settings at defaults — the workflow runs `bun run build` itself.
6. Click **Deploy** once to initialize the project (this first deploy can be ignored).

### Step 2 — Grab the three required tokens

All three values are on the project settings page in Vercel.

| Secret | Where to find it |
|--------|-----------------|
| `VERCEL_TOKEN` | Account Settings > Tokens > Create (scope: Full Account) |
| `VERCEL_ORG_ID` | Project Settings > General > Team ID (shown at page top) |
| `VERCEL_PROJECT_ID` | Project Settings > General > Project ID |

### Step 3 — Add secrets to GitHub

In the GitHub repo, go to **Settings > Secrets and variables > Actions**, then add:

- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`

### Step 4 — Verify

Push any change under `site/` to `main`. The **Deploy site to Vercel** workflow should appear under Actions, run `bun run build`, then deploy. The Vercel dashboard shows the new deployment within ~2 minutes.

For pull requests, the workflow posts a preview URL comment. No additional configuration needed.

---

## 2. Railway — API server deployment

The `server/` Hono/Bun app is deployed to Railway via `.github/workflows/deploy-server.yml`. Pushes to `main` that touch `server/**` run tests first, then deploy. Build is driven by `server/Dockerfile` (referenced from `server/railway.json`).

### Step 1 — Install Railway CLI and log in

```bash
brew install railway          # macOS
# or: curl -fsSL https://railway.com/install.sh | sh
railway login
```

### Step 2 — Create the project (first time only)

```bash
cd server
railway init --name ashlr-plugin-api
```

This creates a Railway project in your default workspace. After init:

```bash
# Add a service inside the project (named to match the workflow)
railway add --service ashlr-plugin-api

# Link this directory to the new project so `railway up` knows where to deploy
railway link
```

Railway auto-detects the `Dockerfile` and `railway.json` in `server/`. The `healthcheckPath` is `/readyz` (matches `server/src/routes/health.ts`).

### Step 3 — Set environment variables

The server needs ~20 variables — see [`docs/operations.md`](./operations.md) for the full list. Set them via either:

```bash
# Per-key
railway variables --service ashlr-plugin-api --set ASHLR_MASTER_KEY=...

# Or paste a .env in the Railway dashboard:
#   Project > ashlr-plugin-api > Variables > Raw editor
```

The minimum to boot a healthy instance: `ASHLR_MASTER_KEY`, `NODE_ENV=production`, `FRONTEND_URL`, plus whichever feature secrets you need (Stripe / SendGrid / GitHub OAuth / Anthropic).

`PORT` is provided by Railway automatically — don't set it.

### Step 4 — Get the deploy token

```bash
# Project-scoped token (recommended): only deploys to this project, can't access others.
# Create one in the Railway dashboard:
#   Account > Tokens > New Token > scope: Project: ashlr-plugin-api
```

Copy the printed value. This is your `RAILWAY_TOKEN`.

### Step 5 — Add the secret to GitHub

In GitHub repo > **Settings > Secrets and variables > Actions**, add:

- `RAILWAY_TOKEN`

### Step 6 — Push and verify

Push any change under `server/` to `main`. The **Deploy server to Railway** workflow runs `bun test` first — if any test fails, the deploy is aborted. On success, `railway up --service ashlr-plugin-api --detach` builds and deploys remotely.

Verify with:

```bash
curl https://api.ashlr.ai/
# Expected: {"ok":true,"service":"ashlr-server","phase":1}
```

---

## 3. DNS configuration

### plugin.ashlr.ai — Vercel

Add a CNAME record in your DNS provider:

```
Type:  CNAME
Name:  plugin
Value: cname.vercel-dns.com
TTL:   3600
```

Then in Vercel > Project Settings > Domains, add `plugin.ashlr.ai`. Vercel provisions a TLS certificate automatically via Let's Encrypt within ~2 minutes.

### api.ashlr.ai — Railway

Railway provisions a default `<service>-production-<id>.up.railway.app` domain. Get it with:

```bash
railway domain --service ashlr-plugin-api
```

In the Railway dashboard → ashlr-plugin-api → Settings → Networking → **Custom Domain**, add `api.ashlr.ai`. Railway shows you the exact CNAME target to use; it usually looks like `<id>.up.railway.app`.

Add a CNAME record in your DNS provider:

```
Type:  CNAME
Name:  api
Value: <target shown in Railway dashboard>
TTL:   3600
```

Railway issues the TLS certificate automatically via Let's Encrypt within ~2 minutes.

---

## 4. Smoke test

After every deploy, run the smoke test script to verify both services are healthy:

```bash
# Install endpoint only (no token required)
./scripts/deploy-smoke.sh

# Full test including badge and stats endpoints
ASHLR_TOKEN=<provisioned_token> ./scripts/deploy-smoke.sh

# Override URLs for staging
SITE_URL=https://preview.plugin.ashlr.ai \
API_URL=https://staging-api.ashlr.ai \
ASHLR_TOKEN=<token> \
./scripts/deploy-smoke.sh
```

The script exits with code `0` on full pass, `1` if any check fails. It is safe to run repeatedly. Checks performed:

- `GET /` on site — 200
- `GET /robots.txt` — 200
- `GET /sitemap.xml` — 200
- `GET /` on API — `{ok: true}` JSON
- `POST /stats/sync` — 200 (authenticated)
- `GET /stats/aggregate` — user_id present (authenticated)
- `GET /u/:userId/badge.svg` — SVG content with metric text

To provision a token for testing:

```bash
cd server && bun run issue-token
```

---

## 5. Rollback procedures

### Vercel rollback

The Vercel dashboard keeps every deployment permanently. To roll back:

1. Go to the project > **Deployments**.
2. Find the last known-good deployment.
3. Click the three-dot menu > **Promote to Production**.

Takes effect within 30 seconds globally.

Alternatively, revert the offending commit and push — the workflow redeploys automatically.

### Railway rollback

Railway keeps every previous deployment. Roll back instantly from the dashboard:

1. Go to the project > **ashlr-plugin-api** > **Deployments**.
2. Find the last known-good deployment.
3. Click the three-dot menu > **Redeploy**.

Or via CLI:

```bash
# List recent deployments
railway status --service ashlr-plugin-api

# Redeploy the most recent successful deployment (rollback if HEAD is broken)
railway redeploy --service ashlr-plugin-api
```

Or revert the commit and push — the workflow redeploys the server automatically.

To monitor a rollback:

```bash
railway logs --service ashlr-plugin-api
```

---

## 6. Cost expectations

Cost figures below are derived from the Phase 1 architecture (Railway for compute, Neon serverless Postgres, Cloudflare R2/S3 for storage, Upstash Redis for rate limits).

| Component | 100 MAU | 1,000 MAU | 10,000 MAU |
|-----------|---------|-----------|------------|
| Vercel (site hosting) | Free tier | Free tier | ~$20/mo (Pro) |
| Railway compute (ashlr-plugin-api, sleeps when idle) | ~$5/mo | ~$10/mo | ~$30/mo |
| Postgres (Neon serverless) | ~$0.50/mo | ~$5/mo | ~$30/mo |
| S3 / R2 (stats backups, genome bodies) | ~$0.10/mo | ~$1/mo | ~$8/mo |
| Redis (Upstash, rate limits + cache) | $0 (free tier) | $20/mo (fixed) | $50/mo |
| Cloud LLM inference (Haiku, summarization) | ~$0.20/mo | ~$2/mo | ~$20/mo |
| Bandwidth + misc | ~$0.20/mo | ~$2/mo | ~$15/mo |
| **Total** | **~$4/mo** | **~$38/mo** | **~$173/mo** |

**At 1K MAU**, total infra is approximately **$38/month**. The MIT free tier carries no marginal cost per user for the open-source plugin itself; backend costs arise only from the Pro stats-sync and hosted badge features.

**At 10K MAU**, the architecture remains defensible. Beyond that, add Postgres read replicas and consider sharding by organization. See `docs/pro-backend-architecture.md` for the full cost model and scaling decision points.

**Fly.io specifics**: the `ashlr-api` app is configured with `auto_stop_machines = "stop"` and `min_machines_running = 0`. It scales to zero when idle, meaning zero compute cost at 0 requests. The first request cold-starts in ~500ms (Bun is fast). For production traffic, set `min_machines_running = 1` to eliminate cold starts at the cost of ~$3/mo for the always-on machine.
