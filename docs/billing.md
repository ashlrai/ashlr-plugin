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
