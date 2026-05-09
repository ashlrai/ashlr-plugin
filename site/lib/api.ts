// Typed API helpers for the ashlr dashboard.
// Base URL falls back to production; override via NEXT_PUBLIC_ASHLR_API_URL.

const BASE = process.env.NEXT_PUBLIC_ASHLR_API_URL ?? "https://api.ashlr.ai";

export interface ToolStat {
  tool: string;
  calls: number;
  tokensSaved: number;
  lastWeekTokensSaved: number;
}

export interface DayStat {
  date: string; // ISO yyyy-mm-dd
  tokensSaved: number;
}

export interface MachineStat {
  fingerprintHash: string;
  lastSeen: string; // ISO
  lifetimeTokensSaved: number;
  dominantTool: string;
}

export interface AggregateStats {
  // Session
  sessionTokensSaved: number;
  sessionCalls: number;
  sessionActive: boolean;

  // Lifetime
  lifetimeTokensSaved: number;
  lifetimeCalls: number;
  estimatedDollars: number;

  // Best day
  bestDayDate: string;
  bestDayTokensSaved: number;
  bestDayTopTool: string;

  // Per-tool
  tools: ToolStat[];

  // Sparklines
  last7Days: DayStat[];
  last30Days: DayStat[];

  // Cross-machine (pro only — may be empty for free tier)
  machines: MachineStat[];

  // Pro feature status
  cloudSummarizerActive: boolean;
  crossMachineSyncOn: boolean;
  dailyCapUsed: number;
  dailyCapLimit: number;

  // Meta
  lastSyncedAt: string; // ISO
}

export interface BillingStatus {
  tier: "free" | "pro" | "team";
  email: string;
  renewsAt: string | null;
}

async function apiFetch<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  if (!res.ok) {
    const err = new Error(`API ${res.status}: ${res.statusText}`);
    (err as Error & { status: number }).status = res.status;
    throw err;
  }

  return res.json() as Promise<T>;
}

// Stage 2: Pro user-tier stat types
export interface CostHistogramBucket {
  bucket: string;
  count: number;
}

export interface GenomeGrowthPoint {
  day: string;
  total_bytes: number;
  section_count: number;
}

export interface CrossMachinePoint {
  day: string;
  machine: string;
  tokens_saved: number;
}

export interface TeamAggregates {
  total_tokens_saved: number;
  member_count: number;
  top_tools: { name: string; calls: number }[];
}

export async function fetchAggregate(token: string): Promise<AggregateStats> {
  return apiFetch<AggregateStats>("/stats/aggregate", token);
}

export async function fetchBillingStatus(token: string): Promise<BillingStatus> {
  return apiFetch<BillingStatus>("/billing/status", token);
}

export async function triggerSync(token: string): Promise<void> {
  await fetch(`${BASE}/stats/sync`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

// Stage 2: Pro user-tier endpoints
export async function fetchCostHistogram(
  token: string,
  windowHours = 720,
): Promise<{ buckets: CostHistogramBucket[]; window_hours: number }> {
  return apiFetch(`/stats/cost-histogram?window=${windowHours}`, token);
}

export async function fetchGenomeGrowth(
  token: string,
): Promise<{ rows: GenomeGrowthPoint[] }> {
  return apiFetch("/stats/genome-growth", token);
}

export async function fetchCrossMachineTimeline(
  token: string,
  windowHours = 720,
): Promise<{ rows: CrossMachinePoint[]; window_hours: number }> {
  return apiFetch(`/stats/cross-machine?window=${windowHours}`, token);
}

export async function fetchTeamAggregates(
  token: string,
  orgId: string,
): Promise<TeamAggregates> {
  return apiFetch(`/team/${encodeURIComponent(orgId)}/aggregates`, token);
}
