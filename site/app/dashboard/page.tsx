"use client";

// ashlr web dashboard — authenticated, fetches from /stats/aggregate.
// Redirects to /dashboard/signin if no token in localStorage.
// Sections: header strip, hero tiles, tool chart, sparklines,
//           annual projection, cross-machine (pro-only), pro features status, footer.

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  fetchAggregate,
  fetchBillingStatus,
  triggerSync,
  type AggregateStats,
  type BillingStatus,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import Tile from "@/components/dashboard/tile";
import ToolChart from "@/components/dashboard/tool-chart";
import Sparkline from "@/components/dashboard/sparkline";
import AnnualProjection from "@/components/dashboard/annual-projection";
import CrossMachine from "@/components/dashboard/cross-machine";

// ─── Loading skeleton ──────────────────────────────────────────────────────────

function SkeletonCard({ h = 120 }: { h?: number }) {
  return (
    <div
      className="ledger-card"
      style={{ height: h, background: "var(--paper-deep)" }}
      aria-hidden="true"
    >
      <div
        style={{
          height: "100%",
          background:
            "linear-gradient(90deg, var(--paper-deep) 25%, var(--paper-shadow) 50%, var(--paper-deep) 75%)",
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
    <div
      aria-live="polite"
      aria-label="Loading dashboard data"
      className="flex flex-col gap-8"
    >
      <style>{`@keyframes shimmer { from{background-position:200% 0} to{background-position:-200% 0} }`}</style>
      <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        <SkeletonCard h={140} />
        <SkeletonCard h={140} />
        <SkeletonCard h={140} />
      </div>
      <SkeletonCard h={200} />
      <SkeletonCard h={100} />
      <SkeletonCard h={120} />
    </div>
  );
}

// ─── Error state ───────────────────────────────────────────────────────────────

function ErrorState({ status, onSignOut }: { status: number; onSignOut: () => void }) {
  return (
    <div
      className="ledger-card p-8 flex flex-col gap-4"
      style={{ maxWidth: 480 }}
      role="alert"
    >
      <div className="mono-label" style={{ color: "var(--debit)" }}>
        {status === 401 ? "Unauthorized (401)" : `Error (${status})`}
      </div>
      <p className="font-mono text-[12px] leading-relaxed" style={{ color: "var(--ink-55)" }}>
        {status === 401
          ? "Your token is invalid or has expired."
          : "The API returned an error. Try again in a moment."}
      </p>
      <div className="flex gap-3 flex-wrap">
        {status === 401 && (
          <Button variant="primary" onClick={onSignOut}>
            Sign in again &rarr;
          </Button>
        )}
        <Button variant="secondary" onClick={() => window.location.reload()}>
          Retry
        </Button>
      </div>
    </div>
  );
}

// ─── Tier badge ────────────────────────────────────────────────────────────────

function TierBadge({ tier }: { tier: "free" | "pro" | "team" }) {
  return (
    <Link href="/pricing" style={{ textDecoration: "none" }}>
      <Badge
        variant={tier === "free" ? "default" : "credit"}
        aria-label={`Current plan: ${tier}. Click to view pricing.`}
      >
        {tier}
      </Badge>
    </Link>
  );
}

// ─── Pro features panel ────────────────────────────────────────────────────────

function ProFeaturesPanel({ stats }: { stats: AggregateStats }) {
  const capPct =
    stats.dailyCapLimit > 0
      ? Math.min(100, (stats.dailyCapUsed / stats.dailyCapLimit) * 100)
      : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pro Features Status</CardTitle>
      </CardHeader>
      <CardContent>
        <dl
          className="grid gap-3"
          style={{ gridTemplateColumns: "1fr auto" }}
          aria-label="Pro feature status list"
        >
          <dt className="font-mono text-[12px]" style={{ color: "var(--ink-55)" }}>
            Cloud LLM summarizer
          </dt>
          <dd>
            <Badge variant={stats.cloudSummarizerActive ? "credit" : "default"}>
              {stats.cloudSummarizerActive ? "active" : "off"}
            </Badge>
          </dd>

          <dt className="font-mono text-[12px]" style={{ color: "var(--ink-55)" }}>
            Cross-machine sync
          </dt>
          <dd>
            <Badge variant={stats.crossMachineSyncOn ? "credit" : "default"}>
              {stats.crossMachineSyncOn ? "on" : "off"}
            </Badge>
          </dd>

          {stats.dailyCapLimit > 0 && (
            <>
              <dt className="font-mono text-[12px]" style={{ color: "var(--ink-55)" }}>
                Daily cap usage
              </dt>
              <dd className="flex flex-col items-end gap-1">
                <span
                  className="font-mono text-[11px]"
                  style={{ color: "var(--ink-55)" }}
                >
                  {stats.dailyCapUsed.toLocaleString()} / {stats.dailyCapLimit.toLocaleString()}
                </span>
                <div
                  style={{
                    width: 120,
                    height: 4,
                    background: "var(--ink-10)",
                    borderRadius: 2,
                    overflow: "hidden",
                  }}
                  role="progressbar"
                  aria-valuenow={capPct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`Daily cap: ${capPct.toFixed(0)}% used`}
                >
                  <div
                    style={{
                      width: `${capPct}%`,
                      height: "100%",
                      background: capPct > 85 ? "var(--debit)" : "var(--credit)",
                      borderRadius: 2,
                      transition: "width 0.4s",
                    }}
                  />
                </div>
              </dd>
            </>
          )}
        </dl>
      </CardContent>
    </Card>
  );
}

// ─── Dashboard footer ──────────────────────────────────────────────────────────

function DashboardFooter({
  stats,
  token,
}: {
  stats: AggregateStats;
  token: string;
}) {
  function downloadJSON() {
    const blob = new Blob([JSON.stringify(stats, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ashlr-stats-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

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
      <Button variant="secondary" size="sm" onClick={downloadJSON}>
        Download your data (JSON)
      </Button>
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

// ─── Section heading ───────────────────────────────────────────────────────────

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mono-label mb-4" style={{ color: "var(--ink-55)" }}>
      {children}
    </h2>
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

  const signOut = useCallback(() => {
    localStorage.removeItem("ashlrToken");
    router.push("/dashboard/signin");
  }, [router]);

  const loadData = useCallback(async (tok: string) => {
    setLoading(true);
    setErrorStatus(null);
    try {
      const [agg, bill] = await Promise.all([
        fetchAggregate(tok),
        fetchBillingStatus(tok).catch(() => null), // billing endpoint optional
      ]);
      setStats(agg);
      setBilling(bill);
    } catch (err: unknown) {
      const status = (err as Error & { status?: number }).status ?? 500;
      setErrorStatus(status);
    } finally {
      setLoading(false);
    }
  }, []);

  // On mount: check token in localStorage.
  useEffect(() => {
    const tok = localStorage.getItem("ashlrToken");
    if (!tok) {
      router.replace("/dashboard/signin");
      return;
    }
    setToken(tok);
    loadData(tok);
  }, [router, loadData]);

  async function handleSync() {
    if (!token || billing?.tier === "free") return;
    setSyncing(true);
    try {
      await triggerSync(token);
      await loadData(token);
    } finally {
      setSyncing(false);
    }
  }

  const isPro = billing?.tier === "pro" || billing?.tier === "team";
  const last30DayTotal = stats?.last30Days.reduce((s, d) => s + d.tokensSaved, 0) ?? 0;

  return (
    <div
      style={{
        minHeight: "100svh",
        background: "var(--paper)",
        color: "var(--ink)",
      }}
    >
      {/* ── Header strip ──────────────────────────────────────────────────── */}
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
        <div
          className="wrap flex flex-wrap items-center gap-4"
          style={{ justifyContent: "space-between" }}
        >
          {/* Left: wordmark + badge */}
          <div className="flex items-center gap-3">
            <Link
              href="/"
              style={{
                fontFamily: "var(--font-fraunces), ui-serif",
                fontSize: 20,
                fontWeight: 300,
                letterSpacing: "-0.01em",
                fontVariationSettings: '"SOFT" 30, "opsz" 30',
                color: "var(--ink)",
                textDecoration: "none",
              }}
            >
              ashlr
            </Link>
            <span
              className="mono-label"
              style={{ color: "var(--ink-30)", fontSize: 9 }}
              aria-hidden="true"
            >
              /
            </span>
            <span
              className="mono-label"
              style={{ color: "var(--ink-55)" }}
            >
              dashboard
            </span>
          </div>

          {/* Right: email + tier + last sync + sync button */}
          <div className="flex flex-wrap items-center gap-3">
            {billing?.email && (
              <span
                className="font-mono text-[11px]"
                style={{ color: "var(--ink-55)" }}
              >
                {billing.email}
              </span>
            )}
            {billing?.tier && <TierBadge tier={billing.tier} />}
            {stats?.lastSyncedAt && (
              <span
                className="mono-label"
                style={{ fontSize: 10, color: "var(--ink-30)" }}
                title={new Date(stats.lastSyncedAt).toLocaleString()}
              >
                synced {formatRelative(stats.lastSyncedAt)}
              </span>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={handleSync}
              disabled={syncing || !isPro || loading}
              aria-label={
                !isPro
                  ? "Sync now — available on Pro plan"
                  : syncing
                  ? "Syncing…"
                  : "Sync now"
              }
              title={!isPro ? "Upgrade to Pro to enable cloud sync" : undefined}
            >
              {syncing ? "Syncing\u2026" : "Sync now"}
            </Button>
            <Button variant="ghost" size="sm" onClick={signOut}>
              Sign out
            </Button>
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
            {/* ── Hero tiles ─────────────────────────────────────────────── */}
            <section aria-labelledby="hero-heading">
              <h2 id="hero-heading" className="sr-only">At a glance</h2>
              <div
                className="grid gap-4"
                style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}
              >
                <Tile
                  label="This session"
                  primaryValue={stats.sessionTokensSaved}
                  primarySuffix="tokens"
                  secondaryLabel="calls"
                  secondaryValue={stats.sessionCalls}
                  secondaryDecimals={0}
                  active={stats.sessionActive}
                />
                <Tile
                  label="Lifetime"
                  primaryValue={stats.lifetimeTokensSaved}
                  primarySuffix="tokens"
                  secondaryLabel="est."
                  secondaryValue={stats.estimatedDollars}
                  secondaryPrefix="$"
                  secondaryDecimals={2}
                />
                <Tile
                  label="Best day ever"
                  primaryValue={stats.bestDayTokensSaved}
                  primarySuffix="tokens"
                  subline={`${formatDate(stats.bestDayDate)} \u00b7 ${stats.bestDayTopTool}`}
                />
              </div>
            </section>

            {/* ── Per-tool bar chart ──────────────────────────────────────── */}
            {stats.tools.length > 0 && (
              <section aria-labelledby="tools-heading">
                <SectionHeading>
                  <span id="tools-heading">Per-tool savings</span>
                </SectionHeading>
                <div className="ledger-card p-6">
                  <ToolChart tools={stats.tools} />
                </div>
              </section>
            )}

            {/* ── Sparklines ─────────────────────────────────────────────── */}
            {(stats.last7Days.length > 0 || stats.last30Days.length > 0) && (
              <section aria-labelledby="sparklines-heading">
                <SectionHeading>
                  <span id="sparklines-heading">Activity</span>
                </SectionHeading>
                <div className="ledger-card p-6">
                  <Sparkline
                    last7Days={stats.last7Days}
                    last30Days={stats.last30Days}
                  />
                </div>
              </section>
            )}

            {/* ── Annual projection ──────────────────────────────────────── */}
            <section aria-labelledby="projection-heading">
              <SectionHeading>
                <span id="projection-heading">Projected annual savings</span>
              </SectionHeading>
              <AnnualProjection last30DayTokens={last30DayTotal} />
            </section>

            {/* ── Cross-machine (pro-gated) ───────────────────────────────── */}
            <section aria-labelledby="machines-heading">
              <SectionHeading>
                <span id="machines-heading">Cross-machine</span>
              </SectionHeading>
              <CrossMachine
                machines={stats.machines}
                isPro={isPro}
              />
            </section>

            {/* ── Pro features status ─────────────────────────────────────── */}
            <section aria-labelledby="pro-status-heading">
              <SectionHeading>
                <span id="pro-status-heading">Features</span>
              </SectionHeading>
              <ProFeaturesPanel stats={stats} />
            </section>

            {/* ── Footer ─────────────────────────────────────────────────── */}
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

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}
