# Pre-launch Legal Checklist

Internal tracking doc. Do not publish.

Last reviewed: 2026-04-18

---

## Before launch — required actions

### Entity and policy text

- [x] **Entity name confirmed.** Privacy, Terms, and DPA now say "AshlrAI Inc" (Delaware corporation). Contact email is `support@ashlr.ai` across all pages.
- [x] **Governing law clause.** Delaware, in `site/app/terms/page.tsx` section 10. Placeholder removed.
- [ ] **Data residency claims.** Privacy Policy section 8 states "US-East (iad)" for Fly.io and Neon. Verify this matches the actual region in `fly.toml` and the Neon project settings before go-live.
- [ ] **Age verification.** Both Privacy Policy (section 9) and Terms (section 3) set a 13+ minimum. If you ever target education or government markets you may need FERPA/COPPA review.

### Stripe

- [ ] Register and verify the Stripe webhook endpoint (`/api/stripe/webhook`) with the correct signing secret in your production environment.
- [ ] Enable the billing portal in the Stripe dashboard (Settings → Billing → Customer portal) so the "cancel anytime via portal" promise in Terms section 5 actually works.
- [ ] Confirm the 14-day refund window is noted in the Stripe portal configuration.
- [ ] Confirm tax collection settings (automatic tax or manual) match the "exclusive of taxes" language in Terms section 5.

### Resend

- [ ] Verify the sending domain (`ashlr.ai`) in the Resend dashboard. Add SPF, DKIM, and DMARC records to DNS.
- [x] `support@ashlr.ai` is the canonical contact email — referenced across privacy, terms, DPA, pricing, footer, docs, and docs/pro/*.
- [ ] Set up transactional email templates: welcome / magic link, subscription receipt, renewal reminder, policy change notice (30-day lead).

### Sub-processor DPAs

If you sign enterprise customers, you will need countersigned DPAs with each sub-processor:

- [ ] Fly.io — check their DPA availability at https://fly.io/legal/
- [ ] Neon — check their DPA availability at https://neon.tech/legal
- [ ] Vercel — DPA available at https://vercel.com/legal/dpa
- [ ] Stripe — DPA available at https://stripe.com/legal/dpa
- [ ] Resend — confirm DPA availability

### International

- [ ] If you have EU enterprise customers, ensure Fly.io and Neon projects can be migrated to EU regions as promised in Privacy Policy section 8 and DPA section 3.
- [ ] Confirm SCC module selection (Module 2: controller-to-processor) with each sub-processor DPA.
- [ ] UK adequacy — if you have UK customers post-Brexit, SCCs with UK addendum (IDTA) may be required.

---

## What's low-risk (can launch as-is)

- Cookie notice — minimal cookies (Stripe on checkout only), banner is accessible and stores consent in localStorage for 180 days.
- CCPA compliance — we collect no data on the free tier; Pro collects only email and aggregate numbers. No sale of data. The DPA stub correctly states this.
- MIT license / IP section — straightforward, no legal risk.
- Limitation of liability cap (12 months fees or $100 minimum) — standard SaaS clause, low risk for a developer tool.
- Arbitration clause — AAA rules, Delaware seat, standard for US-based SaaS.
- Children's policy (13+) — conservative threshold, no COPPA complexity.

---

## What needs legal review before enterprise sales

- Governing law and arbitration (sections 10–11 of Terms) — confirm state of formation.
- DPA countersignature process — the `/dpa` page is a stub; a proper exhibit needs to be drafted and signed for each enterprise customer.
- 99.5% SLA for enterprise — only commit to this if you have monitoring and runbook in place.
- GDPR Article 37 DPO assessment — currently stated as not required. Revisit if EU revenue exceeds thresholds or if you process special categories of data.

---

## File locations

| Document | Route | File |
|---|---|---|
| Privacy Policy | /privacy | site/app/privacy/page.tsx |
| Terms of Service | /terms | site/app/terms/page.tsx |
| Data Processing Addendum | /dpa | site/app/dpa/page.tsx |
| Cookie banner component | (component) | site/components/cookie-banner.tsx |
| Footer (updated) | (component) | site/components/footer.tsx |
| Sitemap | /sitemap.xml | site/app/sitemap.ts |
