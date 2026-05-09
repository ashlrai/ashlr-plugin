'use client';

/**
 * /admin/dashboard — unified Admin Ops Dashboard (Stage 1, v1.30).
 *
 * Auth: reads localStorage.ashlrAdminToken.
 *   If missing → sign-in prompt (full OAuth flow is out of scope here).
 *   If AdminAuthError propagates from a card fetch → same prompt.
 *
 * Layout (12-col responsive grid, top to bottom):
 *   Row 1  — 4 KPI tiles (total_users, active_pro, MRR, llm_calls_today)
 *   Row 2  — Tool adoption bar chart (24h/7d/30d picker)  |  Hook latency line chart
 *   Row 3  — Genome compression area chart (30d)           |  Wizard funnel
 *   Row 4  — Recent signups table  |  Recent payments table
 *   Row 5  — Recent errors panel
 */

import { useEffect, useState, useCallback } from 'react';
import { adminFetch, AdminAuthError } from '@/lib/admin-fetcher';
import KpiTile from '@/components/ui/kpi-tile';
import { DashCard } from '@/components/ui/card';
import { LineChart, BarChart, AreaChart, FunnelChart } from '@/components/charts';

// ---------------------------------------------------------------------------
// Types (mirrors server response shapes)
// ---------------------------------------------------------------------------

interface OverviewCounts {
  total_users: number;
  active_pro: number;
  active_team: number;
  mrr_cents: number;
  llm_calls_today: number;
  genome_syncs_today: number;
}

interface OverviewData {
  counts: OverviewCounts;
  prev: OverviewCounts;
  recent_signups: { id: string; email: string; tier: string; created_at: string }[];
  recent_payments: { user_id: string; email: string; tier: string; created_at: string; stripe_subscription_id: string }[];
}

interface ToolAdoptionRow { tool_name: string; call_count: number; share_pct: number; }
interface HookLatencyRow  { hook_name: string; p50_ms: number; p99_ms: number; sample_count: number; }
interface CompressionRow  { day: string; median_ratio: number; sample_count: number; }
interface WizardStep      { step_name: string; sessions_reached: number; }

// Sentry issue shape (subset)
interface SentryIssue { id: string; title: string; firstSeen: string; count: string; }

// ---------------------------------------------------------------------------
// Skeleton placeholder
// ---------------------------------------------------------------------------

function Skeleton({ className = '', style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={`animate-pulse rounded bg-[var(--ink-8,rgba(18,18,18,0.08))] ${className}`} style={style} />;
}

function CardSkeleton({ chartHeight = 240 }: { chartHeight?: number }) {
  return (
    <div className="flex flex-col gap-3 p-6" aria-hidden="true">
      <Skeleton className="h-3 w-32" />
      <Skeleton style={{ height: chartHeight }} className="w-full" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sign-in prompt
// ---------------------------------------------------------------------------

function SignInPrompt() {
  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <div className="ledger-card max-w-md w-full p-8 flex flex-col gap-4">
        <h1
          className="font-mono text-[11px] tracking-[0.18em] uppercase"
          style={{ color: 'var(--ink-55,rgba(18,18,18,0.55))' }}
        >
          Admin access required
        </h1>
        <p
          style={{
            fontFamily: 'var(--font-fraunces,ui-serif)',
            fontSize: 'clamp(20px,2.5vw,28px)',
            fontWeight: 300,
            color: 'var(--ink,#121212)',
          }}
        >
          Set your admin token to continue
        </p>
        <p className="font-mono text-xs leading-relaxed" style={{ color: 'var(--ink-55,rgba(18,18,18,0.55))' }}>
          Open your browser DevTools console and run:
        </p>
        <pre
          className="rounded p-3 text-xs overflow-x-auto"
          style={{ background: 'var(--ink-8,rgba(18,18,18,0.08))' }}
        >
          {`localStorage.setItem('ashlrAdminToken', '<your-bearer-jwt>')\nlocation.reload()`}
        </pre>
        <p className="font-mono text-[11px]" style={{ color: 'var(--ink-30,rgba(18,18,18,0.3))' }}>
          The JWT is issued via the server CLI: <code>bun src/cli/issue-token.ts --admin</code>
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Retry error inline (inside a card)
// ---------------------------------------------------------------------------

function CardError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-8">
      <span className="font-mono text-[11px] tracking-widest uppercase" style={{ color: 'var(--debit,#c94f4f)' }}>
        Failed to load
      </span>
      <button
        onClick={onRetry}
        className="font-mono text-[11px] tracking-widest uppercase underline"
        style={{ color: 'var(--ink-55,rgba(18,18,18,0.55))' }}
      >
        Retry
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Window picker for tool adoption
// ---------------------------------------------------------------------------

type Window = 24 | 168 | 720;
const WINDOW_LABELS: Record<Window, string> = { 24: '24h', 168: '7d', 720: '30d' };

// ---------------------------------------------------------------------------
// Helper: format cents as $X.XX
// ---------------------------------------------------------------------------

function centsToUsd(cents: number) {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ---------------------------------------------------------------------------
// Delta formatting helpers
// ---------------------------------------------------------------------------

/**
 * fmtCountDelta — format an absolute integer delta with sign.
 * Returns null when prev is 0 (avoids +Inf%) or delta is 0 (no signal).
 * Examples: curr=105, prev=100 → "+5 (+5.0%)"
 *           curr=95,  prev=100 → "-5 (-5.0%)"
 *           curr=100, prev=0   → null  (new install, no baseline)
 */
function fmtCountDelta(curr: number, prev: number): { text: string; positive: boolean } | null {
  if (prev === 0) return null;
  const diff = curr - prev;
  if (diff === 0) return null;
  const pct = ((diff / prev) * 100).toFixed(1);
  const sign = diff > 0 ? '+' : '';
  return { text: `${sign}${diff} (${sign}${pct}%)`, positive: diff > 0 };
}

/**
 * fmtMrrDelta — format a cents delta as dollar strings.
 * Examples: curr=12000, prev=10000 → "+$20.00 (+20.0%)"
 *           curr=8000,  prev=10000 → "-$20.00 (-20.0%)"
 */
function fmtMrrDelta(curr: number, prev: number): { text: string; positive: boolean } | null {
  if (prev === 0) return null;
  const diff = curr - prev;
  if (diff === 0) return null;
  const sign = diff > 0 ? '+' : '-';
  const absDollars = (Math.abs(diff) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = ((diff / prev) * 100).toFixed(1);
  const pctSign = diff > 0 ? '+' : '';
  return { text: `${sign}$${absDollars} (${pctSign}${pct}%)`, positive: diff > 0 };
}

/**
 * fmtLlmDelta — format today vs yesterday LLM call count.
 * Shows yesterday's full-day count as context ("yesterday: N").
 * Returns null when yesterday is 0.
 */
function fmtLlmDelta(today: number, yesterday: number): { text: string; positive: boolean } | null {
  if (yesterday === 0) return null;
  const diff = today - yesterday;
  if (diff === 0) return null;
  const sign = diff > 0 ? '+' : '';
  return { text: `${sign}${diff} vs yday`, positive: diff > 0 };
}

// Wizard step canonical order
const WIZARD_ORDER = ['intro', 'doctor', 'permissions', 'status_line', 'genome_init', 'pro_teaser', 'complete'];

function orderWizardSteps(steps: WizardStep[]): WizardStep[] {
  const map = new Map(steps.map((s) => [s.step_name, s]));
  const ordered: WizardStep[] = [];
  for (const name of WIZARD_ORDER) {
    if (map.has(name)) ordered.push(map.get(name)!);
  }
  // Append any steps not in canonical list (future-proofing)
  for (const s of steps) {
    if (!WIZARD_ORDER.includes(s.step_name)) ordered.push(s);
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function AdminDashboard() {
  const [authed, setAuthed]           = useState<boolean | null>(null); // null = checking
  const [overview, setOverview]       = useState<OverviewData | null>(null);
  const [overviewErr, setOverviewErr] = useState(false);

  const [toolWindow, setToolWindow]   = useState<Window>(24);
  const [toolRows, setToolRows]       = useState<ToolAdoptionRow[] | null>(null);
  const [toolErr, setToolErr]         = useState(false);

  const [latencyRows, setLatencyRows] = useState<HookLatencyRow[] | null>(null);
  const [latencyErr, setLatencyErr]   = useState(false);

  const [comprRows, setComprRows]     = useState<CompressionRow[] | null>(null);
  const [comprErr, setComprErr]       = useState(false);

  const [funnelSteps, setFunnelSteps] = useState<WizardStep[] | null>(null);
  const [funnelErr, setFunnelErr]     = useState(false);

  const [errors, setErrors]           = useState<SentryIssue[] | null>(null);
  const [errorsErr, setErrorsErr]     = useState(false);

  // Check token on mount
  useEffect(() => {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('ashlrAdminToken') : null;
    setAuthed(!!token);
  }, []);

  // Fetch overview
  const fetchOverview = useCallback(() => {
    setOverviewErr(false);
    adminFetch<OverviewData>('/admin/overview')
      .then(setOverview)
      .catch((e) => {
        if (e instanceof AdminAuthError) setAuthed(false);
        else setOverviewErr(true);
      });
  }, []);

  // Fetch tool adoption
  const fetchTools = useCallback((w: Window) => {
    setToolErr(false);
    setToolRows(null);
    adminFetch<{ window_hours: number; rows: ToolAdoptionRow[] }>(`/admin/telemetry/tool-adoption?window=${w}`)
      .then((d) => setToolRows(d.rows))
      .catch((e) => {
        if (e instanceof AdminAuthError) setAuthed(false);
        else setToolErr(true);
      });
  }, []);

  // Fetch hook latency
  const fetchLatency = useCallback(() => {
    setLatencyErr(false);
    adminFetch<{ window_hours: number; rows: HookLatencyRow[] }>('/admin/telemetry/hook-latency?window=24')
      .then((d) => setLatencyRows(d.rows))
      .catch((e) => {
        if (e instanceof AdminAuthError) setAuthed(false);
        else setLatencyErr(true);
      });
  }, []);

  // Fetch genome compression
  const fetchCompression = useCallback(() => {
    setComprErr(false);
    adminFetch<{ window_hours: number; rows: CompressionRow[] }>('/admin/telemetry/genome-compression?window=720')
      .then((d) => setComprRows(d.rows))
      .catch((e) => {
        if (e instanceof AdminAuthError) setAuthed(false);
        else setComprErr(true);
      });
  }, []);

  // Fetch wizard funnel
  const fetchFunnel = useCallback(() => {
    setFunnelErr(false);
    adminFetch<{ window_hours: number; steps: WizardStep[] }>('/admin/telemetry/wizard-funnel?window=168')
      .then((d) => setFunnelSteps(orderWizardSteps(d.steps)))
      .catch((e) => {
        if (e instanceof AdminAuthError) setAuthed(false);
        else setFunnelErr(true);
      });
  }, []);

  // Fetch errors
  const fetchErrors = useCallback(() => {
    setErrorsErr(false);
    adminFetch<{ issues: SentryIssue[] }>('/admin/errors?limit=10')
      .then((d) => setErrors(d?.issues ?? []))
      .catch((e) => {
        if (e instanceof AdminAuthError) setAuthed(false);
        else setErrorsErr(true);
      });
  }, []);

  // Fire all fetches once authed
  useEffect(() => {
    if (!authed) return;
    fetchOverview();
    fetchTools(toolWindow);
    fetchLatency();
    fetchCompression();
    fetchFunnel();
    fetchErrors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  // Refetch tool adoption when window picker changes
  useEffect(() => {
    if (!authed) return;
    fetchTools(toolWindow);
  }, [authed, toolWindow, fetchTools]);

  // Still checking token
  if (authed === null) return null;

  // Not authed
  if (!authed) return <SignInPrompt />;

  // ---------------------------------------------------------------------------
  // Derived data for charts
  // ---------------------------------------------------------------------------

  // Hook latency: pivot to {hook_name, p50_ms, p99_ms} rows already match LineChart shape
  // LineChart expects data rows with keys matching series keys
  const latencyChartData = (latencyRows ?? []).map((r) => ({
    hook: r.hook_name,
    p50: r.p50_ms,
    p99: r.p99_ms,
  }));

  const funnelChartSteps = (funnelSteps ?? []).map((s) => ({
    name: s.step_name,
    value: s.sessions_reached,
  }));

  // KPI values + prior-period deltas
  const counts = overview?.counts;
  const prev   = overview?.prev;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="min-h-screen p-6 lg:p-8" style={{ background: 'var(--parchment,#faf8f3)' }}>
      {/* Page title */}
      <div className="mb-8">
        <h1
          style={{
            fontFamily: 'var(--font-fraunces,ui-serif)',
            fontSize: 'clamp(24px,3vw,36px)',
            fontWeight: 300,
            color: 'var(--ink,#121212)',
            letterSpacing: '-0.02em',
          }}
        >
          Admin Dashboard
        </h1>
        <p className="font-mono text-[11px] tracking-[0.18em] uppercase mt-1" style={{ color: 'var(--ink-55,rgba(18,18,18,0.55))' }}>
          Ops overview — ashlr-plugin
        </p>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Row 1 — KPI tiles (4-col grid)                                      */}
      {/* ------------------------------------------------------------------ */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {overviewErr ? (
          <div className="col-span-2 lg:col-span-4">
            <DashCard><CardError onRetry={fetchOverview} /></DashCard>
          </div>
        ) : counts ? (
          <>
            {(() => {
              const usersDelta = prev ? fmtCountDelta(counts.total_users, prev.total_users) : null;
              const proDelta   = prev ? fmtCountDelta(counts.active_pro,  prev.active_pro)  : null;
              const mrrDelta   = prev ? fmtMrrDelta(counts.mrr_cents,     prev.mrr_cents)   : null;
              const llmDelta   = prev ? fmtLlmDelta(counts.llm_calls_today, prev.llm_calls_today) : null;
              return (
                <>
                  <KpiTile
                    label="Total users"
                    value={counts.total_users.toLocaleString()}
                    delta={usersDelta?.text}
                    deltaPositive={usersDelta?.positive}
                  />
                  <KpiTile
                    label="Active Pro"
                    value={counts.active_pro.toLocaleString()}
                    delta={proDelta?.text}
                    deltaPositive={proDelta?.positive}
                  />
                  <KpiTile
                    label="MRR"
                    value={centsToUsd(counts.mrr_cents)}
                    delta={mrrDelta?.text}
                    deltaPositive={mrrDelta?.positive}
                  />
                  <KpiTile
                    label="LLM calls today"
                    value={counts.llm_calls_today.toLocaleString()}
                    delta={llmDelta?.text}
                    deltaPositive={llmDelta?.positive}
                  />
                </>
              );
            })()}
          </>
        ) : (
          // Loading skeletons
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="ledger-card p-5 flex flex-col gap-2">
              <Skeleton className="h-2 w-20" />
              <Skeleton className="h-8 w-28" />
            </div>
          ))
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Row 2 — Tool adoption + Hook latency                                */}
      {/* ------------------------------------------------------------------ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        {/* Tool adoption bar chart */}
        <DashCard
          title={`Tool adoption (${WINDOW_LABELS[toolWindow]})`}
          className="flex flex-col"
        >
          {/* Window picker */}
          <div className="flex gap-2 mb-4 px-1" role="group" aria-label="Time window">
            {(Object.entries(WINDOW_LABELS) as [string, string][]).map(([w, label]) => (
              <button
                key={w}
                onClick={() => setToolWindow(Number(w) as Window)}
                aria-pressed={toolWindow === Number(w)}
                className="font-mono text-[11px] tracking-widest uppercase px-2 py-0.5 rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ink,#121212)]"
                style={{
                  background: toolWindow === Number(w)
                    ? 'var(--ink,#121212)'
                    : 'transparent',
                  color: toolWindow === Number(w)
                    ? 'var(--parchment,#faf8f3)'
                    : 'var(--ink-55,rgba(18,18,18,0.55))',
                  border: '1px solid var(--ink-8,rgba(18,18,18,0.08))',
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {toolErr ? (
            <CardError onRetry={() => fetchTools(toolWindow)} />
          ) : toolRows === null ? (
            <CardSkeleton chartHeight={240} />
          ) : (
            <BarChart
              data={toolRows as unknown as Record<string, unknown>[]}
              xKey="tool_name"
              yKey="call_count"
              label="Calls"
              ariaLabel={`Tool adoption bar chart, last ${WINDOW_LABELS[toolWindow]}`}
            />
          )}
        </DashCard>

        {/* Hook latency line chart */}
        <DashCard title="Hook latency p50 / p99 (24h)">
          {latencyErr ? (
            <CardError onRetry={fetchLatency} />
          ) : latencyRows === null ? (
            <CardSkeleton chartHeight={240} />
          ) : (
            <LineChart
              data={latencyChartData}
              xKey="hook"
              series={[
                { key: 'p50', label: 'p50 ms' },
                { key: 'p99', label: 'p99 ms' },
              ]}
              ariaLabel="Hook latency p50 and p99 over time, last 24 hours"
            />
          )}
        </DashCard>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Row 3 — Genome compression + Wizard funnel                          */}
      {/* ------------------------------------------------------------------ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        {/* Genome compression area chart */}
        <DashCard title="Genome compression (30d)">
          {comprErr ? (
            <CardError onRetry={fetchCompression} />
          ) : comprRows === null ? (
            <CardSkeleton chartHeight={240} />
          ) : (
            <AreaChart
              data={comprRows as unknown as Record<string, unknown>[]}
              xKey="day"
              yKey="median_ratio"
              label="Compression ratio"
              ariaLabel="Genome compression ratio over last 30 days"
            />
          )}
        </DashCard>

        {/* Wizard funnel */}
        <DashCard title="Wizard funnel (7d)">
          {funnelErr ? (
            <CardError onRetry={fetchFunnel} />
          ) : funnelSteps === null ? (
            <CardSkeleton chartHeight={280} />
          ) : (
            <FunnelChart
              steps={funnelChartSteps}
              ariaLabel="Wizard onboarding funnel, last 7 days"
            />
          )}
        </DashCard>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Row 4 — Recent signups + Recent payments                            */}
      {/* ------------------------------------------------------------------ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <DashCard title="Recent signups">
          {overviewErr ? (
            <CardError onRetry={fetchOverview} />
          ) : !overview ? (
            <CardSkeleton />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full font-mono text-[11px]">
                <thead>
                  <tr style={{ color: 'var(--ink-30,rgba(18,18,18,0.3))' }}>
                    <th className="text-left pb-2 tracking-widest uppercase">Email</th>
                    <th className="text-left pb-2 tracking-widest uppercase">Tier</th>
                    <th className="text-left pb-2 tracking-widest uppercase">Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.recent_signups.map((u) => (
                    <tr key={u.id} style={{ color: 'var(--ink-55,rgba(18,18,18,0.55))' }}>
                      <td className="py-1 pr-4 truncate max-w-[160px]">{u.email}</td>
                      <td className="py-1 pr-4">{u.tier}</td>
                      <td className="py-1">{u.created_at.slice(0, 10)}</td>
                    </tr>
                  ))}
                  {overview.recent_signups.length === 0 && (
                    <tr><td colSpan={3} className="py-4 text-center tracking-widest uppercase">No recent signups</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </DashCard>

        <DashCard title="Recent payments">
          {overviewErr ? (
            <CardError onRetry={fetchOverview} />
          ) : !overview ? (
            <CardSkeleton />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full font-mono text-[11px]">
                <thead>
                  <tr style={{ color: 'var(--ink-30,rgba(18,18,18,0.3))' }}>
                    <th className="text-left pb-2 tracking-widest uppercase">Email</th>
                    <th className="text-left pb-2 tracking-widest uppercase">Tier</th>
                    <th className="text-left pb-2 tracking-widest uppercase">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.recent_payments.map((p) => (
                    <tr key={p.stripe_subscription_id} style={{ color: 'var(--ink-55,rgba(18,18,18,0.55))' }}>
                      <td className="py-1 pr-4 truncate max-w-[160px]">{p.email}</td>
                      <td className="py-1 pr-4">{p.tier}</td>
                      <td className="py-1">{p.created_at.slice(0, 10)}</td>
                    </tr>
                  ))}
                  {overview.recent_payments.length === 0 && (
                    <tr><td colSpan={3} className="py-4 text-center tracking-widest uppercase">No recent payments</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </DashCard>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Row 5 — Recent errors                                               */}
      {/* ------------------------------------------------------------------ */}
      <div className="mb-6">
        <DashCard title="Recent errors (Sentry)">
          {errorsErr ? (
            <CardError onRetry={fetchErrors} />
          ) : errors === null ? (
            <CardSkeleton />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full font-mono text-[11px]">
                <thead>
                  <tr style={{ color: 'var(--ink-30,rgba(18,18,18,0.3))' }}>
                    <th className="text-left pb-2 tracking-widest uppercase">First seen</th>
                    <th className="text-left pb-2 tracking-widest uppercase">Count</th>
                    <th className="text-left pb-2 tracking-widest uppercase">Title</th>
                  </tr>
                </thead>
                <tbody>
                  {errors.map((e) => (
                    <tr key={e.id} style={{ color: 'var(--ink-55,rgba(18,18,18,0.55))' }}>
                      <td className="py-1 pr-4 whitespace-nowrap">{e.firstSeen?.slice(0, 16).replace('T', ' ')}</td>
                      <td className="py-1 pr-4">{e.count}</td>
                      <td className="py-1 truncate max-w-[400px]">{e.title}</td>
                    </tr>
                  ))}
                  {errors.length === 0 && (
                    <tr>
                      <td colSpan={3} className="py-4 text-center tracking-widest uppercase" style={{ color: 'var(--credit,#2a7a4b)' }}>
                        No unresolved errors
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </DashCard>
      </div>
    </div>
  );
}
