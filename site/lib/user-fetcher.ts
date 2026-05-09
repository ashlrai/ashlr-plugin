// User-side fetch wrapper.
// Reads the user token from localStorage (key: ashlrToken).
// Re-exports the typed API functions from lib/api.ts with token auto-injection
// so callers don't have to thread the token manually.
//
// Usage (in a "use client" component or effect):
//   import { fetchAggregate, fetchBillingStatus } from "@/lib/user-fetcher";
//   const stats = await fetchAggregate();

import {
  fetchAggregate as _fetchAggregate,
  fetchBillingStatus as _fetchBillingStatus,
  triggerSync as _triggerSync,
  fetchCostHistogram as _fetchCostHistogram,
  fetchGenomeGrowth as _fetchGenomeGrowth,
  fetchCrossMachineTimeline as _fetchCrossMachineTimeline,
  fetchTeamAggregates as _fetchTeamAggregates,
  type AggregateStats,
  type BillingStatus,
  type CostHistogramBucket,
  type GenomeGrowthPoint,
  type CrossMachinePoint,
  type TeamAggregates,
} from "@/lib/api";

const TOKEN_KEY = "ashlrToken";

export class UserAuthError extends Error {
  constructor() {
    super("No user token found — redirect to sign-in");
    this.name = "UserAuthError";
  }
}

function getToken(): string {
  const token =
    typeof localStorage !== "undefined"
      ? localStorage.getItem(TOKEN_KEY)
      : null;
  if (!token) throw new UserAuthError();
  return token;
}

/** Fetch the user's aggregate stats. Throws UserAuthError if not signed in. */
export async function fetchAggregate(): Promise<AggregateStats> {
  return _fetchAggregate(getToken());
}

/** Fetch the user's billing status. Throws UserAuthError if not signed in. */
export async function fetchBillingStatus(): Promise<BillingStatus> {
  return _fetchBillingStatus(getToken());
}

/** Trigger a sync for the current user. Throws UserAuthError if not signed in. */
export async function triggerSync(): Promise<void> {
  return _triggerSync(getToken());
}

// Stage 2: Pro user-tier fetchers (token auto-injected)
export async function fetchCostHistogram(windowHours = 720) {
  return _fetchCostHistogram(getToken(), windowHours);
}

export async function fetchGenomeGrowth() {
  return _fetchGenomeGrowth(getToken());
}

export async function fetchCrossMachineTimeline(windowHours = 720) {
  return _fetchCrossMachineTimeline(getToken(), windowHours);
}

export async function fetchTeamAggregates(orgId: string) {
  return _fetchTeamAggregates(getToken(), orgId);
}

// Re-export types so callers can import from one place
export type {
  AggregateStats,
  BillingStatus,
  CostHistogramBucket,
  GenomeGrowthPoint,
  CrossMachinePoint,
  TeamAggregates,
} from "@/lib/api";
