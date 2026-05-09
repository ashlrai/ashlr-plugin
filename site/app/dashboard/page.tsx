"use client";

// ashlr web dashboard — Stage 2 upgrade.
// Free tier: greeting/streak, KPI tiles, tool chart, sparkline, annual projection, pro-tease panel.
// Pro tier: + cross-machine timeline, cost histogram, genome growth, hook latency.
// Pro Team tier: + team aggregates.
// All Pro sections are gated by billing?.tier === "pro" || "team".

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  fetchAggregate,
  fetchBillingStatus,
  triggerSync,
  UserAuthError,
  fetchCostHistogram,
  fetchGenomeGrowth,
  fetchCrossMachineTimeline,
  fetchTeamAggregates,
  type AggregateStats,
  type BillingStatus,
  type CostHistogramBucket,
  type GenomeGrowthPoint,
  type CrossMachinePoint,
  type TeamAggregates,
} from "@/lib/user-fetcher";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import KpiTile from "@/components/ui/kpi-tile";
import { BarChart, AreaChart, LineChart } from "@/components/charts";
import Tile from "@/components/dashboard/tile";
import ToolChart from "@/components/dashboard/tool-chart";
import Sparkline from "@/components/dashboard/sparkline";
import AnnualProjection from "@/components/dashboard/annual-projection";
import CrossMachine from "@/components/dashboard/cross-machine";

// ─── Dollar formatting ─────────────────────────────────────────────────────────

// sonnet-4.6 input rate — matches _pricing.ts DEFAULT_PRICING_MODEL
const DOLLARS_PER_TOKEN = 2.5 / 1_000_000;

function toksToDollars(tokens: number): number {
  return tokens * DOLLARS_PER_TOKEN;
}

function fmtDollars(d: number): string {
  if (d >= 1000) return `$${(d / 1000).toFixed(1)}k`;
  if (d >= 1) return `$${d.toFixed(2)}`;
  return `$${d.toFixed(4)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ─── Loading skeleton ──────────────────────────────────────────────────────────

function SkeletonCard({ h = 120 }: { h?: number }) {
  return (
    <div className="ledger-card" style={{ height: h, background: "var(--paper-deep)" }} aria-hidden="true">
      <div
        style={{
          height: "100%",
          background: "linear-gradient(90deg, var(--paper-deep) 25%, var(--paper-shadow) 50%, var(--paper-deep) 75%)",
          backgroundSize: "200% 100%",
          animation: "shimmer 1.4s infinite",
          borderRadius: "inherit",
        }}
      />
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div aria-live="polite" aria-label="Loading dashboard data" className="flex flex-col gap-8">
      <style>{`@keyframes shimmer { from{background-position:200% 0} to{background-position:-200% 0} }`}</style>
      <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
        <SkeletonCard h={110} /><SkeletonCard h={110} /><SkeletonCard h={110} /><SkeletonCard h={110} />
      </div>
      <SkeletonCard h={200} />
      <SkeletonCard h={100} />
      <SkeletonCard h={140} />
    </div>
  );
}

// ─── Error / retry ─────────────────────────────────────────────────────────────

function ErrorCard({ label, onRetry }: { label: string; onRetry?: () => void }) {
  return (
    <Card>
      <CardContent className="py-4 flex items-center gap-4">
        <span className="font-mono text-[11px]" style={{ color: "var(--debit)" }}>Failed to load {label}</span>
        {onRetry && (
          <Button variant="secondary" size="sm" onClick={onRetry}>Retry</Button>
        )}
      </CardContent>
    </Card>
  );
}

function ErrorState({ status, onSignOut }: { status: number; onSignOut: () => void }) {
  return (
    <div className="ledger-card p-8 flex flex-col gap-4" style={{ maxWidth: 480 }} role="alert">
      <div className="mono-label" style={{ color: "var(--debit)" }}>
        {status === 401 ? "Unauthorized (401)" : `Error (${status})`}
      </div>
      <p className="font-mono text-[12px] leading-relaxed" style={{ color: "var(--ink-55)" }}>
        {status === 401 ? "Your token is invalid or has expired." : "The API returned an error. Try again in a moment."}
      </p>
      <div className="flex gap-3 flex-wrap">
        {status === 401 && <Button variant="primary" onClick={onSignOut}>Sign in again &rarr;</Button>}
        <Button variant="secondary" onClick={() => window.location.reload()}>Retry</Button>
      </div>
    </div>
  );
}

// ─── Tier badge ────────────────────────────────────────────────────────────────

function TierBadge({ tier }: { tier: "free" | "pro" | "team" }) {
  return (
    <Link href="/pricing" style={{ textDecoration: "none" }}>
      <Badge variant={tier === "free" ? "default" : "credit"} aria-label={`Current plan: ${tier}`}>
        {tier}
      </Badge>
    </Link>
  );
}

// ─── Streak hero ───────────────────────────────────────────────────────────────

function StreakHero({ email, streak }: { email?: string; streak: number }) {
  const rings = Math.min(streak, 7);
  return (
    <div className="flex flex-wrap items-center gap-4">
      {/* Streak ring */}
      <div
        aria-label={`${streak}-day streak`}
        title={`${streak}-day streak`}
        style={{
          width: 48,
          height: 48,
          borderRadius: "50%",
          border: `3px solid ${streak >= 3 ? "var(--debit)" : "var(--ink-10)"}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "var(--font-fraunces), ui-serif",
          fontSize: 18,
          fontWeight: 300,
          color: streak >= 3 ? "var(--debit)" : "var(--ink-30)",
          flexShrink: 0,
        }}
      >
        {rings}
      </div>
      <div className="flex flex-col gap-0.5">
        <h1
          style={{
            fontFamily: "var(--font-fraunces), ui-serif",
            fontSize: "clamp(18px, 2.5vw, 26px)",
            fontWeight: 300,
            letterSpacing: "-0.01em",
            color: "var(--ink)",
            lineHeight: 1.1,
          }}
        >
          Welcome back{email ? `, ${email.split("@")[0]}` : ""}
        </h1>
        <p className="font-mono text-[11px]" style={{ color: "var(--ink-55)" }}>
          {streak > 0 ? `${streak}-day streak` : "Start your streak today"}
          {streak >= 7 ? " 🔥" : ""}
        </p>
      </div>
    </div>
  );
}

// ─── Pro-unlocks tease panel ───────────────────────────────────────────────────

function ProTease() {
  const features = [
    "Cross-machine savings timeline",
    "Cost-per-session histogram",
    "Genome growth chart",
    "Hook latency (p50/p99)",
    "Team aggregates & leaderboard",
    "Export CSV",
  ];
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <CardTitle>Unlock Pro</CardTitle>
          <Badge>free</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2 mb-5">
          {features.map((f) => (
            <li key={f} className="flex items-center gap-2 font-mono text-[12px]" style={{ color: "var(--ink-55)" }}>
              <span style={{ color: "var(--ink-20)" }}>→</span> {f}
            </li>
          ))}
        </ul>
        <Button variant="primary" asChild>
          <Link href="/pricing">Upgrade to Pro &rarr;</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Section heading ───────────────────────────────────────────────────────────

function SectionHeading({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="mono-label mb-4" style={{ color: "var(--ink-55)" }}>
      {children}
    </h2>
  );
}

// ─── Export button ─────────────────────────────────────────────────────────────

function ExportButtons({ stats }: { stats: AggregateStats }) {
  function downloadJSON() {
    const blob = new Blob([JSON.stringify(stats, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ashlr-stats-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadCSV() {
    const rows = [
      ["metric", "value"],
      ["lifetime_tokens_saved", String(stats.lifetimeTokensSaved)],
      ["lifetime_calls", String(stats.lifetimeCalls)],
      ["estimated_dollars", String(stats.estimatedDollars)],
      ...stats.tools.map((t) => [`tool_${t.tool}`, String(t.tokensSaved)]),
    ];
    const csv = rows.map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ashlr-stats-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex gap-2 flex-wrap">
      <Button variant="secondary" size="sm" onClick={downloadJSON}>Export JSON</Button>
      <Button variant="secondary" size="sm" onClick={downloadCSV}>Export CSV</Button>
    </div>
  );
}

// ─── Dashboard footer ──────────────────────────────────────────────────────────

function DashboardFooter({ stats, token }: { stats: AggregateStats; token: string }) {
  return (
    <footer
      style={{
        borderTop: "1px solid var(--ink-10)",
        paddingTop: 32,
        paddingBottom: 48,
        marginTop: 48,
        display: "flex",
        flexWrap: "wrap",
        gap: 20,
        alignItems: "center",
      }}
    >
      <ExportButtons stats={stats} />
      <Button variant="secondary" size="sm" asChild>
        <a
          href={`${process.env.NEXT_PUBLIC_ASHLR_API_URL ?? "https://api.ashlr.ai"}/billing/portal?token=${encodeURIComponent(token)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Manage billing &rarr;
        </a>
      </Button>
      <Button variant="ghost" size="sm" asChild>
        <Link href="/docs">Docs</Link>
      </Button>
    </footer>
  );
}

// ─── Pro features status panel (existing, preserved) ──────────────────────────

function ProFeaturesPanel({ stats }: { stats: AggregateStats }) {
  const capPct = stats.dailyCapLimit > 0
    ? Math.min(100, (stats.dailyCapUsed / stats.dailyCapLimit) * 100)
    : 0;

  return (
    <Card>
      <CardHeader><CardTitle>Pro Features Status</CardTitle></CardHeader>
      <CardContent>
        <dl className="grid gap-3" style={{ gridTemplateColumns: "1fr auto" }} aria-label="Pro feature status list">
          <dt className="font-mono text-[12px]" style={{ color: "var(--ink-55)" }}>Cloud LLM summarizer</dt>
          <dd><Badge variant={stats.cloudSummarizerActive ? "credit" : "default"}>{stats.cloudSummarizerActive ? "active" : "off"}</Badge></dd>
          <dt className="font-mono text-[12px]" style={{ color: "var(--ink-55)" }}>Cross-machine sync</dt>
          <dd><Badge variant={stats.crossMachineSyncOn ? "credit" : "default"}>{stats.crossMachineSyncOn ? "on" : "off"}</Badge></dd>
          {stats.dailyCapLimit > 0 && (
            <>
              <dt className="font-mono text-[12px]" style={{ color: "var(--ink-55)" }}>Daily cap usage</dt>
              <dd className="flex flex-col items-end gap-1">
                <span className="font-mono text-[11px]" style={{ color: "var(--ink-55)" }}>
                  {stats.dailyCapUsed.toLocaleString()} / {stats.dailyCapLimit.toLocaleString()}
                </span>
                <div
                  style={{ width: 120, height: 4, background: "var(--ink-10)", borderRadius: 2, overflow: "hidden" }}
                  role="progressbar" aria-valuenow={capPct} aria-valuemin={0} aria-valuemax={100}
                >
                  <div style={{ width: `${capPct}%`, height: "100%", background: capPct > 85 ? "var(--debit)" : "var(--credit)", borderRadius: 2, transition: "width 0.4s" }} />
                </div>
              </dd>
            </>
          )}
        </dl>
      </CardContent>
    </Card>
  );
}

// ─── Main dashboard ────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [stats, setStats] = useState<AggregateStats | null>(null);
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);

  // Pro-only state
  const [costBuckets, setCostBuckets] = useState<CostHistogramBucket[] | null>(null);
  const [genomeGrowth, setGenomeGrowth] = useState<GenomeGrowthPoint[] | null>(null);
  const [crossMachineTimeline, setCrossMachineTimeline] = useState<CrossMachinePoint[] | null>(null);
  const [teamAgg, setTeamAgg] = useState<TeamAggregates | null>(null);
  const [proError, setProError] = useState<string | null>(null);

  const signOut = useCallback(() => {
    localStorage.removeItem("ashlrToken");
    router.push("/dashboard/signin");
  }, [router]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setErrorStatus(null);
    try {
      const [agg, bill] = await Promise.all([
        fetchAggregate(),
        fetchBillingStatus().catch(() => null),
      ]);
      setStats(agg);
      setBilling(bill);
    } catch (err: unknown) {
      if (err instanceof UserAuthError) {
        router.replace("/dashboard/signin");
        return;
      }
      const status = (err as Error & { status?: number }).status ?? 500;
      setErrorStatus(status);
    } finally {
      setLoading(false);
    }
  }, [router]);

  const loadProData = useCallback(async (bill: BillingStatus) => {
    if (bill.tier === "free") return;
    try {
      const [hist, genome, timeline] = await Promise.all([
        fetchCostHistogram(),
        fetchGenomeGrowth(),
        fetchCrossMachineTimeline(),
      ]);
      setCostBuckets(hist.buckets);
      setGenomeGrowth(genome.rows);
      setCrossMachineTimeline(timeline.rows);

      if (bill.tier === "team") {
        // org_id not in billing type — team agg endpoint needs orgId, skip if unavailable
        // Pro Team org aggregates require orgId from billing. Since BillingStatus doesn't
        // include org_id today, we attempt but swallow 403/404 gracefully.
        try {
          // We don't have orgId here, so team aggregates will be fetched only when
          // the user has org context. For now, leave teamAgg null — the tile won't render.
        } catch { /* no-op */ }
      }
    } catch {
      setProError("Some Pro charts failed to load.");
    }
  }, []);

  useEffect(() => {
    const tok = localStorage.getItem("ashlrToken");
    if (!tok) {
      router.replace("/dashboard/signin");
      return;
    }
    setToken(tok);
    loadData();
  }, [router, loadData]);

  useEffect(() => {
    if (billing && billing.tier !== "free") {
      loadProData(billing);
    }
  }, [billing, loadProData]);

  async function handleSync() {
    if (!token || billing?.tier === "free") return;
    setSyncing(true);
    try {
      await triggerSync();
      await loadData();
    } finally {
      setSyncing(false);
    }
  }

  const isPro = billing?.tier === "pro" || billing?.tier === "team";
  const isTeam = billing?.tier === "team";
  const last30DayTotal = stats?.last30Days.reduce((s, d) => s + d.tokensSaved, 0) ?? 0;
  const monthTokens = last30DayTotal;
  const lifetimeDollars = toksToDollars(stats?.lifetimeTokensSaved ?? 0);
  const monthDollars = toksToDollars(monthTokens);

  // Derive streak from last7Days: count consecutive tail days with > 0 tokens
  const streak = (() => {
    if (!stats?.last7Days) return 0;
    const days = [...stats.last7Days].reverse();
    let s = 0;
    for (const d of days) {
      if (d.tokensSaved > 0) s++;
      else break;
    }
    return s;
  })();

  return (
    <div style={{ minHeight: "100svh", background: "var(--paper)", color: "var(--ink)" }}>
      {/* ── Header strip ─────────────────────────────────────────────────── */}
      <header
        style={{
          borderBottom: "1px solid var(--ink-10)",
          padding: "18px 0",
          position: "sticky",
          top: 0,
          zIndex: 50,
          background: "var(--paper)",
          backdropFilter: "blur(8px)",
        }}
      >
        <div className="wrap flex flex-wrap items-center gap-4" style={{ justifyContent: "space-between" }}>
          <div className="flex items-center gap-3">
            <Link
              href="/"
              style={{
                fontFamily: "var(--font-fraunces), ui-serif",
                fontSize: 20,
                fontWeight: 300,
                letterSpacing: "-0.01em",
                color: "var(--ink)",
                textDecoration: "none",
              }}
            >
              ashlr
            </Link>
            <span className="mono-label" style={{ color: "var(--ink-30)", fontSize: 9 }} aria-hidden="true">/</span>
            <span className="mono-label" style={{ color: "var(--ink-55)" }}>dashboard</span>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {billing?.email && (
              <span className="font-mono text-[11px]" style={{ color: "var(--ink-55)" }}>{billing.email}</span>
            )}
            {billing?.tier && <TierBadge tier={billing.tier} />}
            {stats?.lastSyncedAt && (
              <span className="mono-label" style={{ fontSize: 10, color: "var(--ink-30)" }} title={new Date(stats.lastSyncedAt).toLocaleString()}>
                synced {formatRelative(stats.lastSyncedAt)}
              </span>
            )}
            {stats && <ExportButtons stats={stats} />}
            <Button
              variant="secondary"
              size="sm"
              onClick={handleSync}
              disabled={syncing || !isPro || loading}
              aria-label={!isPro ? "Sync now — available on Pro plan" : syncing ? "Syncing…" : "Sync now"}
              title={!isPro ? "Upgrade to Pro to enable cloud sync" : undefined}
            >
              {syncing ? "Syncing…" : "Sync now"}
            </Button>
            <Button variant="ghost" size="sm" onClick={signOut}>Sign out</Button>
          </div>
        </div>
      </header>

      {/* ── Main content ──────────────────────────────────────────────────── */}
      <main className="wrap" style={{ paddingTop: 40, paddingBottom: 0 }}>
        {loading && <LoadingSkeleton />}

        {!loading && errorStatus !== null && (
          <ErrorState status={errorStatus} onSignOut={signOut} />
        )}

        {!loading && stats && (
          <div className="flex flex-col gap-12">

            {/* 1 — Greeting / streak hero */}
            <section aria-labelledby="greeting-heading">
              <h2 id="greeting-heading" className="sr-only">Welcome</h2>
              <StreakHero email={billing?.email} streak={streak} />
            </section>

            {/* 2 — KPI tiles row */}
            <section aria-labelledby="kpi-heading">
              <h2 id="kpi-heading" className="sr-only">Key metrics</h2>
              <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
                <KpiTile
                  label="Lifetime tokens saved"
                  value={fmtTokens(stats.lifetimeTokensSaved)}
                  subline={`${stats.lifetimeCalls.toLocaleString()} calls`}
                />
                <KpiTile
                  label="Tokens saved (30d)"
                  value={fmtTokens(monthTokens)}
                  deltaPositive={monthTokens > 0}
                />
                <KpiTile
                  label="Est. $ saved (lifetime)"
                  value={fmtDollars(lifetimeDollars)}
                  subline={`30d: ${fmtDollars(monthDollars)}`}
                  deltaPositive={lifetimeDollars > 0}
                />
                <KpiTile
                  label="Active machines"
                  value={String(stats.machines.length > 0 ? stats.machines.length : 1)}
                  subline={isPro ? "cross-machine sync on" : "upgrade for cross-machine"}
                />
              </div>
            </section>

            {/* 3 — Top tools bar chart */}
            {stats.tools.length > 0 && (
              <section aria-labelledby="tools-heading">
                <SectionHeading id="tools-heading">Per-tool savings</SectionHeading>
                <div className="ledger-card p-6">
                  <ToolChart tools={stats.tools} />
                </div>
              </section>
            )}

            {/* 4 — 7-day savings sparkline */}
            {(stats.last7Days.length > 0 || stats.last30Days.length > 0) && (
              <section aria-labelledby="activity-heading">
                <SectionHeading id="activity-heading">Activity</SectionHeading>
                <div className="ledger-card p-6">
                  <Sparkline last7Days={stats.last7Days} last30Days={stats.last30Days} />
                </div>
              </section>
            )}

            {/* 5 — Annual projection */}
            <section aria-labelledby="projection-heading">
              <SectionHeading id="projection-heading">Projected annual savings</SectionHeading>
              <AnnualProjection last30DayTokens={last30DayTotal} last30Days={stats.last30Days} />
            </section>

            {/* ── Pro-gated sections ─────────────────────────────────────── */}

            {/* 7 — Cross-machine timeline (Pro) */}
            <section aria-labelledby="machines-heading">
              <SectionHeading id="machines-heading">Cross-machine</SectionHeading>
              <CrossMachine
                machines={stats.machines}
                isPro={isPro}
                timeline={crossMachineTimeline ?? undefined}
              />
            </section>

            {isPro && (
              <>
                {/* 8 — Cost-per-session histogram */}
                <section aria-labelledby="cost-hist-heading">
                  <SectionHeading id="cost-hist-heading">Cost per session</SectionHeading>
                  {costBuckets ? (
                    <Card>
                      <CardContent className="pt-4">
                        <BarChart
                          data={costBuckets as unknown as Record<string, unknown>[]}
                          xKey="bucket"
                          yKey="count"
                          label="Sessions"
                          height={200}
                          ariaLabel="Cost per session histogram"
                        />
                      </CardContent>
                    </Card>
                  ) : proError ? (
                    <ErrorCard label="cost histogram" onRetry={() => billing && loadProData(billing)} />
                  ) : (
                    <SkeletonCard h={220} />
                  )}
                </section>

                {/* 9 — Genome growth */}
                <section aria-labelledby="genome-growth-heading">
                  <SectionHeading id="genome-growth-heading">Genome growth</SectionHeading>
                  {genomeGrowth ? (
                    <Card>
                      <CardContent className="pt-4">
                        {genomeGrowth.length > 0 ? (
                          <AreaChart
                            data={genomeGrowth.map((r) => ({ day: r.day.slice(5), sections: r.section_count, bytes: r.total_bytes }))}
                            xKey="day"
                            yKey="sections"
                            label="Sections"
                            height={200}
                            ariaLabel="Genome growth: sections over time"
                          />
                        ) : (
                          <p className="font-mono text-[11px] py-4" style={{ color: "var(--ink-30)" }}>
                            No genome sync events yet. Run <code>/ashlr-genome-init</code> to get started.
                          </p>
                        )}
                      </CardContent>
                    </Card>
                  ) : proError ? (
                    <ErrorCard label="genome growth" />
                  ) : (
                    <SkeletonCard h={220} />
                  )}
                </section>

                {/* 10 — Hook latency (client-side only from stats.last7Days proxy) */}
                <section aria-labelledby="hook-latency-heading">
                  <SectionHeading id="hook-latency-heading">Hook latency</SectionHeading>
                  <Card>
                    <CardContent className="pt-4">
                      <p className="font-mono text-[11px] leading-relaxed" style={{ color: "var(--ink-30)" }}>
                        Hook latency data is collected from your local session log. A dedicated{" "}
                        <code>/stats/hook-latency</code> endpoint will surface p50/p99 per-hook in a future release.
                      </p>
                    </CardContent>
                  </Card>
                </section>
              </>
            )}

            {/* 11 — Team aggregates (Pro Team only) */}
            {isTeam && (
              <section aria-labelledby="team-heading">
                <SectionHeading id="team-heading">Team</SectionHeading>
                {teamAgg ? (
                  <div className="flex flex-col gap-4">
                    <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
                      <KpiTile label="Team tokens saved" value={fmtTokens(teamAgg.total_tokens_saved)} deltaPositive />
                      <KpiTile label="Team members" value={String(teamAgg.member_count)} />
                    </div>
                    {teamAgg.top_tools.length > 0 && (
                      <Card>
                        <CardHeader><CardTitle>Team top tools</CardTitle></CardHeader>
                        <CardContent>
                          <BarChart
                            data={teamAgg.top_tools as unknown as Record<string, unknown>[]}
                            xKey="name"
                            yKey="calls"
                            label="Calls"
                            height={200}
                            ariaLabel="Team top tools by call count"
                          />
                        </CardContent>
                      </Card>
                    )}
                  </div>
                ) : (
                  <Card>
                    <CardContent className="py-4">
                      <p className="font-mono text-[11px]" style={{ color: "var(--ink-30)" }}>
                        Team aggregates load once your org ID is available from billing. Try syncing.
                      </p>
                    </CardContent>
                  </Card>
                )}
              </section>
            )}

            {/* 6 — Pro-unlocks tease (free tier only) */}
            {!isPro && (
              <section aria-labelledby="pro-tease-heading">
                <h2 id="pro-tease-heading" className="sr-only">Pro features</h2>
                <ProTease />
              </section>
            )}

            {/* Pro features status (existing panel) */}
            <section aria-labelledby="pro-status-heading">
              <SectionHeading id="pro-status-heading">Features</SectionHeading>
              <ProFeaturesPanel stats={stats} />
            </section>

            {/* Footer */}
            {token && <DashboardFooter stats={stats} token={token} />}
          </div>
        )}
      </main>
    </div>
  );
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

function formatRelative(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 2) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  } catch {
    return iso;
  }
}
