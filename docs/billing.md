# ashlr billing

ashlr uses Stripe for subscription billing. This document covers the tiers,
the integration architecture, and what happens at each lifecycle event.

## Tiers

| Tier | Price | Features |
|------|-------|----------|
| Free | $0 | Full local plugin, 14 MCP tools, 23 skills, local genome scribe loop |
| Pro  | $12/mo or $120/yr | Everything in Free + cloud LLM summarizer, cross-machine stats sync, hosted retrieval, live auto-updating badge |
| Team | $24/user/mo or $240/user/yr | Everything in Pro + shared team genome sync, team dashboard, priority support (min 3 users) |

Free users who attempt to use gated endpoints receive HTTP 403 with
`{ "error": "This feature requires a paid plan.", "upgrade_url": "/billing/checkout" }`.

## How users get access

The fastest way to upgrade is `/ashlr-upgrade` — a terminal-native flow that
takes under 90 seconds without leaving Claude Code. See [upgrade.md](upgrade.md)
for the full walkthrough.

Users can also sign up and sign in through a passwordless magic-link flow:

1. Visit `/signin` on the site and enter an email address.
2. The backend creates a user record (if new) and sends a one-time link via
   [SendGrid](https://sendgrid.com). The link is valid for 15 minutes.
3. Clicking the link calls `POST /auth/verify`, which issues a permanent API
   token and stores it in the user's browser (`localStorage`). The token is
   used as a `Bearer` credential for all subsequent API calls.
4. To upgrade to Pro or Team, the user visits `/pricing` and completes a
   Stripe Checkout session. The webhook at `POST /billing/webhook` promotes the
   user's tier in the database.

**Rate limit:** The `/auth/send` endpoint accepts at most 5 requests per email
address per hour. The 6th request returns HTTP 429.

**Self-serve:** There is no longer a manual CLI provisioning step for new users.
The `bun run src/cli/issue-token.ts <email>` CLI is retained for internal use
and emergency provisioning only.

## Stripe integration

### Products and prices

The `stripe-setup` CLI creates two Stripe products ("ashlr Pro" and "ashlr Team")
with four prices (monthly and annual for each). IDs are stored in the
`stripe_products` database table so the runtime never hard-codes them.

To bootstrap a new environment:

```sh
STRIPE_SECRET_KEY=sk_live_... bun run src/cli/stripe-setup.ts
```

The script is idempotent — re-running it skips any prices already in the DB.

### Checkout flow

1. Authenticated user POSTs to `POST /billing/checkout` with `{ tier, seats? }`.
2. Server creates a Stripe Checkout Session and returns `{ url }`.
3. Client redirects user to `url`.
4. On success, Stripe redirects to `/billing/return?session={CHECKOUT_SESSION_ID}`
   and fires a `checkout.session.completed` webhook.
5. Webhook handler creates the subscription record and upgrades `users.tier`.

### Customer portal

`GET /billing/portal` creates a Stripe Customer Portal session for the
authenticated user. The portal lets them update their payment method, view
invoices, change plan, or cancel. Returns `{ url }` for a client-side redirect.

Users without a billing record receive 404.

### Subscription status

`GET /billing/status` returns:

```json
{
  "tier": "pro",
  "seats": 1,
  "renewsAt": "2026-05-17T00:00:00.000Z",
  "cancelAt": null
}
```

Free users with no subscription record receive `{ "tier": "free", ... }`.

## Webhook events

The webhook endpoint is `POST /billing/webhook`. Register it in the Stripe
dashboard pointing at `https://api.ashlr.ai/billing/webhook`.

Events handled:

| Event | Action |
|-------|--------|
| `checkout.session.completed` | Creates subscription record, sets `users.tier` to the purchased tier |
| `customer.subscription.updated` | Updates `current_period_end`, `seats`, and `status`; reactivates tier if status returns to `active` |
| `customer.subscription.deleted` | Sets subscription `status` to `canceled`, downgrades `users.tier` to `free` |
| `invoice.payment_failed` | Sets subscription `status` to `past_due`; tier remains for the 7-day grace period while Stripe retries |

Webhook idempotency is enforced via the `stripe_events` table. Duplicate
`event.id` deliveries return 200 immediately without re-processing.

All events are verified via `stripe.webhooks.constructEvent` using the
`STRIPE_WEBHOOK_SECRET` environment variable. Invalid signatures return 400.

## What happens on cancellation

When a user cancels, Stripe fires `customer.subscription.deleted` at the end
of the paid period. The webhook handler downgrades `users.tier` to `free`.
The subscription record is retained for auditing with `status = 'canceled'`.

Users on an annual plan who cancel mid-year retain access until the period end
(`current_period_end`). Refunds are handled through the Stripe dashboard.

## Dispute policy

Disputes should be handled through the Stripe dashboard. Contact
support@ashlr.ai for billing questions before initiating a chargeback.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `STRIPE_SECRET_KEY` | Yes (production) | Stripe secret key (`sk_live_...` or `sk_test_...`) |
| `STRIPE_WEBHOOK_SECRET` | Yes (production) | Signing secret from Stripe webhook dashboard (`whsec_...`) |
| `BASE_URL` | No | Base URL for success/return redirects (default: `https://api.ashlr.ai`) |
| `SITE_URL` | No | Site URL for cancel redirect (default: `https://plugin.ashlr.ai`) |
| `TESTING` | Tests only | Set to `1` to stub Stripe client; no real API calls are made |

## Database tables

Three tables support billing:

- **`subscriptions`** — one row per Stripe subscription; tracks tier, status,
  seats, `current_period_end`, and `cancel_at`.
- **`stripe_events`** — event IDs from processed webhook deliveries; prevents
  double-processing on Stripe retries.
- **`stripe_products`** — caches Stripe product and price IDs seeded by the
  `stripe-setup` CLI; keyed by `pro`, `pro-annual`, `team`, `team-annual`.

The `users` table has a `tier` column (`free` | `pro` | `team`) that is the
single source of truth for access control checks at request time.

## Audit log and policy packs (team tier)

Both features require the **team** tier or higher. Free and Pro users receive
HTTP 403 if they attempt to call these endpoints.

### Policy packs

Team admins can upload YAML/JSON allow-deny-confirm rule sets via
`POST /policy/upload`. The server stores each upload as an immutable versioned
snapshot. Members fetch the current pack via `GET /policy/current` (cached
5 minutes via ETag). Admins can roll back to any prior version via
`POST /policy/rollback`. See `docs/policy-packs.md` for rule syntax and
examples.

Only users with `org_role = "admin"` can upload or roll back. Members can
read the current pack. Free and Pro users are rejected at the tier gate before
org-role checks run.

### Audit log

The `POST /audit/event` endpoint accepts tool-call events from the
`audit-upload` hook. Events are written to `audit_events` in an append-only
fashion — no updates or deletes are issued outside of explicit admin purges.

Paths and cwds in event arguments are replaced with a 16-char SHA-256
fingerprint before storage. File contents are never stored. This satisfies
GDPR path-data minimisation while preserving correlation for compliance audits.

Org admins can query events with filters (`GET /audit/events`) or export the
full log as NDJSON (`GET /audit/export`). Non-admin members are blocked at the
org-role gate with 403.

### Database tables (Phase 4)

- **`policy_packs`** — immutable versioned snapshots; unique on `(org_id, name, version)`.
- **`policy_current`** — one row per org; points to the active pack.
- **`audit_events`** — append-only event log; indexed by `(org_id, at)` and `(user_id, at)`.
- **`users.org_id`** / **`users.org_role`** — org membership and role columns added in Phase 4 migration.
