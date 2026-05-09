'use client';

/**
 * /admin/genome — Admin genome list page.
 *
 * Table: genome_id (truncated), org_id, member count, last push, 30d push count, total bytes.
 * Click row → /admin/genome/[id]
 * Filter by org_id.
 */

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { adminFetch, AdminAuthError } from '@/lib/admin-fetcher';
import { DashCard } from '@/components/ui/card';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GenomeRow {
  genome_id: string;
  org_id: string;
  member_count: number;
  last_push_at: string | null;
  push_count_30d: number;
  total_bytes: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MONO: React.CSSProperties = {
  fontFamily: 'var(--font-jetbrains,ui-monospace,monospace)',
};

const TH: React.CSSProperties = {
  ...MONO,
  fontSize: 10,
  letterSpacing: '0.15em',
  textTransform: 'uppercase',
  color: 'var(--ink-30,rgba(18,18,18,0.3))',
  textAlign: 'left',
  paddingBottom: 8,
  paddingRight: 16,
  fontWeight: 400,
};

const TD: React.CSSProperties = {
  ...MONO,
  fontSize: 11,
  color: 'var(--ink-55,rgba(18,18,18,0.55))',
  padding: '8px 16px 8px 0',
  borderBottom: '1px solid var(--ink-8,rgba(18,18,18,0.08))',
};

function fmtBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1_024)     return `${(n / 1_024).toFixed(1)} KB`;
  return `${n} B`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return iso; }
}

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-[var(--ink-8,rgba(18,18,18,0.08))] ${className}`} />;
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
// Page
// ---------------------------------------------------------------------------

export default function AdminGenomePage() {
  const router = useRouter();
  const [authed, setAuthed]       = useState<boolean | null>(null);
  const [genomes, setGenomes]     = useState<GenomeRow[] | null>(null);
  const [error, setError]         = useState(false);
  const [orgFilter, setOrgFilter] = useState('');

  useEffect(() => {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('ashlrAdminToken') : null;
    setAuthed(!!token);
  }, []);

  const fetchGenomes = useCallback(() => {
    setError(false);
    adminFetch<{ genomes: GenomeRow[] }>('/admin/genomes')
      .then((d) => setGenomes(d.genomes))
      .catch((e) => {
        if (e instanceof AdminAuthError) setAuthed(false);
        else setError(true);
      });
  }, []);

  useEffect(() => {
    if (authed) fetchGenomes();
  }, [authed, fetchGenomes]);

  if (authed === null) return null;
  if (!authed) return <SignInPrompt />;

  const filtered = orgFilter.trim()
    ? (genomes ?? []).filter((g) => g.org_id.toLowerCase().includes(orgFilter.toLowerCase()))
    : (genomes ?? []);

  return (
    <div className="min-h-screen p-6 lg:p-8" style={{ background: 'var(--parchment,#faf8f3)' }}>
      {/* Header */}
      <div className="mb-6 flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1
            style={{
              fontFamily: 'var(--font-fraunces,ui-serif)',
              fontSize: 'clamp(22px,2.5vw,30px)',
              fontWeight: 300,
              color: 'var(--ink,#121212)',
              letterSpacing: '-0.02em',
              margin: 0,
            }}
          >
            Genomes
          </h1>
          <p className="font-mono text-[11px] tracking-[0.18em] uppercase mt-1" style={{ color: 'var(--ink-55,rgba(18,18,18,0.55))' }}>
            All org genomes — sorted by 30d activity
          </p>
        </div>

        {/* Org filter */}
        <input
          type="search"
          placeholder="Filter by org_id…"
          value={orgFilter}
          onChange={(e) => setOrgFilter(e.target.value)}
          style={{
            ...MONO,
            fontSize: 12,
            border: '1px solid var(--ink-8,rgba(18,18,18,0.08))',
            background: 'var(--parchment,#faf8f3)',
            color: 'var(--ink,#121212)',
            padding: '8px 14px',
            borderRadius: 6,
            outline: 'none',
            width: 240,
          }}
        />
      </div>

      {/* Conflicts shortcut */}
      <div className="mb-4">
        <a
          href="/admin/genome/conflicts"
          style={{
            ...MONO,
            fontSize: 11,
            letterSpacing: '0.15em',
            textTransform: 'uppercase',
            color: 'var(--debit,#c94f4f)',
            textDecoration: 'underline',
            textUnderlineOffset: 3,
          }}
        >
          View cross-genome conflicts →
        </a>
      </div>

      <DashCard>
        {error ? (
          <div className="flex flex-col items-center gap-2 py-8">
            <span className="font-mono text-[11px] tracking-widest uppercase" style={{ color: 'var(--debit,#c94f4f)' }}>Failed to load</span>
            <button onClick={fetchGenomes} className="font-mono text-[11px] tracking-widest uppercase underline" style={{ color: 'var(--ink-55,rgba(18,18,18,0.55))' }}>Retry</button>
          </div>
        ) : genomes === null ? (
          <div className="flex flex-col gap-3 p-2" aria-hidden="true">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Genome ID', 'Org ID', 'Members', 'Last Push', '30d Pushes', 'Size'].map((h) => (
                    <th key={h} style={TH}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((g) => (
                  <tr
                    key={g.genome_id}
                    onClick={() => router.push(`/admin/genome/${g.genome_id}`)}
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--ink-8,rgba(18,18,18,0.08))')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    title={`Inspect genome ${g.genome_id}`}
                  >
                    <td style={{ ...TD, color: 'var(--ink,#121212)', fontSize: 10 }}>
                      {g.genome_id.slice(0, 16)}&hellip;
                    </td>
                    <td style={TD}>{g.org_id}</td>
                    <td style={TD}>{g.member_count}</td>
                    <td style={TD}>{fmtDate(g.last_push_at)}</td>
                    <td style={{ ...TD, color: g.push_count_30d > 0 ? 'var(--ink,#121212)' : 'var(--ink-30,rgba(18,18,18,0.3))' }}>
                      {g.push_count_30d.toLocaleString()}
                    </td>
                    <td style={TD}>{fmtBytes(g.total_bytes)}</td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ ...TD, textAlign: 'center', padding: 24 }}>
                      {orgFilter ? 'No genomes match that org filter.' : 'No genomes found.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </DashCard>
    </div>
  );
}
