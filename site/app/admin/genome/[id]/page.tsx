'use client';

/**
 * /admin/genome/[id] — Admin genome detail drilldown.
 *
 * DashCard sections:
 *   1. Header   — genome_id, org_id, member count, 30d retrieval count, conflict count
 *   2. Sections — top sections by retrieval count (BarChart + table)
 *   3. Sync history — daily push counts over last 30d (LineChart)
 *   4. Top contributors — pushes by redacted client_id (BarChart)
 *   5. Conflict feed — recent conflicts with timestamps + summaries
 */

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { adminFetch, AdminAuthError } from '@/lib/admin-fetcher';
import { DashCard } from '@/components/ui/card';
import { BarChart, LineChart } from '@/components/charts';

// ---------------------------------------------------------------------------
// Types (mirror server AdminGenomeDetail)
// ---------------------------------------------------------------------------

interface SectionRow       { path: string; retrieval_count: number; bytes: number; }
interface ContributorRow   { client_id_redacted: string; push_count: number; }
interface SyncDay          { day: string; push_count: number; }
interface ConflictRow      { genome_id: string; conflicting_user_id_redacted: string; ts: string; summary: string; }

interface GenomeDetail {
  genome_id: string;
  org_id: string;
  member_count: number;
  sections: SectionRow[];
  top_contributors: ContributorRow[];
  sync_history: SyncDay[];
  conflict_count_30d: number;
  retrieval_count_30d: number;
}

// ---------------------------------------------------------------------------
// Style constants
// ---------------------------------------------------------------------------

const MONO: React.CSSProperties = { fontFamily: 'var(--font-jetbrains,ui-monospace,monospace)' };

const TH: React.CSSProperties = {
  ...MONO, fontSize: 10, letterSpacing: '0.15em', textTransform: 'uppercase',
  color: 'var(--ink-30,rgba(18,18,18,0.3))', textAlign: 'left',
  paddingBottom: 8, paddingRight: 16, fontWeight: 400,
};

const TD: React.CSSProperties = {
  ...MONO, fontSize: 11, color: 'var(--ink-55,rgba(18,18,18,0.55))',
  padding: '7px 16px 7px 0', borderBottom: '1px solid var(--ink-8,rgba(18,18,18,0.08))',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1_024)     return `${(n / 1_024).toFixed(1)} KB`;
  return `${n} B`;
}

function fmtDate(iso: string): string {
  try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
}

function Skeleton({ className = '', style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={`animate-pulse rounded bg-[var(--ink-8,rgba(18,18,18,0.08))] ${className}`} style={style} />;
}

function CardSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-2" aria-hidden="true">
      <Skeleton className="h-3 w-32" />
      <Skeleton style={{ height: 200 }} className="w-full" />
    </div>
  );
}

function SignInPrompt() {
  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <div className="ledger-card max-w-md w-full p-8 flex flex-col gap-4">
        <h1 className="font-mono text-[11px] tracking-[0.18em] uppercase" style={{ color: 'var(--ink-55,rgba(18,18,18,0.55))' }}>
          Admin access required
        </h1>
        <pre className="rounded p-3 text-xs overflow-x-auto" style={{ background: 'var(--ink-8,rgba(18,18,18,0.08))' }}>
          {`localStorage.setItem('ashlrAdminToken', '<your-bearer-jwt>')\nlocation.reload()`}
        </pre>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat chip
// ---------------------------------------------------------------------------

function StatChip({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded px-4 py-3 flex flex-col gap-0.5" style={{ background: 'var(--ink-8,rgba(18,18,18,0.08))' }}>
      <span className="font-mono text-[10px] tracking-[0.18em] uppercase" style={{ color: 'var(--ink-55,rgba(18,18,18,0.55))' }}>
        {label}
      </span>
      <span className="font-mono text-lg font-semibold" style={{ color: 'var(--ink,#121212)' }}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdminGenomeDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  const [authed, setAuthed]     = useState<boolean | null>(null);
  const [data, setData]         = useState<GenomeDetail | null>(null);
  const [conflicts, setConflicts] = useState<ConflictRow[] | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);

  // Check token
  useEffect(() => {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('ashlrAdminToken') : null;
    setAuthed(!!token);
  }, []);

  // Fetch detail + conflicts in parallel
  useEffect(() => {
    if (!authed || !params.id) return;

    setLoading(true);
    setError(null);

    Promise.all([
      adminFetch<GenomeDetail>(`/admin/genomes/${params.id}`),
      adminFetch<{ window_days: number; conflicts: ConflictRow[] }>('/admin/genomes/conflicts?window=30'),
    ])
      .then(([detail, cf]) => {
        setData(detail);
        // Filter conflicts to this genome
        setConflicts(cf.conflicts.filter((c) => c.genome_id === params.id));
      })
      .catch((e) => {
        if (e instanceof AdminAuthError) setAuthed(false);
        else setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setLoading(false));
  }, [authed, params.id]);

  if (authed === null) return null;
  if (!authed) return <SignInPrompt />;

  if (loading) {
    return (
      <div className="min-h-screen p-6 lg:p-8" style={{ background: 'var(--parchment,#faf8f3)' }}>
        <div style={{ ...MONO, fontSize: 11, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--ink-30,rgba(18,18,18,0.3))', paddingTop: 48, textAlign: 'center' }}>
          Loading…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen p-6 lg:p-8" style={{ background: 'var(--parchment,#faf8f3)' }}>
        <div style={{ ...MONO, fontSize: 12, color: 'var(--debit,#c94f4f)', padding: '8px 14px', borderRadius: 6, background: 'rgba(201,79,79,0.1)', border: '1px solid var(--debit,#c94f4f)' }}>
          {error}
        </div>
      </div>
    );
  }

  if (!data) return null;

  // Derived chart data
  const sectionsChartData = data.sections.map((s) => ({
    name: s.path.split('/').pop() ?? s.path,  // basename only for chart labels
    retrievals: s.retrieval_count,
  }));

  const syncChartData = data.sync_history.map((d) => ({
    day: d.day,
    pushes: d.push_count,
  }));

  const contributorsChartData = data.top_contributors.map((c) => ({
    contributor: c.client_id_redacted,
    pushes: c.push_count,
  }));

  return (
    <div className="min-h-screen p-6 lg:p-8" style={{ background: 'var(--parchment,#faf8f3)' }}>
      {/* Back nav */}
      <button
        onClick={() => router.push('/admin/genome')}
        style={{ background: 'none', border: 'none', cursor: 'pointer', ...MONO, fontSize: 11, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--ink-55,rgba(18,18,18,0.55))', padding: 0, marginBottom: 20, display: 'block' }}
      >
        ← Genomes
      </button>

      {/* ------------------------------------------------------------------ */}
      {/* Section 1: Header                                                   */}
      {/* ------------------------------------------------------------------ */}
      <DashCard title="Genome" className="mb-5">
        <div className="flex flex-col gap-3">
          <div>
            <span style={{ ...MONO, fontSize: 10, color: 'var(--ink-30,rgba(18,18,18,0.3))', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
              Genome ID
            </span>
            <p style={{ ...MONO, fontSize: 12, color: 'var(--ink,#121212)', wordBreak: 'break-all', margin: '2px 0 0' }}>
              {data.genome_id}
            </p>
          </div>
          <div>
            <span style={{ ...MONO, fontSize: 10, color: 'var(--ink-30,rgba(18,18,18,0.3))', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
              Org
            </span>
            <p style={{ ...MONO, fontSize: 12, color: 'var(--ink,#121212)', margin: '2px 0 0' }}>
              {data.org_id}
            </p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-2">
            <StatChip label="Members"          value={data.member_count} />
            <StatChip label="30d Retrievals"   value={data.retrieval_count_30d} />
            <StatChip label="30d Conflicts"    value={data.conflict_count_30d} />
            <StatChip label="Sections tracked" value={data.sections.length} />
          </div>
        </div>
      </DashCard>

      {/* ------------------------------------------------------------------ */}
      {/* Section 2: Sections by retrieval count                             */}
      {/* ------------------------------------------------------------------ */}
      <DashCard title="Top sections (30d retrievals)" className="mb-5">
        {data.sections.length === 0 ? (
          <span style={{ ...MONO, fontSize: 11, color: 'var(--ink-30,rgba(18,18,18,0.3))' }}>No section data</span>
        ) : (
          <div className="flex flex-col gap-4">
            <BarChart
              data={sectionsChartData as unknown as Record<string, unknown>[]}
              xKey="name"
              yKey="retrievals"
              label="Retrievals"
              ariaLabel="Top genome sections by retrieval count last 30 days"
            />
            <div className="overflow-x-auto">
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['Path', 'Retrievals (30d)', 'Size'].map((h) => (
                      <th key={h} style={TH}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.sections.map((s) => (
                    <tr key={s.path}>
                      <td style={{ ...TD, fontSize: 10, color: 'var(--ink,#121212)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.path}</td>
                      <td style={TD}>{s.retrieval_count.toLocaleString()}</td>
                      <td style={TD}>{fmtBytes(s.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </DashCard>

      {/* ------------------------------------------------------------------ */}
      {/* Section 3: Sync history                                            */}
      {/* ------------------------------------------------------------------ */}
      <DashCard title="Sync history (last 30d)" className="mb-5">
        {data.sync_history.length === 0 ? (
          <span style={{ ...MONO, fontSize: 11, color: 'var(--ink-30,rgba(18,18,18,0.3))' }}>No sync activity in last 30 days</span>
        ) : (
          <LineChart
            data={syncChartData as unknown as Record<string, unknown>[]}
            xKey="day"
            series={[{ key: 'pushes', label: 'Pushes' }]}
            ariaLabel="Genome sync push history over last 30 days"
          />
        )}
      </DashCard>

      {/* ------------------------------------------------------------------ */}
      {/* Section 4: Top contributors                                        */}
      {/* ------------------------------------------------------------------ */}
      <DashCard title="Top contributors (30d, redacted)" className="mb-5">
        {data.top_contributors.length === 0 ? (
          <span style={{ ...MONO, fontSize: 11, color: 'var(--ink-30,rgba(18,18,18,0.3))' }}>No contributor data</span>
        ) : (
          <BarChart
            data={contributorsChartData as unknown as Record<string, unknown>[]}
            xKey="contributor"
            yKey="pushes"
            label="Pushes"
            ariaLabel="Top genome contributors by push count last 30 days, identifiers redacted"
          />
        )}
      </DashCard>

      {/* ------------------------------------------------------------------ */}
      {/* Section 5: Conflict feed                                           */}
      {/* ------------------------------------------------------------------ */}
      <DashCard title="Recent conflicts (30d)">
        {conflicts === null ? (
          <CardSkeleton />
        ) : conflicts.length === 0 ? (
          <span style={{ ...MONO, fontSize: 11, color: 'var(--credit,#2a7a4b)' }}>
            No conflicts detected in last 30 days
          </span>
        ) : (
          <div className="overflow-x-auto">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Timestamp', 'User (redacted)', 'Summary'].map((h) => (
                    <th key={h} style={TH}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {conflicts.map((c, i) => (
                  <tr key={i}>
                    <td style={{ ...TD, whiteSpace: 'nowrap' }}>{fmtDate(c.ts)}</td>
                    <td style={{ ...TD, fontSize: 10 }}>{c.conflicting_user_id_redacted}</td>
                    <td style={{ ...TD, maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DashCard>
    </div>
  );
}
