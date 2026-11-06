"use client";

import { useEffect, useState } from "react";
import { fetchAdminOverview, type OverviewData } from "@/lib/admin-api";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

// ---------------------------------------------------------------------------
// Hero metric card
// ---------------------------------------------------------------------------

function MetricCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p style={{ fontFamily: "var(--font-fraunces), serif", fontSize: 36, fontWeight: 600, color: "var(--ink)", margin: 0, lineHeight: 1.1 }}>
          {value}
        </p>
        {sub && <p className="mono-label" style={{ marginTop: 6 }}>{sub}</p>}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Mini sparkline bar
// ---------------------------------------------------------------------------

function SparkBar({ data, colorByTier }: { data: Array<{ tier: string; date: string; calls: number }>; colorByTier?: boolean }) {
  if (!data.length) return <span className="mono-label">No data</span>;

  // Group by date, sum calls
  const byDate = new Map<string, number>();
  for (const row of data) {
    byDate.set(row.date, (byDate.get(row.date) ?? 0) + row.calls);
  }
  const dates = Array.from(byDate.keys()).sort((a, b) => Number(a > b) - Number(a < b));
  const counts = dates.map((d) => byDate.get(d)!);
  const max = Math.max(...counts, 1);

  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 48 }}>
      {dates.map((date, i) => (
        <div
          key={date}
          title={`${date}: ${counts[i]} calls`}
          style={{
            flex: 1,
            height: `${Math.max(4, (counts[i]! / max) * 48)}px`,
            background: "var(--debit)",
            opacity: 0.7 + (i / dates.length) * 0.3,
            borderRadius: 2,
          }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview page
// ---------------------------------------------------------------------------

function getToken(): string {
  if (typeof window === "undefined") return "";
  // Token is set on the data-admin-token attribute by the layout
  const el = document.querySelector("[data-admin-token]");
  return el?.getAttribute("data-admin-token") ?? localStorage.getItem("ashlr_token") ?? "";
}

export default function AdminOverviewPage() {
  const [data, setData]     = useState<OverviewData | null>(null);
  const [error, setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    fetchAdminOverview(token)
      .then(setData)
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="mono-label">Loading…</p>;
  if (error)   return <p style={{ color: "var(--debit)" }}>{error}</p>;
  if (!data)   return null;

  const { counts, recent_signups, recent_payments, llm_usage_by_tier } = data;
  const mrrDollars = (counts.mrr_cents / 100).toFixed(0);
  const activeSubs = counts.active_pro + counts.active_team;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      <h1 style={{ fontFamily: "var(--font-fraunces), serif", fontSize: 28, fontWeight: 600, color: "var(--ink)", margin: 0 }}>
        Overview
      </h1>

      {/* Hero metrics */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
        <MetricCard
          label="MRR"
          value={`$${mrrDollars}`}
          sub={`${counts.active_pro} pro · ${counts.active_team} team`}
        />
        <MetricCard
          label="Active Subscriptions"
          value={String(activeSubs)}
          sub={`${counts.total_users} total users`}
        />
        <MetricCard
          label="LLM Calls Today"
          value={String(counts.llm_calls_today)}
          sub={`${counts.genome_syncs_today} genome syncs today`}
        />
      </div>

      {/* LLM usage sparkline */}
      <Card>
        <CardHeader>
          <CardTitle>LLM Usage — Last 7 Days</CardTitle>
        </CardHeader>
        <CardContent>
          <SparkBar data={llm_usage_by_tier} />
        </CardContent>
      </Card>

      {/* Two-column lists */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* Recent signups */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Signups</CardTitle>
          </CardHeader>
          <CardContent style={{ paddingTop: 0 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["Email", "Tier", "Joined"].map((h) => (
                    <th key={h} style={{ textAlign: "left", padding: "4px 8px 8px 0", fontFamily: "var(--font-jetbrains), monospace", fontSize: 10, letterSpacing: "0.15em", textTransform: "uppercase", color: "var(--ink-55)", borderBottom: "1px solid var(--ink-10)" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recent_signups.map((u) => (
                  <tr key={u.id} style={{ borderBottom: "1px solid var(--ink-10)" }}>
                    <td style={{ padding: "8px 8px 8px 0", fontFamily: "var(--font-jetbrains), monospace", fontSize: 12, color: "var(--ink-80)" }}>{u.email}</td>
                    <td style={{ padding: "8px 8px 8px 0" }}>
                      <TierBadge tier={u.tier} />
                    </td>
                    <td style={{ padding: "8px 8px 8px 0", fontFamily: "var(--font-jetbrains), monospace", fontSize: 11, color: "var(--ink-55)" }}>
                      {formatDate(u.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        {/* Recent payments */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Payments</CardTitle>
          </CardHeader>
          <CardContent style={{ paddingTop: 0 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["Email", "Tier", "Date"].map((h) => (
                    <th key={h} style={{ textAlign: "left", padding: "4px 8px 8px 0", fontFamily: "var(--font-jetbrains), monospace", fontSize: 10, letterSpacing: "0.15em", textTransform: "uppercase", color: "var(--ink-55)", borderBottom: "1px solid var(--ink-10)" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recent_payments.map((p) => (
                  <tr key={p.stripe_subscription_id} style={{ borderBottom: "1px solid var(--ink-10)" }}>
                    <td style={{ padding: "8px 8px 8px 0", fontFamily: "var(--font-jetbrains), monospace", fontSize: 12, color: "var(--ink-80)" }}>{p.email}</td>
                    <td style={{ padding: "8px 8px 8px 0" }}>
                      <TierBadge tier={p.tier} />
                    </td>
                    <td style={{ padding: "8px 8px 8px 0", fontFamily: "var(--font-jetbrains), monospace", fontSize: 11, color: "var(--ink-55)" }}>
                      {formatDate(p.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function TierBadge({ tier }: { tier: string }) {
  const colors: Record<string, string> = {
    pro:  "var(--debit)",
    team: "var(--credit)",
    free: "var(--ink-30)",
  };
  return (
    <span style={{
      fontFamily: "var(--font-jetbrains), monospace",
      fontSize: 10,
      letterSpacing: "0.12em",
      textTransform: "uppercase",
      color: colors[tier] ?? "var(--ink-55)",
      border: `1px solid currentColor`,
      borderRadius: 3,
      padding: "1px 5px",
    }}>
      {tier}
    </span>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch { return iso; }
}
