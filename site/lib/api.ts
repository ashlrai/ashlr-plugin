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
