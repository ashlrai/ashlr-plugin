// Admin API helpers — all calls require a valid admin bearer token.

const BASE = process.env.NEXT_PUBLIC_ASHLR_API_URL ?? "https://api.ashlr.ai";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OverviewCounts {
  total_users: number;
  active_pro: number;
  active_team: number;
  mrr_cents: number;
  llm_calls_today: number;
  genome_syncs_today: number;
}

export interface RecentSignup {
  id: string;
  email: string; // redacted
  tier: string;
  created_at: string;
}

export interface RecentPayment {
  user_id: string;
  email: string; // redacted
  tier: string;
  created_at: string;
  stripe_subscription_id: string;
}

export interface LlmUsageByTier {
  tier: string;
  date: string;
  calls: number;
}

export interface OverviewData {
  counts: OverviewCounts;
  recent_signups: RecentSignup[];
  recent_payments: RecentPayment[];
  llm_usage_by_tier: LlmUsageByTier[];
}

export interface AdminUserRow {
  id: string;
  email: string; // redacted
  tier: string;
  created_at: string;
  is_admin: number;
  comp_expires_at: string | null;
  last_active: string | null;
  lifetime_tokens_saved: number;
}

export interface UsersListData {
  users: AdminUserRow[];
  limit: number;
  offset: number;
}

export interface UserDetail {
  user: {
    id: string;
    email: string;
    tier: string;
    created_at: string;
    is_admin: number;
    comp_expires_at: string | null;
  };
  subscriptions: Array<{
    id: string;
    tier: string;
    status: string;
    created_at: string;
    current_period_end: string | null;
    stripe_subscription_id: string;
  }>;
  stats_uploads: Array<{
    id: string;
    uploaded_at: string;
    lifetime_tokens_saved: number;
    lifetime_calls: number;
  }>;
  recent_llm_calls: Array<{
    id: string;
    at: string;
    tool_name: string;
    input_tokens: number;
    output_tokens: number;
    cost: number;
  }>;
  active_genome_ids: string[];
  audit_event_count: number;
}

export interface DailyRevenue {
  date: string;
  revenue_cents: number;
}

export interface RevenueData {
  from: string;
  to: string;
  timeline: DailyRevenue[];
}

export interface SentryIssue {
  id: string;
  title: string;
  culprit: string;
  count: string;
  firstSeen: string;
  lastSeen: string;
  permalink: string;
}

export interface AuditEvent {
  id: string;
  org_id: string;
  user_id: string;
  tool: string;
  args_json: string;
  at: string;
}

export interface AuditData {
  events: AuditEvent[];
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// Base fetch
// ---------------------------------------------------------------------------

async function adminFetch<T>(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  if (res.status === 204) return null as T;

  if (!res.ok) {
    const err = new Error(`Admin API ${res.status}: ${res.statusText}`);
    (err as Error & { status: number }).status = res.status;
    throw err;
  }

  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export async function fetchAdminOverview(token: string): Promise<OverviewData> {
  return adminFetch<OverviewData>("/admin/overview", token);
}

export async function fetchAdminUsers(
  token: string,
  params: { q?: string; limit?: number; offset?: number } = {},
): Promise<UsersListData> {
  const qs = new URLSearchParams();
  if (params.q)      qs.set("q",      params.q);
  if (params.limit)  qs.set("limit",  String(params.limit));
  if (params.offset) qs.set("offset", String(params.offset));
  const query = qs.toString() ? `?${qs}` : "";
  return adminFetch<UsersListData>(`/admin/users${query}`, token);
}

export async function fetchAdminUserDetail(token: string, id: string): Promise<UserDetail> {
  return adminFetch<UserDetail>(`/admin/users/${id}`, token);
}

export async function adminRefundUser(
  token: string,
  userId: string,
  amountCents: number,
  reason: string,
): Promise<{ ok: boolean; refund_id: string }> {
  return adminFetch(`/admin/users/${userId}/refund`, token, {
    method: "POST",
    body: JSON.stringify({ amountCents, reason }),
  });
}

export async function adminCompUser(
  token: string,
  userId: string,
  tier: "pro" | "team",
  compExpiresAt: string,
): Promise<{ ok: boolean }> {
  return adminFetch(`/admin/users/${userId}/comp`, token, {
    method: "POST",
    body: JSON.stringify({ tier, comp_expires_at: compExpiresAt }),
  });
}

export async function fetchAdminRevenue(
  token: string,
  params: { from?: string; to?: string } = {},
): Promise<RevenueData> {
  const qs = new URLSearchParams();
  if (params.from) qs.set("from", params.from);
  if (params.to)   qs.set("to",   params.to);
  const query = qs.toString() ? `?${qs}` : "";
  return adminFetch<RevenueData>(`/admin/revenue${query}`, token);
}

export async function fetchAdminErrors(
  token: string,
  limit = 25,
): Promise<{ issues: SentryIssue[] } | null> {
  return adminFetch<{ issues: SentryIssue[] } | null>(`/admin/errors?limit=${limit}`, token);
}

export async function fetchAdminAudit(
  token: string,
  params: { orgId?: string; limit?: number; offset?: number } = {},
): Promise<AuditData> {
  const qs = new URLSearchParams();
  if (params.orgId)  qs.set("orgId",  params.orgId);
  if (params.limit)  qs.set("limit",  String(params.limit));
  if (params.offset) qs.set("offset", String(params.offset));
  const query = qs.toString() ? `?${qs}` : "";
  return adminFetch<AuditData>(`/admin/audit${query}`, token);
}

export async function adminBroadcast(
  token: string,
  subject: string,
  body: string,
  tier?: string,
): Promise<{ ok: boolean; sent: number; total: number }> {
  return adminFetch(`/admin/broadcast`, token, {
    method: "POST",
    body: JSON.stringify({ confirm: true, subject, body, ...(tier ? { tier } : {}) }),
  });
}

export interface BroadcastAudienceResult {
  count: number;
  sample: { email_redacted: string }[];
}

export async function adminBroadcastAudience(
  token: string,
  tier: string,
): Promise<BroadcastAudienceResult> {
  const qs = tier && tier !== "all" ? `?tier=${encodeURIComponent(tier)}` : "";
  return adminFetch<BroadcastAudienceResult>(`/admin/broadcast/audience${qs}`, token);
}

export interface BroadcastDryRunResult {
  ok: boolean;
  dryRun: true;
  count: number;
  sample: { email_redacted: string }[];
}

export interface BroadcastSendResult {
  ok: boolean;
  sent: number;
  total: number;
}

export async function adminBroadcastV2(
  token: string,
  params: {
    subject: string;
    html: string;
    text?: string;
    tier_filter: string;
    dryRun: boolean;
  },
): Promise<BroadcastDryRunResult | BroadcastSendResult> {
  return adminFetch(`/admin/broadcast`, token, {
    method: "POST",
    body: JSON.stringify({ confirm: true, ...params }),
  });
}
