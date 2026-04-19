/**
 * admin.ts — Admin dashboard API endpoints.
 *
 * All routes require:
 *   1. Valid Bearer token (authMiddleware)
 *   2. users.is_admin = 1 (requireAdmin)
 *
 * Every mutation is written to the audit log with tool="admin".
 *
 * Endpoints:
 *   GET  /admin/overview
 *   GET  /admin/users?q=&limit=&offset=
 *   GET  /admin/users/:id
 *   POST /admin/users/:id/refund
 *   POST /admin/users/:id/comp
 *   GET  /admin/revenue?from=&to=
 *   GET  /admin/errors?limit=
 *   GET  /admin/audit?orgId=&limit=&offset=
 *   POST /admin/broadcast
 */

import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware, requireAdmin } from "../lib/auth.js";
import {
  adminGetOverviewCounts,
  adminGetRecentSignups,
  adminGetRecentPayments,
  adminGetLlmUsageByTier,
  adminListUsers,
  adminGetUserDetail,
  adminSetUserComp,
  adminGetRevenueTimeline,
  adminQueryAuditEvents,
  adminGetAllUserEmails,
  checkBroadcastRateLimit,
  appendAuditEvent,
  getSubscriptionByUserId,
  getUserById,
} from "../db.js";
import { getStripeClient } from "../lib/stripe.js";
import { sendEmail } from "../lib/email.js";
import pino from "pino";

const logger = pino({ name: "admin" });

const admin = new Hono();

// ---------------------------------------------------------------------------
// Auth guard applied to every /admin/* route
// ---------------------------------------------------------------------------

admin.use("/admin/*", authMiddleware);

admin.use("/admin/*", async (c, next) => {
  const user = c.get("user");
  const deny = requireAdmin(c, user);
  if (deny) return deny;
  await next();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Redact email for overview lists: ma***@evero-consulting.com */
function redactEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***@${domain}`;
}

function logAdminAction(userId: string, operation: string, target: string): void {
  try {
    appendAuditEvent({
      orgId: "admin",
      userId,
      tool: "admin",
      argsJson: JSON.stringify({ operation, target }),
      cwdFingerprint: "",
      gitCommit: "",
    });
  } catch {
    // Non-blocking — audit log failure must not break the mutation
  }
}

// ---------------------------------------------------------------------------
// GET /admin/overview
// ---------------------------------------------------------------------------

admin.get("/admin/overview", (c) => {
  const counts  = adminGetOverviewCounts();
  const signups = adminGetRecentSignups(10).map((u) => ({
    ...u,
    email: redactEmail(u.email),
  }));
  const payments = adminGetRecentPayments(10).map((p) => ({
    ...p,
    email: redactEmail(p.email),
  }));
  const llmByTier = adminGetLlmUsageByTier(7);

  return c.json({
    counts,
    recent_signups: signups,
    recent_payments: payments,
    llm_usage_by_tier: llmByTier,
  });
});

// ---------------------------------------------------------------------------
// GET /admin/users
// ---------------------------------------------------------------------------

const UsersQuerySchema = z.object({
  q:      z.string().optional(),
  limit:  z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

admin.get("/admin/users", (c) => {
  const parsed = UsersQuerySchema.safeParse({
    q:      c.req.query("q"),
    limit:  c.req.query("limit"),
    offset: c.req.query("offset"),
  });

  if (!parsed.success) {
    return c.json({ error: "Invalid query params", issues: parsed.error.issues }, 400);
  }

  const { q, limit, offset } = parsed.data;
  const users = adminListUsers({ q, limit, offset });

  // Redact emails in list view
  const redacted = users.map((u) => ({
    ...u,
    email: redactEmail(u.email),
  }));

  return c.json({ users: redacted, limit, offset });
});

// ---------------------------------------------------------------------------
// GET /admin/users/:id
// ---------------------------------------------------------------------------

admin.get("/admin/users/:id", (c) => {
  const id = c.req.param("id");
  const detail = adminGetUserDetail(id);

  if (!detail) {
    return c.json({ error: "User not found" }, 404);
  }

  // Full email visible on detail page — no redaction
  return c.json(detail);
});

// ---------------------------------------------------------------------------
// POST /admin/users/:id/refund
// ---------------------------------------------------------------------------

const RefundSchema = z.object({
  amountCents: z.number().int().min(1),
  reason: z.string().min(1).max(500),
});

admin.post("/admin/users/:id/refund", async (c) => {
  const adminUser = c.get("user");
  const userId = c.req.param("id");

  const body = await c.req.json().catch(() => null);
  const parsed = RefundSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", issues: parsed.error.issues }, 400);
  }

  const { amountCents, reason } = parsed.data;

  const target = getUserById(userId);
  if (!target) {
    return c.json({ error: "User not found" }, 404);
  }

  const sub = getSubscriptionByUserId(userId);
  if (!sub) {
    return c.json({ error: "No subscription found for this user" }, 404);
  }

  // Issue Stripe refund for most recent charge
  let refundId: string;
  try {
    const stripe = getStripeClient();
    // Retrieve the subscription to find the latest invoice / charge
    const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
    const latestInvoiceId = stripeSub.latest_invoice as string | null;

    if (!latestInvoiceId) {
      return c.json({ error: "No invoice found on subscription" }, 400);
    }

    // In Stripe API 2026-03-25.dahlia, Invoice no longer has top-level
    // `charge` or `payment_intent` fields. Use invoicePayments to find the
    // PaymentIntent, then retrieve its latest_charge.
    const payments = await stripe.invoicePayments.list({ invoice: latestInvoiceId, limit: 1 });
    const firstPayment = payments.data[0];
    const rawPi = firstPayment?.payment.payment_intent;
    const paymentIntentId = typeof rawPi === "string" ? rawPi : (rawPi?.id ?? null);

    if (!paymentIntentId) {
      return c.json({ error: "No payment intent found on latest invoice" }, 400);
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    const chargeId = typeof paymentIntent.latest_charge === "string"
      ? paymentIntent.latest_charge
      : (paymentIntent.latest_charge?.id ?? null);

    if (!chargeId) {
      return c.json({ error: "No charge found on latest invoice" }, 400);
    }

    // Idempotency key prevents duplicate refunds when an admin retries after
    // a transient network timeout (Stripe may have succeeded server-side but
    // the HTTP response never made it back). Key identifies "this exact
    // refund request" — same charge + same amount + same admin = safe to
    // replay.
    const idempotencyKey = `admin-refund-${chargeId}-${amountCents}`;
    const refund = await stripe.refunds.create(
      {
        charge: chargeId,
        amount: amountCents,
        // "other" is not a valid Stripe reason enum value; use
        // requested_by_customer and capture the admin's actual reason in metadata.
        reason: "requested_by_customer",
        metadata: { admin_reason: reason, admin_user_id: adminUser.id },
      },
      { idempotencyKey },
    );
    refundId = refund.id;
  } catch (err) {
    logger.error({ err }, "Stripe refund failed");
    return c.json({ error: "Stripe refund failed" }, 502);
  }

  // Audit trail — insert a stripe_events row of type refund.manual
  try {
    const db = (await import("../db.js")).getDb();
    db.run(
      `INSERT OR IGNORE INTO stripe_events (event_id, processed_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
      [`refund.manual.${refundId}`],
    );
  } catch { /* non-blocking */ }

  logAdminAction(adminUser.id, "refund", userId);

  return c.json({ ok: true, refund_id: refundId });
});

// ---------------------------------------------------------------------------
// POST /admin/users/:id/comp
// ---------------------------------------------------------------------------

const CompSchema = z.object({
  tier: z.enum(["pro", "team"]),
  comp_expires_at: z.string().datetime(),
});

admin.post("/admin/users/:id/comp", async (c) => {
  const adminUser = c.get("user");
  const userId    = c.req.param("id");

  const body   = await c.req.json().catch(() => null);
  const parsed = CompSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", issues: parsed.error.issues }, 400);
  }

  const target = getUserById(userId);
  if (!target) {
    return c.json({ error: "User not found" }, 404);
  }

  adminSetUserComp(userId, parsed.data.tier, parsed.data.comp_expires_at);
  logAdminAction(adminUser.id, "comp", userId);

  return c.json({ ok: true, tier: parsed.data.tier, comp_expires_at: parsed.data.comp_expires_at });
});

// ---------------------------------------------------------------------------
// GET /admin/revenue
// ---------------------------------------------------------------------------

const RevenueQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

admin.get("/admin/revenue", (c) => {
  const today = new Date().toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const parsed = RevenueQuerySchema.safeParse({
    from: c.req.query("from"),
    to:   c.req.query("to"),
  });
  if (!parsed.success) {
    return c.json({ error: "Invalid query params" }, 400);
  }

  const from = parsed.data.from ?? thirtyDaysAgo;
  const to   = parsed.data.to   ?? today;

  const timeline = adminGetRevenueTimeline(from, to);
  return c.json({ from, to, timeline });
});

// ---------------------------------------------------------------------------
// GET /admin/errors
// ---------------------------------------------------------------------------

admin.get("/admin/errors", async (c) => {
  const sentryToken = process.env["SENTRY_INTERNAL_TOKEN"];
  if (!sentryToken) {
    return new Response(null, { status: 204 });
  }

  const limitParam = c.req.query("limit");
  const limit = Math.min(parseInt(limitParam ?? "25", 10) || 25, 100);

  try {
    const sentryOrg = process.env["SENTRY_ORG"] ?? "ashlr";
    const sentryProject = process.env["SENTRY_PROJECT"] ?? "ashlr-server";
    const url = `https://sentry.io/api/0/projects/${sentryOrg}/${sentryProject}/issues/?limit=${limit}&query=is:unresolved`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${sentryToken}` },
    });

    if (!res.ok) {
      return c.json({ error: "Sentry API error", status: res.status }, 502);
    }

    const issues = await res.json();
    return c.json({ issues });
  } catch (err) {
    logger.error({ err }, "Sentry fetch failed");
    return c.json({ error: "Failed to fetch Sentry events" }, 502);
  }
});

// ---------------------------------------------------------------------------
// GET /admin/audit
// ---------------------------------------------------------------------------

const AuditQuerySchema = z.object({
  orgId:  z.string().optional(),
  limit:  z.coerce.number().int().min(1).max(500).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

admin.get("/admin/audit", (c) => {
  const parsed = AuditQuerySchema.safeParse({
    orgId:  c.req.query("orgId"),
    limit:  c.req.query("limit"),
    offset: c.req.query("offset"),
  });
  if (!parsed.success) {
    return c.json({ error: "Invalid query params" }, 400);
  }

  const { orgId, limit, offset } = parsed.data;
  const events = adminQueryAuditEvents({ orgId, limit, offset });
  return c.json({ events, limit, offset });
});

// ---------------------------------------------------------------------------
// POST /admin/broadcast
// ---------------------------------------------------------------------------

const BroadcastSchema = z.object({
  confirm: z.literal(true),
  subject: z.string().min(1).max(200),
  body:    z.string().min(1).max(50_000),
  tier:    z.enum(["free", "pro", "team"]).optional(),
});

admin.post("/admin/broadcast", async (c) => {
  const adminUser = c.get("user");

  const raw    = await c.req.json().catch(() => null);

  // confirm:true is a hard wire requirement
  if (!raw || raw.confirm !== true) {
    return c.json({ error: "confirm: true required in body" }, 400);
  }

  const parsed = BroadcastSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", issues: parsed.error.issues }, 400);
  }

  // Rate limit: 1 broadcast per hour
  if (!checkBroadcastRateLimit()) {
    return c.json({ error: "Broadcast rate limit exceeded (1 per hour)" }, 429);
  }

  const { subject, body, tier } = parsed.data;
  const recipients = adminGetAllUserEmails(tier);

  if (recipients.length === 0) {
    return c.json({ ok: true, sent: 0, message: "No matching recipients." });
  }

  // Send emails (best-effort; log failures but don't abort)
  let sent = 0;
  for (const { email } of recipients) {
    try {
      await sendEmail("broadcast", { to: email, data: { subject, body } });
      sent++;
    } catch (err) {
      logger.error({ err, email }, "broadcast email failed");
    }
  }

  logAdminAction(adminUser.id, "broadcast", tier ?? "all");

  return c.json({ ok: true, sent, total: recipients.length });
});

export default admin;
