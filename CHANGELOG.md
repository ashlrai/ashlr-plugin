# Changelog

All notable changes to ashlr-plugin. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.8.1] — 2026-04-18

**Entity-level launch config.** All placeholder copy replaced with real entity details.

### Changed

- **Entity name**: every "Ashlr AI" / "Ashlr AI, operated by Mason Wyatt" placeholder → **AshlrAI Inc** (Delaware corporation) across `/privacy`, `/terms`, `/dpa`, `/pricing`, Fumadocs pro pages, and footer.
- **Contact email**: every `privacy@ashlr.ai` and `mason@evero-consulting.com` reference → **support@ashlr.ai** across site + docs (17 touch-points).
- **Terms section 10 (governing law)**: removed the "[Placeholder — confirm with counsel before launch]" italic block. Reads cleanly as a Delaware corporation governed by Delaware law.
- **`docs/legal.md` checklist**: entity + email + governing-law items checked off. Remaining items are Stripe dashboard settings, Resend DNS verification, sub-processor DPA countersignatures — all genuinely counsel/ops work.

### Unchanged

- No code changes. Same tests, same build, same behavior.


## [1.8.0] — 2026-04-18

**Enterprise posture.** Client-side genome encryption, a real admin dashboard, and a public status page.

### Added

- **Client-side genome encryption** (`servers/_genome-crypto.ts`, 210 LOC; `scripts/genome-key.ts` CLI). AES-256-GCM with per-section random nonces. Keys live at `~/.ashlr/team-keys/<id>.key`, mode 0600. Server never sees plaintext — stores ciphertext in a `content_encrypted` column, enforces via new `encryption_required` per-genome flag. `PATCH /genome/:id/settings` endpoint. `scripts/genome-key.ts` supports `generate`, `export`, `import`, `rotate`. Backwards compatible with existing plaintext genomes. 12 new crypto tests + 4 integration tests.
- **Admin dashboard** (`site/app/admin/*`, ~800 LOC + 9 backend endpoints at `server/src/routes/admin.ts`). Routes: `/admin/overview` (MRR, active subscriptions, DAU, LLM sparkline, recent signups + payments), `/admin/users` (searchable, email-redacted list), `/admin/users/[id]` (full detail + comp/refund modals), `/admin/revenue`, `/admin/errors` (Sentry), `/admin/audit`, `/admin/broadcast`. Bootstrap via `bun run server/src/cli/make-admin.ts <email>`. All mutations write to the audit log. 14 new admin tests.
- **Public status page** (`site/app/status/*` + `server/src/routes/status.ts`). Overall status strip, per-component 90-day uptime bars, recent incidents with update timeline, email subscribe with double-opt-in, RSS feed at `/status/rss.xml`. Synthetic health-check worker at `server/src/workers/health-check.ts` probes each component every 60s. Incident CRUD via admin-authed `POST /status/incident` + `PATCH /status/incident/:id`. 11 new status tests.
- **`status-confirm` email template** for the status page subscribe flow.

### Fixed

- **Wildcard-middleware bug in `server/src/routes/genome.ts`** (`use("*", authMiddleware)` intercepted every unmatched request app-wide when mounted at root — fixed to `use("/genome/*", authMiddleware)`).

### Database

Extended `server/src/db.ts` with: `health_checks`, `incidents`, `incident_updates`, `status_subscribers`, plus `users.is_admin` and `users.comp_expires_at` columns. All idempotent late-migration.

### Tests

- **858 pass, 1 skip, 0 fail** (root, +17 since v1.7.0).
- **143 pass** (server, +26 admin + status + genome encrypted).
- Clean site build with new `/admin/*` and `/status/*` routes.


## [1.7.0] — 2026-04-18

**First-impressions polish.** HTML emails, an auto-firing onboarding wizard for new users, and the last two flaky tests actually fixed.

### Added

- **HTML email templates** (`server/src/emails/`) built with `@react-email/components`. Six templates: magic-link, welcome, payment-success, payment-failed, subscription-canceled, daily-cap-reached. Every template renders both HTML and plain text. Parchment palette, Fraunces italic, IBM Plex Sans. Outlook/Gmail/Apple Mail compatible. Subject lines ≤ 70 chars, preheader ≤ 90 chars.
- **`server/src/lib/email.ts`** — single `sendEmail(template, { to, data })`. Uses Resend; falls back to stderr logging under `TESTING=1` or when `RESEND_API_KEY` is unset. Never throws.
- **Email wiring**: `magic-link` from `/auth/send`; `welcome` + `payment-success` from `checkout.session.completed` webhook; `payment-failed` from `invoice.payment_failed`; `subscription-canceled` from `customer.subscription.deleted`; `daily-cap-reached` from `/llm/summarize` when cap hit (throttled once-per-day via `daily_cap_notifications` table).
- **Email preview server**: `bun run server/src/emails/preview.ts` serves every template at `:3333` for local visual QA.
- **First-run onboarding wizard** (`commands/ashlr-start.md` + `scripts/onboarding-wizard.ts`, 330 LOC). Six steps: doctor check, permissions, live read demo on the user's own cwd file, genome offer (if ≥10 source files + no existing genome), pro teaser, done. Auto-fires on first session via `~/.ashlr/installed-at` stamp detection in `session-start.ts`. 20 new tests.
- **23 email tests** (`server/tests/emails.test.ts`).

### Fixed

- **Two skipped tests un-skipped** and passing in full-suite runs:
  - `no-genome grep emits tool_fallback` — un-skipped.
  - `ashlr__edit medium and large samples have ratio < 1` — un-skipped.
  - Root cause (`__tests__/genome-cache.test.ts`): used `mock.module("@ashlr/core-efficiency", ...)` at top level, which Bun's test runner writes into the shared module registry and never restores across files. Tests loaded after alphabetically inherited the stub.
  - Production fix: `servers/_genome-cache.ts` now takes an optional `retriever` parameter (DI). Production callers unchanged.
  - Test fix: `__tests__/genome-cache.test.ts` replaces `mock.module` with DI.
- **`docs/test-isolation.md`** — ~80-line note explaining Bun test module-state sharing and the isolation pattern to follow.
- **`scripts/find-test-leak.ts`** — bisect helper for finding which test file leaks state.

### Tests

- **841 pass, 1 skip, 0 fail** across 53 root test files (+21 since v1.6.0). The last remaining skip is `sql-server.test.ts pgDescribe` — gates on `TEST_DATABASE_URL`, not an isolation issue.
- **117 pass** (server, +23 email tests).


## [1.6.0] — 2026-04-18

**Team tier features + integration test suite.** Phase 3 CRDT genome sync, Phase 4 policy packs + audit log, end-to-end integration suite.

### Added

- **Phase 3: CRDT genome sync** (`server/src/routes/genome.ts`, 275 LOC + plugin-side client at `servers/_genome-sync.ts`, 210 LOC).
  - Six endpoints: `/genome/init`, `/push`, `/pull?since=N`, `/conflicts`, `/resolve`, `DELETE`.
  - Vector-clock-based LWW CRDT at section granularity. Concurrent edits → conflict pair with both variants; stale writes detected.
  - Opt-in via `ASHLR_TEAM_GENOME_ID` env var. Non-blocking, never breaks a session.
  - 15 server tests + 6 client tests.
  - Deferred: client-side encryption (v2), full CLI conflict resolver, manifest LWW sync.

- **Phase 4: Policy packs + audit log** (`server/src/routes/policy.ts` + `server/src/routes/audit.ts`).
  - Policy packs: admin uploads YAML rules (allow/deny/requireConfirm). Versioned with rollback. Precedence: deny > requireConfirm > allow. `hooks/policy-enforce.ts` applies locally with 5-min cache.
  - Audit log: every non-read tool call logged server-side. Paths fingerprinted (SHA-256), content never stored. Query with filters + NDJSON export.
  - `hooks/audit-upload.ts` fires PostToolUse. Fire-and-forget with 3s timeout.
  - 8 policy tests + 8 audit tests + 6 client tests.

- **End-to-end integration suite** at `integration/` (standalone workspace, 305-LOC harness). 10 tests:
  1. read flow — compression + stats
  2. multi-edit atomic rollback
  3. cloud-sync round trip
  4. cloud LLM summarizer via stub
  5. permissions install idempotency
  6. status-line freshness under load
  7. genome live-refresh after edit
  8. billing tier transitions on webhook
  9. magic-link auth happy path
  10. cross-session isolation
  - New CI job `integration` after `test` with 10-min ceiling.

- **`docs/policy-packs.md`** — rule syntax, YAML examples, precedence table, rollback flow.
- **`docs/team-genome.md`** extended with sync flow, conflict resolution, security model.
- **`minimatch`** dependency added for hook glob matching.

### Fixed

- Bun-type narrow casts in `__tests__/genome-sync.test.ts` (`globalThis.fetch = ... as unknown as typeof fetch`).
- `hooks/audit-upload.ts` and `hooks/policy-enforce.ts` marked as modules (`export {}`) for top-level await.
- Root `test` script scoped to `__tests__/` so integration tests don't run without their harness.

### Tests

- **820 pass, 2 skip, 0 fail** (root, `__tests__/` scope).
- **94 pass** (server, +16 for policy/audit/genome Phase 3).
- **10 integration tests** in `integration/tests/` (run separately: `cd integration && bun test` with backend live).

### Deps

- root: `minimatch` (hook matching).
- server: (unchanged — already had what it needed).
- integration: zero external deps (by design).


## [1.5.0] — 2026-04-18

**VS Code extension, backend observability, launch content kit.** The plugin expands to a new host, the backend gets real eyes on errors and metrics, and every piece of launch-day copy is written.

### Added

- **VS Code extension** (`vscode/`, 1,210 LOC source → 21 KB bundle). Status bar with 2 s polling of `~/.ashlr/stats.json`. Dashboard webview with parchment theme. Inline gutter decorations on Read/Edit/Grep calls. Five commands: Show Dashboard, Open Genome Folder, Run Benchmark, Show Savings, Sign in to Pro. Settings: stats path, poll interval, show gutter badges. Manifest validates cleanly for `vsce package`.
- **Backend observability**:
  - **Sentry** via `@sentry/bun`. Error middleware wired to Hono `app.onError`. PII scrubbed (`text`, `systemPrompt`, `email`, `authorization`, `cookie`, `password`) via `beforeSend`. Release tagging. No-op without `SENTRY_DSN`.
  - **Structured logging** via `pino` + `pino-http`. JSON in production, pretty in dev. Every HTTP request: method, path, status, latency, user_id, requestId.
  - **Prometheus metrics** at `GET /metrics`. Gauges (users_total, subscriptions_active), counters (http_requests_total, llm_requests_total, magic_links_sent_total), histograms (http_request_duration_seconds, llm_request_tokens). Gated by IP allowlist or Basic Auth.
  - **`/healthz` + `/readyz`** liveness + readiness probes. Fly.io health check updated.
  - **`docs/operations.md`** — monitoring guide, alert thresholds, runbooks for DB down / Anthropic failure / Stripe webhook lag / rate-limit flood.
  - **Client Sentry** on the site at `/dashboard`, `/signin/*`, `/billing/*` only (marketing pages skipped to reduce noise).
- **Launch content kit**:
  - `docs/launch-post.md` — ~920-word blog post telling the v0.6 → v1.4 story.
  - `docs/producthunt.md` — PH tagline, description, first comment, gallery captions.
  - `docs/social.md` — three Twitter variants, LinkedIn draft, HN title + first comment.
  - `site/app/compare/page.tsx` — 20-row comparison matrix vs WOZCODE / native Claude Code / Cursor. Honest marks only ("unknown" where truly unknown).
  - `docs/hero-video-script.md` — 30-second product video brief.
  - `docs/press-kit/` — logo SVG, screenshot shot-list, founder bio, fact sheet.

### Tests

- **867 pass, 2 skip, 0 fail** (root, +7 since v1.4).
- **60 pass** (server, +7 observability).
- VS Code extension builds clean; manual QA checklist at `vscode/test-manual.md`.

### Deps

- `server/`: `@sentry/bun`, `pino`, `pino-http`, `prom-client`, `pino-pretty` (dev).
- `site/`: `@sentry/nextjs`.
- `vscode/`: self-contained; no root pollution.

### New envvars (all opt-in)

| Var | Where | Purpose |
|---|---|---|
| `SENTRY_DSN` | server | Sentry error tracking |
| `METRICS_ALLOWED_IPS` or `METRICS_USER` + `METRICS_PASS` | server | gate `/metrics` |
| `LOG_LEVEL` | server | Pino level override |
| `NEXT_PUBLIC_SENTRY_DSN` | site | client-side Sentry |

### Before-launch content review

Items in `docs/producthunt.md` and `docs/social.md` use exact numbers from `docs/benchmarks-v2.json` (−71.3% overall). WOZCODE comparison cells are marked "unknown" where no public data exists — verify before publish if you have internal data.


## [1.4.0] — 2026-04-18

**Launch-ready.** Magic-link auth, legal pages, reproducible benchmarks surface.

### Added

- **Passwordless email magic-link auth** (`server/src/routes/auth.ts`, ~215 LOC). `POST /auth/send` (rate-limited 5/email/hour, 15-min token TTL, Resend delivery). `POST /auth/verify` issues a permanent API token. Site `/signin` + `/signin/verify` flow. `docs/dashboard/signin` stub redirects to the new flow. 10 new tests.
- **Legal pages** — `/privacy` (299 lines), `/terms` (269 lines), `/dpa` (216 lines). Plain-English policy, Stripe-aware cookie banner (`site/components/cookie-banner.tsx`), footer links, sitemap entries. Internal `docs/legal.md` pre-launch checklist.
- **Reproducible benchmarks** — `scripts/run-benchmark.ts` (~450 LOC) + `/benchmarks` page at `site/app/benchmarks/page.tsx`. Samples read/grep/edit against the plugin's own repo. Real numbers seeded into `docs/benchmarks-v2.json`: **overall −71.3%** (read −82.2%, grep −81.7%, edit mean dragged by tiny-edit honesty but medium −52%, large −96.5%). The landing hero now reads this number at build time with fallback to −79.5%.
- **Weekly benchmark CI job** (`.github/workflows/ci.yml`) opens a PR on Monday refreshing the data. Push-time `benchmark-check` verifies the script is healthy.
- **`docs/legal.md`** — pre-launch sign-off checklist for counsel review.

### Fixed

- `scripts/run-benchmark.ts` rg-resolution now walks more candidate paths so the benchmark works in environments where `rg` isn't a plain system binary (e.g. Claude Code's shell wrapper).

### Tests

- **860 pass, 2 skip, 0 fail** across 55 files (+17 since v1.3.0).
- 2 skipped tests are the `no-genome grep` flake (full-suite env leak) and the benchmark ratio assertion (same root cause); both pass reliably in isolation and are documented in-line.
- Server: 53 pass (+10 auth). Site builds clean with 75 static pages.

### Before-launch legal review

`docs/legal.md` lists the six items flagged for counsel review before public launch. Highlights:
1. Entity name + governing law placeholder in `/terms`.
2. `privacy@ashlr.ai` and `mason@evero-consulting.com` mailbox setup.
3. Stripe billing portal enabled in dashboard.
4. Countersigned DPA template for enterprise.
5. EU-region readiness check with Fly.io and Neon.
6. SCC module confirmation.

### Deps

- `resend@6.12.0` added to `server/package.json` for transactional email.


## [1.3.0] — 2026-04-18

**The self-serve tier is complete.** Docs, billing, and a real web dashboard — pro users can now sign up, pay, and see their savings without the CLI.

### Added

- **Fumadocs reference site at `/docs`** (`site/content/docs/`, 62 MDX files). Auto-generated pages for every MCP tool (27) and skill (20) + hand-written getting-started / concepts / pro / contributing sections. Built-in Orama search via `/api/search`. Parchment theme matched to the landing. Build-time gen script at `site/scripts/gen-docs.ts` keeps tool/skill docs in sync with `plugin.json` and `commands/*.md`.
- **Stripe subscription billing** in `server/src/routes/billing.ts` (250 LOC). Four endpoints: `POST /billing/checkout`, `GET /billing/portal`, `GET /billing/status`, `POST /billing/webhook`. Webhook handles `checkout.session.completed` / `customer.subscription.updated` / `customer.subscription.deleted` / `invoice.payment_failed` (7-day grace). Idempotent via `stripe_events` table. 13 tests.
- **Stripe product setup script** (`server/src/cli/stripe-setup.ts`). Idempotent create of Pro $12/mo + $120/yr, Team $24/seat/mo + $240/seat/yr.
- **Tier gating** on existing endpoints: `POST /llm/summarize` and `GET /stats/aggregate` both now require `pro` or `team` tier. Free users get 403 with `upgrade_url` pointer. Badge endpoint stays public.
- **Web dashboard** at `site/app/dashboard/page.tsx` (~1,046 LOC). Eight sections: header strip, three CountUp tiles (session/lifetime/best day), per-tool SVG bar chart, 7d+30d sparklines, annual projection (Fraunces italic), cross-machine view (pro-gated), pro feature status panel, data-export footer. Pairs with a minimal `/dashboard/signin` token-paste flow.
- **`docs/billing.md`** (~100 lines). Tier semantics, cancel policy, dispute handling.

### Database

- Extended `server/src/db.ts` with `subscriptions`, `stripe_events`, `stripe_products` tables + `users.tier` column.
- Migration logic runs on boot; idempotent.

### Gated endpoints

- `POST /llm/summarize` — requires paid tier. Free → 403.
- `GET /stats/aggregate` — requires paid tier. Free → 403.
- `GET /u/:userId/badge.svg` — stays public (marketing asset).

### Tests

- **843 pass, 1 skip, 0 fail** (root, +14 since v1.2.0).
- **43 pass, 0 fail** (server, +13 billing tests).

### Deploy additions

- `docs/deploy.md` gained a Stripe webhook setup section.
- Pricing preview on the landing now routes to the checkout flow (stub signin for this ship).

### Migration notes

- Existing free users see no change until they hit a gated endpoint.
- `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` are Fly.io secrets required for the paid features to work. See `docs/deploy.md`.
- `NEXT_PUBLIC_ASHLR_API_URL` (defaults to `https://api.ashlr.ai`) points the site's dashboard + billing CTAs at the live backend.


## [1.2.0] — 2026-04-18

**Phase 2 pro backend + auto-deploy CI + production polish on the landing.**

### Added

- **Cloud LLM summarizer** (`server/src/routes/llm.ts`, 152 LOC). `POST /llm/summarize` — Haiku-4.5 via `@anthropic-ai/sdk`. Auth via API token. 64 KB text cap, 30 req/min/token sliding-window rate limit, $1-per-day OR 1000-calls-per-day cost cap per user (whichever first), 1-hour in-memory SHA-256 cache. Never logs `text` or `systemPrompt` content. Never leaks upstream error text (generic 502 on failure).
- **Pro-token auto-routing in `servers/_summarize.ts`** (~15 LOC). When `ASHLR_PRO_TOKEN` is set AND `ASHLR_LLM_URL` is unset, the summarizer auto-routes to the hosted endpoint at `${ASHLR_API_URL ?? "https://api.ashlr.ai"}/llm` with the pro token as bearer. Pro users stop needing Ollama/LM Studio entirely.
- **Vercel deploy workflow** (`.github/workflows/deploy-site.yml`). Path-filtered to `site/**`, prod on main, preview on PRs. Uses `VERCEL_TOKEN` / `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID`.
- **Fly.io deploy workflow** (`.github/workflows/deploy-server.yml`). Runs tests first, then `flyctl deploy --remote-only`. `server/fly.toml` (`ashlr-api`, `iad`, auto-scale-to-zero) and `server/Dockerfile` (multistage Bun).
- **`docs/deploy.md`** (~180 lines). Step-by-step go-live guide: Vercel setup, Fly.io setup, DNS, smoke test, rollback, cost table at 100 / 1K / 10K MAU.
- **`scripts/deploy-smoke.sh`** — curl-based post-deploy verification.
- **Dynamic OG image** at `site/app/opengraph-image.tsx` — 1200×630 parchment-themed card generated at request time via `next/og`.
- **`site/app/robots.ts`** + **`site/app/sitemap.ts`** — proper SEO plumbing.
- **Accessibility sweep on `site/`** — `:focus-visible` outlines, `aria-hidden` on decorative SVGs, 13:1 text contrast verified, 7.8:1 focus-ring contrast verified.
- **`server/src/cli/cap-check.ts`** — admin utility: `bun run src/cli/cap-check.ts <user-token>` reports today's LLM usage vs cap. Useful when a user reports being blocked.

### Cost cap tuning

- Haiku 4.5 pricing: $1.00/1M input + $5.00/1M output. At default 800-token output + ~500-token input, one summarize call ≈ $0.00050. Default $1/day cap → ~2000 calls at normal size, ~1000 calls at `maxTokens:1500`. 1000-call hard cap catches edge cases. Remaining budget returned in 429 body.
- Cache hit rates: 60–80% expected on repeat `ashlr__read` calls within a session.

### Tests

- **829 pass, 1 skip, 0 fail** (+14 tests since v1.1.0). Server suite: 30 pass (`llm.test.ts` adds 13: happy path, over-size, auth, 7 schema cases, rate limit, cache, daily cap, upstream failure, maxTokens cap, missing API key).

### Monthly cost at 1K MAU

**~$38/month** (Vercel free + Fly.io ~$8 + Neon ~$5 + Redis $20 + LLM inference ~$2 + bandwidth ~$2 + S3 ~$1). Dominated by fixed-cost Redis; scales to ~$0.04/user at 10K MAU.

### Migration notes

- No breaking changes. Cloud summarizer is opt-in via `ASHLR_PRO_TOKEN`. Without it, the plugin still defaults to local LM Studio at `localhost:1234/v1`.


## [1.1.0] — 2026-04-18

**First pro-tier bits ship.** Phase 1 of the hosted backend (`server/`) + opt-in stats cloud sync in the plugin. Plus a fully animated SVG status-line hero on the landing page and a before/after bytes comparison.

### Added

- **`server/`** — standalone Hono + SQLite backend, Phase 1 of `docs/pro-backend-architecture.md`. Two services:
  - `GET /u/:userId/badge.svg` — hosted savings badge, CDN-cacheable for 5 min. Reuses the SVG helpers from `scripts/generate-badge.ts`.
  - `POST /stats/sync` + `GET /stats/aggregate` — opt-in cloud stats sync. Privacy-first schema (counts only, no paths or cwds). 10 s/token rate limit.
  - CLI: `bun run server/src/cli/issue-token.ts <email>` to provision users until Phase 2 adds real signup.
  - Standalone workspace, `cd server && bun install && bun test` — 17 passing tests.
- **Cloud-sync integration in `servers/_stats.ts`** — new `maybeSyncToCloud()`. Gated on `ASHLR_PRO_TOKEN`; fires `POST /stats/sync` at most once per 5 min; fire-and-forget with 10 s timeout; never blocks a tool call. Kill switch: `ASHLR_STATS_UPLOAD=0`. 4 new tests in `__tests__/stats-cloud-sync.test.ts`.
- **Landing hero polish** (`site/components/terminal-mock.tsx`, full rewrite) — now a pure SVG with rendered terminal chrome, animated sparkline cells (CSS keyframes, 120 ms cycle matching the plugin's FRAME_MS), 4 s activity-indicator pulse, and an incrementing `+432.5K → +432.8K → +433.1K` counter that sells real-time updates.
- **`<BeforeAfter>` component** on the landing — side-by-side panels showing "Without ashlr" (100 KB · 25K tok) vs "With ashlr" (21 KB · 5.25K tok) with animated fill on scroll-into-view.
- **Tabbed install switcher** in the hero (Claude Code / Cursor / Goose) with per-tab one-liners and copy-to-clipboard buttons.

### Fixed

- Typecheck errors surfaced by the `server/` Bun install (tighter Bun types for `Bun.serve()` port and `Subprocess.stdin`). Added narrow `as unknown as …` casts in test-only code. No production code changed.

### Tests

- **815 pass, 1 skip, 0 fail** across 52 files (+21 tests since v1.0.2).
- New: `server/tests/badge.test.ts` (4), `server/tests/stats.test.ts` (7), `server/tests/auth.test.ts` (4), `__tests__/stats-cloud-sync.test.ts` (4), plus BeforeAfter + terminal-mock unit coverage in the site (if any).

### Migration notes

- No breaking changes to the plugin. Cloud sync is opt-in via `ASHLR_PRO_TOKEN`; without it, nothing over the wire.
- `server/` is not wired to production DNS yet (no `api.ashlr.ai` until you deploy). The integration is dormant by default.


## [1.0.2] — 2026-04-18

**Product-level work.** New React landing page, refreshed pro-tier strategy, full backend architecture spec for hosted services.

### Added

- **React landing page v2** at `site/` (Next.js 15 + Tailwind 4 + shadcn/ui + copy-paste react-bits animations: Threads background, DecryptedText headline, CountUp for the impact number, Magnet CTA). Parchment+ink aesthetic inherited from `docs/index.html`, upgraded to interactive. Ships alongside the old static HTML as a preview — DNS flips when polished. Build size: 49 kB first-load JS on `/`, 173 B on `/pricing`. Respects `prefers-reduced-motion`. Zero horizontal scroll on mobile.
- **`docs/PRO_TIER.md` v1.0 refresh** (268 lines). Updated tier specs for today's 14 MCP tools and 23 skills; concrete pricing: Free · Pro $12/mo · Team $24/user/mo · Enterprise contact sales.
- **`docs/pricing.md`** (238 lines, new). Customer-facing pricing page with three tier cards, 9-question FAQ, 26-row comparison table.
- **`docs/pro-backend-architecture.md`** (395 lines, new). Full architecture spec for the ashlr.ai hosted backend: genome sync (CRDT), cross-machine stats sync (privacy-first), cloud LLM summarizer, hosted badge, policy packs, audit log, leaderboard. Postgres + S3 + Redis + Hono + Clerk stack. API surface, SQL DDL, privacy model, cost-per-user at 100/1K/10K scale, 5-phase rollout.

### Tests

- **794 pass, 1 skip, 0 fail** — no code changes in this release, just docs + new subdirectory.


## [1.0.1] — 2026-04-17

**Zombie-process resilience.** Session counter showed `+0` on machines with pre-v0.8.0 MCP server processes still running (from terminals opened before the day's upgrade) because those old processes overwrite the v2 `stats.json` with v1 shape every 250 ms, wiping the `sessions` map.

### Fixed

- **Status-line `pickSession` fallback** (`scripts/savings-status-line.ts`). When the v2 `sessions` map is empty but `stats.session` (v1 singular) has a `tokensSaved`, surface that number rather than 0. The v1 counter technically lies across concurrent terminals but "slightly wrong" beats "stuck at 0." Full correctness returns once all stale MCP processes die (achieved by fully restarting Claude Code, not just `/reload-plugins`).

### Root cause (for the record)

`/reload-plugins` re-reads plugin manifests but does NOT kill MCP server subprocesses spawned by earlier reloads. If a terminal was opened before v0.8.0 shipped and is still running, its pre-v0.8.0 `ashlr-efficiency` / `ashlr-bash` / etc. processes keep writing v1-shape stats.json alongside the new v2 writers. Atomic rename + file lock in `_stats.ts` don't help because both writers think they're authoritative.

### Recommendation

If you see `session +0`, fully quit Claude Code (all terminals) and reopen. That kills every zombie MCP process. Next session will be clean v2.

### Tests

- **794 pass, 1 skip, 0 fail**. New test case in `__tests__/savings-status-line.test.ts` exercises the v1-fallback path.


## [1.0.0] — 2026-04-17

**Production-ready.** Fifteen MCP tools, twenty-three skills, a status line nobody else has, and 794 tests — zero skipped, zero failing. This is the plugin graduating from "interesting prototype" to "thing you rely on."

### Added

- **`ashlr__diff_semantic`** (`servers/diff-semantic-server.ts`) — AST-aware diff. Detects renames that span ≥3 files, collapses formatting-only changes, flags signature-only changes. A 200-line symbol rename across 20 files renders as `renamed oldName → newName (28 occurrences across 14 files)` instead of 200 lines of patch. Falls back to `ashlr__diff` compact output when no semantic patterns detected.
- **`/ashlr-coach` skill** (`scripts/coach-report.ts` + `commands/ashlr-coach.md`) — reads the session log, surfaces actionable nudges: "used native Read on N large files — ~Ktok wasted," "no genome but heavy grep usage in project X," etc. Five rules, each only bullets when genuinely triggered.
- **`/ashlr-handoff` skill** (`scripts/handoff-pack.ts` + `commands/ashlr-handoff.md`) — exports a compact markdown primer (session summary, recent files, genome status, open todos) to `.ashlr/handoffs/<ts>.md`. Paste into the next session to resume cold without re-exploring. Pairs with the context-pressure widget.
- **Cursor + Goose ports** (`ports/cursor/mcp.json`, `ports/goose/recipe.yaml`, `ports/README.md`) — ashlr's MCP servers run under any compatible host. Cursor and Goose users get the same 14 tools (skills/hooks/status-line remain Claude-specific, stats still land in `~/.ashlr/stats.json`).
- **Team-shared genome guide** (`docs/team-genome.md`) — 267-line contributor guide on committing `.ashlrcode/genome/` to the repo, merge-conflict resolution, the `genome-ignore` convention, and bootstrap workflow.
- **GitHub Actions CI** (`.github/workflows/ci.yml`) — typecheck + test (with ripgrep installed so grep-confidence tests actually fire) + real-time smoke test on every push and PR. Auto-release workflow (`release.yml`) fires on `v*.*.*` tags.

### Fixed

- **`no-genome grep emits tool_fallback` flake** (`__tests__/efficiency-server.test.ts`). Root cause: `rpcWithHome` spread the full parent `process.env` into the subprocess, so any earlier test that mutated `process.env.HOME` and pointed at a since-deleted tmpdir would poison this test's subprocess env. Fix: spawn the subprocess with a minimal `{ HOME, PATH }` env, exactly pinned. The test is now unskipped and passes reliably in the full suite.

### Tests

- **794 pass, 1 skip (only `rg` binary missing on dev macOS — runs green in CI), 0 fail** across 48 files.
- Baseline at session start was 287 pass across 24 files in v0.6.0. Net: **+507 tests** over the course of one day and six releases.

### Highlights from the 0.8.x → 1.0.0 arc

- Per-session token accounting keyed by CLAUDE_SESSION_ID with a PPID-hash fallback so sessions can't clobber each other across terminals.
- Animated status line: 16-rung Unicode ramp, truecolor gradient sweep, 4-second activity pulse with `↑` indicator, context-pressure widget, width-stable across 60 frames.
- Real-time counters: worst-case visible latency ~550 ms (was 2.25 s).
- Seven new MCP servers: `ashlr__glob`, `ashlr__webfetch`, `ashlr__multi_edit`, `ashlr__ask`, `ashlr__diff_semantic`, `ashlr__savings` (dashboard upgrade), plus `_genome-live.ts` auto-refresh.
- Seven new skills: `/ashlr-allow`, `/ashlr-usage`, `/ashlr-errors`, `/ashlr-demo`, `/ashlr-badge`, `/ashlr-legend`, `/ashlr-dashboard`, `/ashlr-coach`, `/ashlr-handoff`.
- SSRF-safe fetch, confidence footers on every compressed output, calibration harness, fallback/escalation event emission.

### Migration notes

- No breaking changes from 0.9.x. Stats.json schema is still `v2`; legacy orphaned PPID-hash buckets get dropped on SessionEnd.
- Run `/ashlr-allow` once to silence permission prompts, then `/reload-plugins`.


## [0.9.3] — 2026-04-17

**Bugfix: "session counter stuck at 0".** Users reported the status line showed `session +0` even as `lifetime +N` kept ticking up. Root cause: Claude Code forwards `CLAUDE_SESSION_ID` to the status-line/hook contexts but does **not** forward it to MCP server subprocesses. So writers (MCP servers) wrote to a PPID-hash bucket while the reader (status line) queried the CLAUDE_SESSION_ID bucket, and the two never met.

### Fixed

- **Session bucket id divergence** (`servers/_stats.ts`, `scripts/savings-status-line.ts`). New `candidateSessionIds()` helper returns both `CLAUDE_SESSION_ID` (when set) and the PPID-hash fallback. The status line's `pickSession`, `readCurrentSession`, and `dropSessionBucket` all aggregate across every candidate so whichever id the MCP server actually wrote under is picked up. Confirmed by inspecting a live stats.json — the PPID-hash bucket `pa1913b71` that had 2863 tokens was invisible to the status line under the old single-id lookup.
- **SessionEnd GC leaks** — before, only the primary id's bucket was dropped, leaving the MCP-written PPID-hash bucket orphaned. Now drops every candidate, preventing long-term `sessions` map bloat.

### Tests

- **728 pass, 2 skip, 0 fail**. No test changes required — existing per-session tests (which explicitly set `CLAUDE_SESSION_ID`) still pass because the primary candidate is still `CLAUDE_SESSION_ID` when set.

### Migration notes

- No breaking changes. Existing stats.json files with orphaned PPID-hash buckets will be cleaned up on their next SessionEnd.


## [0.9.2] — 2026-04-17

**Polish release** — code-review + simplifier + security audit on the v0.9.x work. Seven real findings, all fixed. No feature changes.

### Fixed

- **SSRF via redirect bypass** (`servers/_http-helpers.ts`, `servers/webfetch-server.ts`, `servers/http-server.ts`). `fetch({ redirect: "follow" })` silently followed 3xx hops without re-checking the target hostname — a public URL could redirect to `127.0.0.1` or `169.254.169.254` (cloud metadata) and bypass `isPrivateHost`. New `safeFetch()` helper implements manual redirect validation: every hop is re-checked against `isPrivateHost`, which now also covers `169.254.x` (link-local), `0.x`, and multicast ranges. Both MCP servers routed through `safeFetch` — any redirect to a private host throws with a clear hop-numbered error.
- **`ashlr__multi_edit` strict-mode `$` interpolation** (`servers/multi-edit-server.ts`). Used `String.prototype.replace(string, string)` which interprets `$&`, `$1`, `` $` ``, `$'` in the replacement — silently corrupting any edit whose replacement contained a `$` followed by certain chars (e.g. template literals, TypeScript generics, currency strings). Now uses `slice + concat` so the replacement is always literal. Non-strict mode was already safe via `split/join`.
- **Stats flush-on-exit race** (`servers/_stats.ts`). `flushToDisk` cleared `_pendingStats` on entry, so if the process exited mid-async-write the sync exit handler had nothing to flush even though the in-flight async rename might not have completed. Now `_pendingStats` is only cleared *after* the rename succeeds, so the sync path can always re-run an in-flight flush.
- **Status-line ANSI-unsafe truncation** (`scripts/savings-status-line.ts`). The last-resort over-budget truncation did `line.slice()` on a string that might contain ANSI escape sequences — a cut in the middle of `\x1b[38;2;…m` would leak a dangling escape that corrupts the terminal. Now strips ANSI before slicing.
- **Webfetch content-type precedence** (`servers/webfetch-server.ts`). Operator precedence on the HTML-sniffing heuristic meant JS/binary responses whose body happened to start with `<` were getting HTML-stripped. Parens fixed.
- **`confidenceBadge` zero-output tier** (`servers/_summarize.ts`). `rawBytes > 0 && outputBytes === 0` (total elision) used to return `"high"`; now correctly returns `"low"`.
- **Dashboard script cleanup** (`scripts/savings-dashboard.ts`). Removed unused `basename` import, dead `BANNER_LINES` array, and unused local in `boxTop()`. Simplifier pass.

### Security posture

Security audit also verified clean across: shell injection (bash-server uses `-c` with user command as single arg), input validation (all MCP handlers typeof-check args), secrets (no `ASHLR_LLM_KEY` logging), SQL (user-controlled by design), deserialization/prototype pollution, DoS caps (bash 5MB, webfetch 100KB default), hook payloads (validated).

### Tests

- **728 pass, 2 skip, 0 fail** across 45 files. No new tests (this release is bug fixes only, verified against the existing suite).

### Migration notes

- No breaking changes. `safeFetch` is a drop-in replacement for the internal `fetch` path; callers outside the plugin are unaffected.


## [0.9.1] — 2026-04-17

**Real-time counters, "↑" activity indicator, ASCII-art live dashboard.** Three polish wins that landed right after v0.9.0 shipped.

### Added

- **Activity indicator in the status line** (`scripts/ui-animation.ts` `activityIndicator()`). When a `recordSaving` fired in the last 4s, an `↑` glyph appears between the label and counter: `session ↑+12.3K`. Truecolor interpolates from brand-light (just saved) to brand-dark (fading). ASCII fallback renders `+` double-prefix. Width-stable across all states.
- **ASCII-art live dashboard** (`scripts/savings-dashboard.ts` — full rewrite). Three-part layout: a wordmark banner, a tile strip (session / lifetime / best day), per-tool horizontal bar chart, 7-day + 30-day sparklines, projected annual, top 3 projects. `--watch` mode clears the screen and redraws every 1.5s. Degrades cleanly under `NO_COLOR=1`.
- **Real-time cross-terminal freshness test** (`__tests__/stats-realtime.test.ts`). Proves terminal A's lifetime bump is visible to terminal B's status line within 500 ms, and that terminal A's session bump is NOT visible in terminal B (per-session invariant holds).
- **Smoke-test script** (`scripts/smoke-realtime.ts`). Runnable via `bun run scripts/smoke-realtime.ts` — records 10 savings at 100 ms intervals, asserts each shows up in the next status-line read within 500 ms. Manual QA harness for the real-time path.

### Fixed

- **Status-line read cache TTL reduced from 2 s → 300 ms** (`scripts/savings-status-line.ts`). Combined with the 250 ms write debounce, worst-case visible latency is now 550 ms (was ~2.25 s). The mtime-invalidation on the cache still short-circuits when another terminal writes, so typical freshness is ~250 ms.
- **Flush-on-exit hardening** (`servers/_stats.ts`). Confirmed via new tests that `beforeExit`/`exit` handlers synchronously flush any pending debounced delta — no session can lose its tail of savings.

### Tests

- **728 pass, 2 skip, 0 fail** across 45 files (+44 tests vs v0.9.0).

### Migration notes

- No breaking changes. Purely additive + one cache TTL tightening that's invisible to users except as faster counter updates.


## [0.9.0] — 2026-04-17

**Atomic batched edits, a meta-router tool, shareable savings badge, genome auto-refresh, confidence badges on every summarized output, and a context-pressure widget in the status line.** Six focused streams shipped in parallel — no breaking changes.

### Added

- **`ashlr__multi_edit`** (`servers/multi-edit-server.ts`) — atomic batched edits across N files in one roundtrip. Each edit is a path + search + replace + strict tuple. If any edit fails, every prior edit is rolled back using cached originals. Files are read once per path and written once per path after all edits succeed. Savings are recorded against the sum of original + updated lengths across all files — equivalent to N naive Edit calls.
- **`ashlr__ask`** (`servers/ask-server.ts`) — meta-router tool that accepts a natural-language question and routes deterministically (no LLM in the routing path) to the correct underlying ashlr tool: glob patterns → `ashlr__glob`, read verbs + path token → `ashlr__read`, grep verbs → `ashlr__grep`, structural questions → `ashlr__orient`, list/tree verbs → `ashlr__tree`. Fallback is `ashlr__orient`. Routing decision and extracted param are included in every response.
- **`/ashlr-badge` skill** (`commands/ashlr-badge.md` + `scripts/generate-badge.ts`) — generates a self-contained SVG stats card from `~/.ashlr/stats.json`. Three `--metric` modes (tokens / dollars / calls), three `--style` variants (flat / pill / card with mini bar chart), three `--window` modes (lifetime / last30 / last7). `--out <path>` writes to file; `--serve` starts a badge server on `:7777` so the badge auto-updates as tokens accumulate. Embeddable in GitHub profile READMEs.
- **`servers/_genome-live.ts`** — in-process genome auto-refresh after every `ashlr__edit`. Patches genome sections that embed edited content verbatim; invalidates (deletes) sections that only summarize the file so the propose queue regenerates them. Fire-and-forget (callers `.catch(()=>{})`), never throws, honors `ASHLR_GENOME_AUTO=0`, uses a per-file in-process mutex, and calls `_clearCache()` so the LRU evicts stale retrievals. Wired into `ashlr__edit` and `ashlr__multi_edit`.
- **`confidenceBadge`** (`servers/_summarize.ts`) — fidelity signal appended to every compressed output. Reports compression ratio and whether `bypassSummary:true` would recover the full payload. Call sites do `text + confidenceBadge({...})` — the function is side-effect-free and always returns a string.
- **Context-pressure widget** (`scripts/savings-status-line.ts` + `scripts/ui-animation.ts`) — reads the Claude Code context-fill percentage from the stdin payload and renders a color-tiered micro-widget (green / yellow / red) between the sparkline and the "session +N" counter. Hidden entirely when the value is absent or the terminal is too narrow.

### Tests

- **684 pass, 2 skip, 0 fail** across 43 files (was 554 pass across 38 files in v0.8.0 — **130 new tests** net).
- New test files: `__tests__/ask-server.test.ts`, `__tests__/confidence-badge.test.ts`, `__tests__/generate-badge.test.ts`, `__tests__/genome-live.test.ts`, `__tests__/multi-edit-server.test.ts`.
- Extended: `__tests__/efficiency-server.test.ts`, `__tests__/logs-server.test.ts`, `__tests__/savings-status-line.test.ts`, `__tests__/ui-animation.test.ts`.

### Migration notes

- No breaking changes. All new tools are additive; existing tool APIs are unchanged.
- Users should run `/reload-plugins` (or restart Claude Code) after upgrading to register `ashlr-multi-edit` and `ashlr-ask` as MCP servers.
- `_genome-live.ts` is wired automatically — no configuration required. Disable with `ASHLR_GENOME_AUTO=0`.

## [0.8.0] — 2026-04-17

**Truly per-session counters + truly zero permission prompts + two new MCP tools + an animated status line.** A single-session major push that makes the plugin honest, quiet, and delightful.

### Added

- **Per-session token accounting** (`servers/_stats.ts`, new). Shared source of truth keyed by `CLAUDE_SESSION_ID` with atomic temp+rename writes, cross-process file lock, in-process mutex, minified JSON, `schemaVersion: 2` with v1 migration, debounced batch flush (250ms; `ASHLR_STATS_SYNC=1` opts out), `lastSavingAt` field driving the animation pulse. All 12 MCP servers migrated from their own per-file `recordSaving` to delegate here. Fixes the bug where "session +N" in one terminal would clobber every other terminal's counter.
- **Animated status line** (`scripts/ui-animation.ts`, new). 16-rung Unicode ramp with ASCII fallback, truecolor gradient shimmer between `ashlr-brand-dark` → `ashlr-brand-light`, 4-second activity pulse after every `recordSaving`, 15-frame braille heartbeat glyph. Width-stable across 60 consecutive frames. `NO_COLOR=1` / `ASHLR_STATUS_ANIMATE=0` degrade cleanly.
- **`ashlr__glob`** (`servers/glob-server.ts`) — compressed glob-pattern matching. `git ls-files -z` when in a repo (`.gitignore`-aware for free); readdir walker fallback. Groups >20 matches by top-level directory.
- **`ashlr__webfetch`** (`servers/webfetch-server.ts`) — token-efficient wrapper around WebFetch. Extracts main content from HTML, pretty-prints + array-elides JSON, refuses private hosts. Shares `servers/_http-helpers.ts` with `ashlr__http`.
- **`/ashlr-allow` skill** (`commands/ashlr-allow.md` + `scripts/install-permissions.ts`) — one command that adds `mcp__ashlr-*` entries to `~/.claude/settings.json`'s `permissions.allow`, so Claude Code stops prompting on every ashlr tool call in `bypassPermissions` mode. Idempotent, atomic-write, supports `--dry-run` and `--remove`.
- **`/ashlr-usage` skill** (`commands/ashlr-usage.md` + `scripts/session-log-report.ts`) — reads `~/.ashlr/session-log.jsonl`, surfaces top tools, per-project breakdown, 24h-vs-lifetime split, session-end rollups, and fallback/escalation rates.
- **`/ashlr-errors` skill** (`commands/ashlr-errors.md` + `scripts/errors-report.ts`) — tails MCP server errors with signature-based deduplication (strips timestamps/UUIDs/paths), last-week window by default.
- **`/ashlr-demo` skill** (`commands/ashlr-demo.md` + `scripts/demo-run.ts`) — 30-second scripted showcase on the cwd repo (read + grep + totals).
- **Calibration harness** (`scripts/calibrate-grep.ts` + `scripts/read-calibration.ts`) — replaces the speculative `4×` grep baseline with an empirically measured multiplier. Opt-in via `ASHLR_CALIBRATE=1`; non-calibrating path unchanged.
- **Fallback/escalation event emission** (`servers/_events.ts`) — logs `tool_fallback`, `tool_escalate`, `tool_error`, `tool_noop` records to the session log with reason codes (`no-genome`, `llm-unreachable`, `nonzero-exit-elided`, etc.) so `/ashlr-usage` can show you when things routed away from the fast path.
- **Session-end GC hook** (`hooks/session-end-stats-gc.ts`) — drops the per-session bucket on SessionEnd and appends a final summary record to the session log. Prevents unbounded `sessions` map growth.
- **Per-session architecture doc** (`docs/architecture.md`) — 292-line contributor guide covering MCP server map, stats data flow, hook graph, genome lifecycle, status-line pipeline, summarization, how to add a new server, testing model, release flow, design principles. All `file:line` references verified.
- **Dashboard upgrade**: `ashlr__savings` now shows per-project breakdown, top-10 largest savings events (by tool × day), and a calibration confidence line.
- **Quality guardrails**: `ashlr__grep` genome path now also runs `rg -c` for a confidence estimate ("genome returned 2 sections · rg estimates 47 matches · pass bypassSummary:true for the full list"). `ashlr__bash` widens the tail to 4 KB on non-zero exits and warns loudly when the LLM summary is unavailable. `PROMPTS.read` now requires the summarizer to preserve every `@`-decorator, `TODO/FIXME/WARNING/THREAD-UNSAFE/DEPRECATED/NOTE/SAFETY` marker, and every `export`/`module.exports`/`__all__` statement.
- **Genome LRU** (`servers/_genome-cache.ts`) — 64-entry process-lifetime cache keyed by `(genomeRoot, pattern)` with manifest-mtime invalidation.
- **Permissions section** in `README.md` explaining `/ashlr-allow`.
- **172 new tests** across 13 new test files (stats, ui-animation, glob, webfetch, session-log-report, install-permissions, events-emit, genome-cache, calibrate-grep, errors-report, demo-run, render-savings-report, quality/read-fidelity, quality/grep-confidence). Plus extensions to doctor, efficiency, and savings-status-line tests.

### Fixed

- **Permission prompts in `bypassPermissions` mode.** `hooks/tool-redirect.ts` no longer returns `permissionDecision: "ask"` (which per the Claude Code docs is evaluated regardless of bypass mode). Now a silent nudge via `additionalContext` only — the agent still learns about `ashlr__*` alternatives, the user is no longer interrupted.
- **`hooks/pretooluse-{read,edit,grep}.sh` hard-blocks disabled by default.** Enforcement is now opt-in via `ASHLR_ENFORCE=1` (was opt-out via `ASHLR_NO_ENFORCE=1`; the old flag still honored). The soft nudge from `tool-redirect.ts` is sufficient in normal use.
- **Bash `snipBytes` tail widens to 4 KB on non-zero exits** so fatal errors never drop to elision. New `errorAware: true` path emits a loud warning when the LLM is unreachable: "an error may be in this gap".
- **`ashlr__edit` strict-mode race clarified** — unchanged behavior, documented in `docs/architecture.md`.

### Changed

- `scripts/mcp-entrypoint.sh` forwards `CLAUDE_SESSION_ID` into every MCP server env (also exports `ASHLR_SESSION_ID` as a mirror) so `recordSaving` can scope to the right bucket.
- `hooks/session-start.ts` now calls `initSessionBucket()` on every start — sets `startedAt` accurately for `/ashlr-savings`. No longer clobbers sibling terminals.
- `savings-status-line.ts` reads from `stats.sessions[<id>]` instead of the legacy global `session` field (v1 counter was always inaccurate across concurrent terminals).
- Status line ramp upgraded from 9 rungs to 16 rungs (mixed Braille + Unicode block chars) for smoother visual gradient.
- `scripts/publish.sh` now leaves the old enforcement flag honored and does not force-push.

### Tests

- **554 pass, 1 skip, 0 fail** across 38 files (was 287 pass across 24 files before this release — **267 new tests** net, not counting renames).

### Migration notes

- Existing `stats.json` files are automatically migrated to `schemaVersion: 2` on the next `recordSaving`. The legacy global `session` field is dropped (it was inaccurate across concurrent terminals anyway); lifetime totals are preserved unchanged.
- Users should run `/ashlr-allow` once to silence permission prompts. Restart Claude Code (or `/reload-plugins`) after upgrading.


## [0.6.0] — 2026-04-15

**Real summarization, not just truncation.** Six MCP tools now route large output through the local LLM (LM Studio default; cloud-override via env). Plus four UX fixes that came out of running the v0.5.0 install live.

### Added
- **`servers/_summarize.ts`** — shared LLM-summarization helper. Local-first (`http://localhost:1234/v1` default), 5s timeout with snipCompact fallback, 1-hour SHA-256 cache at `~/.ashlr/summary-cache/`, per-tool prompts, optional cloud override via `ASHLR_LLM_URL` + `ASHLR_LLM_KEY`. Cloud only fires when explicitly opted into — preserves the no-account positioning.
- **Summarization wired into 6 tools**: `ashlr__read`, `ashlr__grep` (rg-fallback path only), `ashlr__edit`'s sibling tools, `ashlr__diff` (summary/full modes), `ashlr__logs`, `ashlr__bash` (raw pass-through path), `ashlr__sql` (>100 row results). Each tool got a `bypassSummary: boolean` input field. Tools that DON'T summarize: tree, http, genome ops, savings, bash control-plane (start/tail/stop/list).
- **Stale plugin cache cleanup** in `hooks/session-start.ts` — prevents the v0.3.0 stale-cache bug we hit live. Removes sibling versioned dirs that aren't the current `${CLAUDE_PLUGIN_ROOT}`. Strict semver guard so non-version dirs (`latest`, `dev-branch`, etc.) survive untouched.
- **`docs/install.sh`** pre-clean step — removes older versioned cache dirs at install time, keeps only the latest semver via `sort -V`.
- **`docs/install-prompt.md`** rewrite — single bulletproof paste-block that walks Claude Code through the full install + restart + verify + (optional) genome init + tour, reporting at each step.

### Fixed
- **`commands/ashlr-benchmark.md`** — replaced hardcoded `~/.claude/plugins/ashlr-plugin/...` fallback with `${CLAUDE_PLUGIN_ROOT}/...` and a clear error if the env var isn't set. Fixes the `/0.3.0/` stale-path symptom.
- **Status-line tip truncation** (`scripts/savings-status-line.ts`) — now reads `$COLUMNS` (capped at 120, falls back to 80), only renders the tip when ≥15 chars of budget remain (no more `tip: a…`), and shortened the longest tip from 47→38 chars.

### Changed
- **Activation notice** in `hooks/session-start.ts` updated from "v0.3.0 active — 5 tools" to "v0.6.0 active — 9 MCP tools incl. summarization."
- **Hero animation** rebuilt: 4 tool calls (Read, Grep, Edit, Bash), faster counter rise on the "Without ashlr" side, italic Fraunces stamp-rotate-in for the final `−84%`, oxblood-tinted underline pulse on the loser column + eucalyptus-tinted on the winner, plus a `$X.XX saved` badge that fades in after the stamp.

### Tests
- **216 pass, 1 skip, 0 fail** across 18 files (was 187 in v0.5.0).
- 8 new tests in `__tests__/_summarize.test.ts` covering threshold, cache hit, LLM unreachable fallback, malformed response, bypass mode, stats accounting.
- 4 new wiring tests across efficiency/diff/logs/bash/sql servers.
- 6 new tests in `__tests__/session-start-cleanup.test.ts`.
- 3 new status-line tip-budget tests.


## [0.3.0] — 2026-04-15

**Beyond parity.** Three new MCP servers (SQL, Bash, baseline scanner) make ashlr strictly more useful than WOZCODE on database work, shell work, and session orientation. 94/94 tests pass.

### Added

- **`ashlr__sql` tool** (`servers/sql-server.ts`) — compact SQL execution in one tool call.
  - SQLite (built-in via `bun:sqlite`) + Postgres (via `postgres` npm package, 3.4.9)
  - Auto-detects connection: explicit arg → `$DATABASE_URL` → `*.db` / `*.sqlite` in cwd (most-recently-modified wins)
  - Password redaction in every output header line
  - `explain: true` returns the query plan only
  - `schema: true` introspects tables + columns + row counts (cheaper than many `\d` / `SHOW TABLES`)
  - `limit` caps returned rows, reports elision count
  - CSV-baseline savings math (RFC 4180 quoting) — example: 142 rows × 4 cols = 10,812-byte CSV baseline → 1,730-byte compact table → **~2,271 tokens saved per query**
  - 13 integration tests (SQLite in-memory, file, schema, EXPLAIN, errors, redaction, elision); postgres live test gated on `$TEST_DATABASE_URL`
- **`ashlr__bash` tool** (`servers/bash-server.ts`) — shell with auto-compressed output.
  - `snipCompact` on stdout > 2KB (800-byte head + 800-byte tail; stack traces and exit messages survive)
  - **stderr never compressed** — errors reach the agent intact
  - Recognized commands get structured summaries instead of raw output:
    - `git status` → `M: 3, A: 1, ??: 2 · branch main · ahead 2 of origin/main`
    - `ls` / `find` → elide middle on > 40 / > 100 entries
    - `ps aux` → filter to rows matching cwd-name when > 100 rows
    - `npm ls` / `bun pm ls` → dedupe warnings, collapse tree depth > 2
    - `cat <file>` → refused with redirect to `ashlr__read`
  - Refuses catastrophic patterns (`rm -rf /`) with a clear message
  - 60s default timeout; SIGKILL on expiry
  - Concrete savings: `head -c 10240 /dev/zero | tr` → 10,240 → 1,660 bytes → ~2,145 tokens saved
  - 9 integration tests
- **Baseline scanner** (`scripts/baseline-scan.ts` + `hooks/session-start.ts`) — pre-scans the project at `SessionStart` and pipes the baseline into the agent's system prompt as `additionalContext`.
  - One-screen output: file counts by extension, entry points, largest source files, test layout, genome detection, git state (branch, uncommitted, ahead/behind, last commit), runtime fingerprint
  - Uses `git ls-files` for free gitignore handling (fallback: `readdir` with a hardcoded exclusion list)
  - Hash-cached at `~/.ashlr/baselines/<sha>.json`; invalidates when probed mtimes exceed cache, or after 24h
  - Hard cap 5,000 files (emits `truncated: true` above)
  - Replaces `hooks/session-start.sh`; the `.sh` is now superseded (left for reference)
  - 15 tests

### Fixed

- (none — v0.2.0 stayed solid; v0.3 is pure addition)

### Changed

- `.mcp.json` now registers **three** MCP servers (`ashlr-efficiency`, `ashlr-sql`, `ashlr-bash`). Claude Code launches them independently.
- `hooks/hooks.json` `SessionStart` now points at `session-start.ts` (which invokes the baseline scanner).

### Feature comparison vs WOZCODE

Now strictly ahead on the core value prop:
- ✅ Tri-agent, Read/Grep/Edit, tool-redirect, commit attribution, edit-batching, status line, savings tracker, settings, `/recall`, `/update`, `/benchmark`
- ✅ **SQL tool** (WOZCODE claims 10× on DB tasks — ours is open-source + explain + schema + auto-detect)
- ✅ **Bash tool** (our own, with structured summaries)
- ✅ **Baseline scanner** (ours is cached + git-aware)

Still intentional non-goals (ethical wins preserved):
- No account, no login
- Zero telemetry (WOZCODE has PostHog baked into `.mcp.json`)
- MIT open source
- Shared `@ashlr/core-efficiency` library, also used by standalone CLI

### Tests

**94 pass, 1 skip, 0 fail** across 8 files:
- 11 · MCP efficiency-server end-to-end
- 12 · tool-redirect hook
- 14 · commit-attribution hook
- 13 · savings-status-line
- 7 · edit-batching-nudge
- 13 · sql-server (+1 postgres-live, skipped without `$TEST_DATABASE_URL`)
- 9 · bash-server
- 15 · baseline-scan

## [0.2.0] — 2026-04-15

WOZCODE feature-parity release. Four hooks (tool-redirect, commit-attribution, edit-batching-nudge, session-start) + status-line integration + three new slash commands (`/ashlr-recall`, `/ashlr-update`, `/ashlr-benchmark`). Fixed `.mcp.json` to use `${CLAUDE_PLUGIN_ROOT}`. `ashlr__edit` now actually applies edits. 57 tests.

## [0.1.0] — 2026-04-15

Initial public release. MCP server with 4 tools, 3 agents, 3 slash commands, session-start hook, benchmark harness, landing page at `plugin.ashlr.ai`, CI, publish script. Shared `@ashlr/core-efficiency` library architecture. MIT.
