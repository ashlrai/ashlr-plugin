# ashlr Pro Backend Architecture

_Target: Ship Phase 1 in 12 weeks. TypeScript + Bun + Postgres + Hono._

---

## 1. Overview

The ashlr pro-tier backend solves three structural problems the self-hosted plugin cannot: (1) team genome sync with live CRDT merging, (2) cross-device stats aggregation and public leaderboards, and (3) managed LLM inference without local hardware. The backend is a constellation of stateless HTTP services (one per concern) backed by Postgres, S3, and Redis. Each service owns its API surface and data; clients gate pro calls on `ASHLR_PRO_TOKEN` presence.

**Architecture**: Request → ALB → Bun app (stateless, auto-scales) → Postgres (relational + append-only logs) / S3 (section bodies, policy YAML) / Redis (rate limits, session cache). Clients use `ASHLR_API_URL` to override the default `https://api.ashlr.ai`.

---

## 2. Stack Choices

**Language: TypeScript (Hono).**
- Shares types with the plugin; avoids .proto/.graphql overhead.
- Hono is minimal (6KB), fast, and works on Bun, Node, Cloudflare Workers, Deno—future-proofs library portability.

**Runtime: Bun 1.1+.**
- Native TypeScript execution avoids build-step friction during development.
- Startup time <50ms; HTTP perf competitive with Deno.
- Plugin already uses Bun; aligns team tooling.
- Node.js 22 acceptable fallback if Bun stability concerns arise later.

**Framework: Hono.**
- Lightweight, portable, zero-magic middleware.
- Same mental model as the plugin's existing HTTP layer.
- Easy rate-limit + auth middleware composition.

**Database: Postgres (primary) + S3/R2 (blobs) + Redis (cache/limits).**
- Postgres handles relational metadata (users, orgs, genome sections, stats, audit logs).
- S3/Cloudflare R2 stores section bodies (~10–50KB each); cheaper than Postgres for large blobs, simpler cache busting.
- Redis for rate limits, session cache, leaderboard pre-compute.

**Auth: Clerk.**
- Native JWT support (client-side validation of `ASHLR_PRO_TOKEN`).
- Built-in passwordless + social; low ops overhead.
- Pricing aligns with usage (pay-per-auth, not per-seat); fits lean startup model.

**Hosting: Railway + Neon.**
- Railway abstracts container + secret management; plug in Neon Postgres, auto-scales.
- Neon's serverless Postgres is cost-efficient for bursty stats-sync workloads.
- S3 is S3 (AWS, Wasabi, or Backblaze B2 are equivalent; pick by region/cost).

**Payments: Stripe.**
- Checkout for one-time + recurring subscriptions.
- Billing Portal for self-serve upgrades, cancel.
- Webhooks for trial expiry, dunning, churn.

---

## 3. API Surface

Each endpoint requires `Authorization: Bearer <ASHLR_PRO_TOKEN>` header. Rate limits applied via Redis + sliding-window count-and-sleep.

### 3.1 Genome Sync

Clients sync `.ashlrcode/genome/` sections and receive merged diffs.

- **POST /genome/sync** — Upload section mutations and fetch latest merged state.
  - Body: `{ org_id, user_id, device_id, sections: [{ name, version, hash, body }] }`
  - Response: `{ merged: [{ name, version, body, merged_by, timestamp }], your_changes_applied: bool }`
  - Rate limit: 10/min per user.
  - Notes: Uses vector clocks for conflict detection; `merged_by` field reveals which peer won the merge.

- **GET /genome/:org_id/:section_name** — Poll for latest section (long-poll, 30s timeout).
  - Response: `{ version, hash, body, updated_by_user_id, timestamp }`
  - Rate limit: 30/min per user (cheap).

- **POST /genome/propose** — Queue a proposal without merging (for async review).
  - Body: `{ org_id, user_id, section_name, body, rationale }`
  - Response: `{ proposal_id, queued_at }`
  - Rate limit: 5/min per user.

### 3.2 Cross-Machine Stats Sync

Upload periodic snapshots; server aggregates and publishes leaderboard + badges.

- **POST /stats/upload** — Client uploads local `~/.ashlr/stats.json` snapshot (opt-in).
  - Body: `{ user_id, machine_id, timestamp, stats: { tools: { [tool_name]: { calls, tokens_saved } }, sessions: int } }`
  - Response: `{ received_at, next_sync_in_ms }`
  - Rate limit: 1/hour per machine.
  - Privacy: No paths, cwds, or file contents; only tool counts and token sums.

- **GET /stats/user/:user_id** — User's own aggregated stats (7d, 30d, all-time).
  - Response: `{ user_id, machines: int, lifetime_tokens_saved, rank_percentile, badges }`
  - Rate limit: 60/min per user.

- **GET /stats/leaderboard?limit=100&period=7d** — Public anonymous leaderboard.
  - Response: `[{ rank, tokens_saved, is_you: bool }]` (user_id hashed; ties broken by earliest timestamp).
  - Rate limit: 60/min (global).

- **POST /badge/refresh** — Trigger manual badge SVG update (normally auto-triggered on stats/upload).
  - Response: `{ badge_url, next_refresh_in_ms }`
  - Rate limit: 5/min per user.

### 3.3 Cloud LLM Summarizer

Stateless wrapper around inference endpoints.

- **POST /llm/summarize** — Summarize a code diff, log tail, or arbitrary text.
  - Body: `{ user_id, model: "haiku" | "gemini-flash" | "local", prompt, context, max_tokens }`
  - Response: `{ text, model_used, tokens_in, tokens_out, cached: bool }`
  - Rate limit: 100/hour per user (based on model choice + token cost).
  - Notes: Routes to Anthropic Haiku → Gemini Flash → local Ollama (fallback), based on availability + user tier.

### 3.4 Hosted Badge

Auto-updating SVG at `https://ashlr.ai/u/<user>/badge.svg`.

- **GET /u/:user_hash/badge.svg** — CDN-cached SVG (5-min TTL) showing tokens saved + rank.
  - Response: SVG with lifetime tokens saved, rank percentile, updated timestamp.
  - Rate limit: none (static content, CDN-served).

### 3.5 Policy Packs

Teams upload allow/deny lists; server pushes to members via polling endpoint.

- **POST /policies/upload** — Org admin uploads YAML policy pack.
  - Body: `{ org_id, admin_id, policies: { allow_tools: [...], deny_paths: [...], enforce_genome_review: bool } }`
  - Response: `{ policy_id, version, members_notified_at }`
  - Rate limit: 5/day per org.

- **GET /policies/for-org/:org_id** — Fetch latest policy pack for org.
  - Response: `{ policy_id, version, policies: {...}, updated_by, timestamp }`
  - Rate limit: 20/min per user.

### 3.6 Audit Log

Immutable append-only log of non-read ashlr tool invocations.

- **POST /audit/log** — Append a tool invocation event (client-initiated; optional).
  - Body: `{ user_id, org_id, tool_name, args_hash, git_sha, status: "ok" | "error", tokens }`
  - Response: `{ event_id, committed_at }`
  - Rate limit: none (dropped if burst > 100/sec; client-side buffering ok).

- **GET /audit/org/:org_id** — Org admin exports audit log (CSV, JSON, parquet).
  - Query: `?start_date=ISO&end_date=ISO&tool_filter=grep&format=json`
  - Response: `{ events: [...], total_tokens, date_range }`
  - Rate limit: 5/hour per org (export is expensive).

---

## 4. Data Model

Core Postgres tables (DDL):

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY,
  clerk_id TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  pro_tier TEXT DEFAULT 'free', -- 'free' | 'team' | 'enterprise'
  stripe_customer_id TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE orgs (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  tier TEXT DEFAULT 'team',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE memberships (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  user_id UUID NOT NULL REFERENCES users(id),
  role TEXT DEFAULT 'member', -- 'owner' | 'admin' | 'member'
  invited_by UUID REFERENCES users(id),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(org_id, user_id)
);

CREATE TABLE genome_sections (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  section_name TEXT NOT NULL,
  version BIGINT DEFAULT 0,
  body_s3_key TEXT NOT NULL,
  hash TEXT NOT NULL,
  merged_by_user_id UUID REFERENCES users(id),
  merged_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(org_id, section_name)
);

CREATE TABLE genome_versions (
  id UUID PRIMARY KEY,
  section_id UUID NOT NULL REFERENCES genome_sections(id),
  version BIGINT NOT NULL,
  author_user_id UUID NOT NULL REFERENCES users(id),
  author_device_id TEXT NOT NULL,
  body_s3_key TEXT NOT NULL,
  vector_clock JSONB NOT NULL, -- { [device_id]: version_num, ... }
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(section_id, version)
);

CREATE TABLE stats_uploads (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  machine_id TEXT NOT NULL,
  tool_stats JSONB NOT NULL, -- { 'tool_name': { calls: int, tokens_saved: int }, ... }
  session_count INT DEFAULT 0,
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, machine_id, uploaded_at)
);

CREATE TABLE policy_packs (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  admin_id UUID NOT NULL REFERENCES users(id),
  policies JSONB NOT NULL, -- { allow_tools: [...], deny_paths: [...], ... }
  version BIGINT DEFAULT 1,
  published_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  user_id UUID NOT NULL REFERENCES users(id),
  tool_name TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  git_sha TEXT,
  status TEXT DEFAULT 'ok',
  tokens INT DEFAULT 0,
  logged_at TIMESTAMPTZ DEFAULT NOW()
);
-- WORM: append-only, no deletes. Partition by month for retention.

CREATE TABLE badges (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) UNIQUE,
  tokens_saved_lifetime INT DEFAULT 0,
  rank_percentile FLOAT DEFAULT 0.0,
  badge_html TEXT NOT NULL,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_stats_uploads_user_ts ON stats_uploads(user_id, uploaded_at DESC);
CREATE INDEX idx_audit_events_org_ts ON audit_events(org_id, logged_at DESC);
CREATE INDEX idx_genome_sections_org ON genome_sections(org_id);
CREATE INDEX idx_memberships_org ON memberships(org_id);
```

---

## 5. Client Integration

The plugin uses three new environment variables:

- `ASHLR_PRO_TOKEN` — Clerk JWT token. If absent, all pro features are disabled.
- `ASHLR_API_URL` — Optional override; defaults to `https://api.ashlr.ai`.
- `ASHLR_STATS_OPT_IN` — Boolean; controls whether stats are uploaded (default false, explicit opt-in required).

**Gate logic** (in plugin's HTTP client):
```typescript
if (!process.env.ASHLR_PRO_TOKEN) {
  // Fall back to local-only mode: no genome sync, no stats, no cloud LLM.
  return fallbackToLocal();
}
const baseURL = process.env.ASHLR_API_URL || 'https://api.ashlr.ai';
const headers = { Authorization: `Bearer ${process.env.ASHLR_PRO_TOKEN}` };
```

**Genome sync integration**: Before consolidating local proposals, call `POST /genome/sync` with pending sections. Merge remote changes into the local genome before applying hooks. If sync fails (auth or network), warn and fall back to local-only merge.

**Stats sync integration**: Background task (1/hour, opt-in) uploads snapshot of `~/.ashlr/stats.json` to `POST /stats/upload`. On success, update `stats.json` with `last_sync_at`. No blocking; failures are logged to `~/.ashlr/errors.jsonl` but don't halt the CLI.

**Cloud LLM integration**: In `_summarize.ts`, detect `ASHLR_PRO_TOKEN` presence. If set, call `POST /llm/summarize` instead of spawning local Ollama. Fallback to local if cloud call fails or returns 429.

---

## 6. Privacy + Security

**Genome sync**: Sections are encrypted client-side (AES-256-GCM) using a user-held key before upload. Server stores encrypted bodies in S3. Only the org members who hold the key can decrypt. No key material ever sent to the server; the `hash` field lets the server detect replays and version skew without decrypting.

**Stats sync**: 
- Never log paths, cwds, git repos, or filenames.
- Only upload tool names + call counts + token totals.
- User_id is visible to the user's own account; on leaderboard, user_id is hashed (SHA256) and never tied to email.
- Machines are tracked by `machine_id` (UUID generated at first sync); supports multi-device use without tracking physical identity.

**Audit log**:
- Append-only (no deletes, no updates). Dropped events are logged separately.
- Per-org isolation; only org members with `admin` role can export.
- Git SHA linkage lets auditors trace a tool invocation to a commit.
- Exports are available in JSON, CSV, and Parquet (via local DuckDB on demand).

**PII**:
- No PII collected except email (Clerk-managed, used only for Stripe invoicing and password reset).
- Stripe invoices are generated server-side; customer never sees an API key.
- Session logs and stats uploads are anonymous by design.

**Threat model**:
- **SSRF**: Cloud LLM endpoint is hardcoded; no user-supplied URLs. Proxy runs in a VPC with egress filtering.
- **SQL injection**: Hono + standard parameterized queries (no string interpolation).
- **Tenant isolation**: Org-based queries always include `org_id` filter; no cross-org data leakage.
- **Rate limits**: Redis sliding-window counter; 429 on limit exceeded.
- **Replay attacks**: Vector clocks + hashes prevent genome version replays. Nonce in stats uploads prevents duplicate-count inflation.
- **Credential disclosure**: `ASHLR_PRO_TOKEN` is a short-lived Clerk JWT (15 min TTL); client auto-refreshes. No long-lived API keys.

---

## 7. Cost Model

**Assumptions**: 100 / 1K / 10K active users, average usage 50 tool calls/session, 10 sessions/month, 10KB avg genome section size.

**Per-user infra cost**:
| Layer | 100 users | 1K users | 10K users |
|-------|-----------|----------|-----------|
| Postgres (Neon, serverless) | ~$0.50 | ~$5 | ~$30 |
| S3 (genome bodies, stats backups) | ~$0.10 | ~$1 | ~$8 |
| Redis (rate limits, cache) | $20/mo shared | $20/mo shared | $50/mo |
| Cloud LLM (Haiku, 50 summaries/user/mo @ $0.80/1M tokens) | ~$0.20 | ~$2 | ~$20 |
| Bandwidth / misc | ~$0.20 | ~$2 | ~$15 |
| **Total / user** | ~$0.81/user | ~$0.10/user | ~$0.012/user |

**Team tier pricing** (20–500 user seats): $500–2K/month flat-rate + $5/seat for seats over 20. At 100 users, profit margin ~40%.

**Enterprise tier**: Custom metering (audit log export, policy enforcement, SSO). Assumes 3–5 large customers at $10K–50K/year each.

---

## 8. Build Phases

**Phase 1: Badge service + stats sync (1 week).**
- MVP with `POST /stats/upload`, `GET /stats/user`, `GET /stats/leaderboard`.
- Auto-refreshing badge SVG in Neon + Redis.
- Plugin integration: background stats sync every 1 hour.
- Risk: Low. Validation: public leaderboard has >50 users; badge renders on plugin landing page.

**Phase 2: Cloud LLM summarizer (1 week).**
- Routing wrapper around Haiku, Gemini Flash, local Ollama.
- Rate limiting per token cost (not per call).
- Risk: Vendor API changes. Validation: 99% uptime SLO; fallback to local Ollama works.

**Phase 3: Genome sync with CRDT (2 weeks).**
- S3 storage for section bodies.
- Vector clock merging; conflict detection.
- Client encryption (AES-256-GCM).
- Risk: High (CRDT complexity, key rotation). Validation: Team of 5 syncs genome across 10 devices; all merges resolve correctly.

**Phase 4: Policy packs + audit log (1 week).**
- YAML parsing, WORM storage.
- Org admin export.
- Risk: Moderate (WORM constraints, retention). Validation: Export audit log; verify no data loss across 1-month run.

**Phase 5: Leaderboard UI + badge embeds (3 days).**
- Static HTML page at `ashlr.ai/leaderboard`.
- Markdown embed snippet for GitHub profiles, blogs.
- Risk: Low. Validation: Leaderboard loads in <1s; 100K requests/day without CDN tuning.

---

## 9. Open Questions

1. **Genome sync encryption**: Client-side AES-256-GCM vs. server-side with customer-managed keys (CMK in AWS KMS)? CMK is more durable but adds latency and ops complexity.

2. **Stats retention**: Keep all stats uploads forever (cost ~$1/10K users/month in Postgres)? Archive to cold storage (Glacier) after 1 year? Or aggregate daily and drop raw data?

3. **Audit log SLA**: Is append-only WORM required for regulatory (SOC 2)? If yes, adds replication/backup burden. If optional, simpler to design.

4. **LLM fallback**: What happens if Haiku quota is exhausted and Gemini is also down? Serve a cached summary from Redis, or fail the request?

5. **Cross-org genome**: Can orgs share genome sections (e.g., public reference docs)? Adds multi-tenancy complexity; deferred to Phase 3.1.

6. **Policy pack versioning**: When an org updates policies, do existing jobs (e.g., autonomous agents) re-run under the new policy? Or only new jobs? Needs clarification from product.

7. **Badge CSS**: SVG vs. HTML+CSS vs. Markdown embed with image tag? SVG is simplest; Markdown link is most portable.

8. **Free tier rate limits**: Do free-tier users get stats sync at all? Current design assumes opt-in pro token, so free tier is local-only by default.

9. **Stripe dunning**: After trial expiry or payment failure, what's the grace period before genome/stats sync is disabled? 7 days? 14 days?

10. **Multitenancy overhead**: One Postgres instance per org, or one instance with `org_id` sharding? Shared instance is cheaper; per-org is simpler compliance. Recommend shared for Phase 1–2, re-evaluate at Phase 4.

---

## 10. Hardest Architectural Decisions

### Decision 1: Shared Postgres vs. Per-Org Instance
**Options**: (A) One Postgres with `org_id` sharding, (B) One instance per org, (C) Postgres for metadata, per-org blob-store silo.

**Recommendation**: (A) — Shared Postgres with `org_id` index on every table.

**Rationale**: 
- At 100–1K users, per-org instances would cost 3–10x more.
- Shared instance is sufficient for row-level security; Postgres policies can enforce `org_id` checks at the query level.
- Migration to (B) later is tractable (shard by org_id at application layer, then split at DB layer).
- Georeplication is easier on one instance; hot-standby failover is automatic with Neon.

---

### Decision 2: CRDT vs. Last-Write-Wins for Genome Merge
**Options**: (A) Vector clocks + CRDT algorithm (e.g., YATA), (B) Last-write-wins with user-visible conflict resolution UI, (C) Server-authoritative with client lock.

**Recommendation**: (A) — Vector clocks + deterministic merge (e.g., lexicographic tiebreak on author_id).

**Rationale**:
- Genome is semi-structured (JSON sections); CRDT avoids data loss and user confusion.
- Vector clocks are simpler than operational transforms and easier to explain to users.
- LWW (B) or server-lock (C) would require UI complexity or leader bottleneck; defeats the purpose of decentralized team editing.
- Risk: CRDT implementation bugs; mitigate with property-based tests (QuickCheck-style).

---

### Decision 3: Client-Side Encryption vs. Server-Side with CMK
**Options**: (A) AES-256-GCM, client holds key (no key escrow), (B) AES-256-GCM, server-side key rotation via AWS CMK + audit log, (C) TLS-in-transit only (no rest encryption).

**Recommendation**: (A) — Client-side AES-256-GCM, key derived from Clerk JWT + org_id.

**Rationale**:
- Simpler to audit: no server-side key material, no key rotation ceremony.
- Clerk JWT is already encrypted; using it as a key-derivation input avoids a new secret store.
- Server never decrypts sections; only hashes are visible (enables dedup, version detection).
- Trade-off: If user loses Clerk JWT, they lose access to encrypted sections. Mitigate with recovery code + offline backup.

---

### Decision 4: Append-Only Audit Log vs. Aggregated Events
**Options**: (A) WORM append-only (each tool call = one row; immutable), (B) Daily aggregates (tokens + tool counts, mutable), (C) Hybrid (last 30 days append-only, older data aggregated).

**Recommendation**: (A) — Full WORM append-only; add retention policy (delete rows older than 7 years).

**Rationale**:
- Audit log is a compliance artifact; WORM is the standard.
- Aggregates hide information (e.g., which user ran which tool at what time); defeats compliance value.
- Cost is acceptable (one row per tool invocation; 10–100K rows/day for 1K users).
- Partition by month and archive old partitions to cold storage (Glacier) for retention.

---

### Decision 5: Polling vs. WebSocket for Genome Sync
**Options**: (A) Long-poll (HTTP GET with 30s timeout), (B) WebSocket duplex, (C) Server-sent events (SSE).

**Recommendation**: (A) — Long-poll with exponential backoff.

**Rationale**:
- Stateless: Long-poll doesn't require server to maintain connection state; scales to 10K+ concurrent users easily.
- Simple: Aligns with Hono's request-response model; no special handling needed.
- Mobile-friendly: Long-poll works over cellular with retries; WebSocket connection drops are expensive.
- SSE is a middle ground, but browsers have fewer SSE libraries and CDN support is weaker than HTTP.

---

### Decision 6: Stripe Checkout vs. Metered Billing
**Options**: (A) Checkout for subscription (flat monthly or per-seat), (B) Metered billing (post-usage aggregation), (C) Hybrid (flat + metered overage).

**Recommendation**: (A) — Subscription (flat $500–2K/month + $5/seat) for team tier; separate enterprise contract for metered custom features.

**Rationale**:
- Team tier is SMB-focused; predictable per-seat cost is easier to sell.
- Metered (B) introduces invoice surprise and requires real-time usage sync; adds complexity.
- Hybrid (C) is a third option but creates edge cases (what if usage is 2x over?).
- Enterprise (custom) tier handles edge cases (high-volume policy enforcement, audit log queries).

---

### Decision 7: Redis vs. Postgres for Rate Limits
**Options**: (A) Redis sliding-window counter, (B) Postgres with advisory locks, (C) In-memory token bucket per server (no shared state).

**Recommendation**: (A) — Redis sliding-window.

**Rationale**:
- Redis is O(1) per limit check; Postgres + locks adds latency.
- Sliding window is more accurate than fixed buckets; edge case: request at limit boundary is handled fairly.
- In-memory (C) doesn't work for distributed app; requires load-balancer affinity or consistent hashing.
- Redis ttl auto-cleanup reduces memory bleed.

---

### Decision 8: S3 vs. Postgres for Genome Section Bodies
**Options**: (A) Store full section bodies in Postgres BYTEA, (B) Store in S3, reference via `body_s3_key`, (C) Hybrid (small bodies in Postgres, large in S3).

**Recommendation**: (B) — S3 for all sections.

**Rationale**:
- Sections can be large (50KB+); storing in Postgres inflates WAL and backup size.
- S3 is cheaper per GB ($0.023/month) than Postgres ($0.50+/month).
- Cache busting is simpler: `body_s3_key` includes a hash; old versions are automatically unreferenced (S3 lifecycle policies delete after 30 days).
- Integrity: ETag on S3 object matches hash in `genome_sections.hash`; prevents corruption.

---

### Decision 9: Single Stripe Account vs. Reseller Model
**Options**: (A) ashlr.ai holds Stripe account; users pay ashlr directly, (B) Orgs hold their own Stripe accounts (reseller/whitelabel), (C) Hybrid (ashlr standard, opt-in self-billing for enterprise).

**Recommendation**: (A) — Single Stripe account owned by ashlr.ai.

**Rationale**:
- Simpler to implement; no certificate signing or connected-account complexity.
- Pricing is transparent and centralized.
- Orgs don't have to manage Stripe; reduces friction at signup.
- Enterprise tier (C) can be added later if customers demand white-label invoicing.

---

### Decision 10: Real-Time Badge Refresh vs. Batch Hourly
**Options**: (A) Update badge SVG immediately on stats upload (slow path in request), (B) Batch job (every 1 hour), (C) Lazy (update on first request after stats upload).

**Recommendation**: (B) — Batch job (cron) every 15 minutes.

**Rationale**:
- Real-time (A) adds latency to stats-upload request (slow path); stats are non-critical, so users won't tolerate >100ms delay.
- Batch (B) is predictable; `redis-del` old badge, compute new badge, `redis-set` with 15m expiry. Leaderboard changes are visible within 15m.
- Lazy (C) is fine but requires stats-upload request to notify the batch job; adds coupling.
- 15 min is a compromise: frequent enough for GitHub embeds to feel live, infrequent enough to not thrash Redis.

---

## End Notes

This architecture is defensible for 10K active users and < $50K/month infra spend. Beyond that, shard by org, add read-replicas, and consider denormalization (aggregate tables) for leaderboard queries. The CRDT and encryption plumbing are the highest-risk items; build Phase 1 (badge + stats) to validate the basic backend infrastructure before committing to Phase 3.
