"use client";

import { useEffect, useRef, useState } from "react";

const API = process.env.NEXT_PUBLIC_ASHLR_API_URL ?? "https://api.ashlr.ai";

interface Repo {
  owner: string;
  name: string;
  description: string | null;
  stars: number;
  lastPushed: string;
  visibility: "public" | "private";
  htmlUrl: string;
}

type BuildStatus = "idle" | "building" | "ready" | "failed" | "scope_up_required";

interface BuildState {
  status: BuildStatus;
  genomeId?: string;
  repoLabel?: string;
  error?: string;
  /** Remembered repo selection so build auto-fires after scope-up */
  pendingRepo?: Repo;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function SkeletonRow() {
  return (
    <div
      style={{
        padding: "14px 20px",
        borderBottom: "1px dashed var(--ink-10)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        style={{
          height: 13,
          width: "40%",
          background: "var(--ink-10)",
          borderRadius: 2,
          animation: "pulse 1.6s ease-in-out infinite",
        }}
      />
      <div
        style={{
          height: 11,
          width: "65%",
          background: "var(--ink-10)",
          borderRadius: 2,
          opacity: 0.6,
          animation: "pulse 1.6s ease-in-out infinite 0.2s",
        }}
      />
    </div>
  );
}

function Spinner() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      style={{
        animation: "spin 1s linear infinite",
        display: "inline-block",
        verticalAlign: "middle",
        color: "var(--ink-55)",
      }}
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="31.4 31.4"
      />
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.45; } }
      `}</style>
    </svg>
  );
}

export default function RepoPicker() {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [build, setBuild] = useState<BuildState>({ status: "idle" });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const token = localStorage.getItem("ashlr.apiToken");
    if (!token) {
      setLoadError("No API token found. Please sign in again.");
      return;
    }
    fetch("/api/github/repos", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    })
      .then(async (r) => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error ?? `HTTP ${r.status}`);
        }
        return r.json() as Promise<Repo[]>;
      })
      .then(setRepos)
      .catch((e: Error) => setLoadError(e.message));
  }, []);

  // cleanup poll on unmount
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  async function startBuild(repo: Repo) {
    const token = localStorage.getItem("ashlr.apiToken");
    if (!token) return;
    const label = `${repo.owner}/${repo.name}`;
    setBuild({ status: "building", repoLabel: label });

    try {
      const res = await fetch(`${API}/genome/build`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ owner: repo.owner, repo: repo.name }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string; error_code?: string };
        if (j.error_code === "scope_up_required") {
          setBuild({ status: "scope_up_required", repoLabel: label, pendingRepo: repo });
          return;
        }
        setBuild({ status: "failed", repoLabel: label, error: j.error ?? `HTTP ${res.status}` });
        return;
      }
      const { genomeId } = (await res.json()) as { genomeId: string };
      setBuild({ status: "building", genomeId, repoLabel: label });

      pollRef.current = setInterval(async () => {
        try {
          const sr = await fetch(`${API}/genome/${genomeId}/status`, {
            headers: { Authorization: `Bearer ${token}` },
            cache: "no-store",
          });
          if (!sr.ok) return;
          const s = (await sr.json()) as { status: string; build_error?: string };
          if (s.status === "ready") {
            if (pollRef.current) clearInterval(pollRef.current);
            setBuild({ status: "ready", genomeId, repoLabel: label });
          } else if (s.status === "failed") {
            if (pollRef.current) clearInterval(pollRef.current);
            setBuild({ status: "failed", repoLabel: label, error: s.build_error ?? "Build failed." });
          }
        } catch {
          // transient — keep polling
        }
      }, 2000);
    } catch (e: unknown) {
      setBuild({ status: "failed", repoLabel: label, error: (e as Error).message });
    }
  }

  function resetBuild() {
    if (pollRef.current) clearInterval(pollRef.current);
    setBuild({ status: "idle" });
  }

  const isBuilding = build.status === "building" || build.status === "scope_up_required";

  return (
    <div style={{ marginTop: 24 }}>
      <div
        className="mono-label mb-3"
        style={{ color: "var(--ink-55)", letterSpacing: "0.1em" }}
      >
        Build genome from repo
      </div>

      {/* Status panel */}
      {build.status !== "idle" && (
        <div
          className="ledger-card px-5 py-4 mb-4"
          style={{ background: "var(--paper-deep)" }}
        >
          {build.status === "building" && (
            <div className="flex items-center gap-3 font-mono text-[12px]" style={{ color: "var(--ink-80)" }}>
              <Spinner />
              Building genome for <strong>{build.repoLabel}</strong>…
            </div>
          )}
          {build.status === "ready" && (
            <div>
              <div className="font-mono text-[12px] mb-2" style={{ color: "var(--credit)" }}>
                Genome ready +
              </div>
              <p className="font-mono text-[12px] leading-relaxed mb-3" style={{ color: "var(--ink-80)" }}>
                Start using <code style={{ fontFamily: "var(--font-jetbrains), ui-monospace", background: "var(--ink-10)", padding: "1px 4px", borderRadius: 2 }}>ashlr__grep</code> in your terminal — it now searches your genome for <strong>{build.repoLabel}</strong>.
              </p>
              <button
                type="button"
                onClick={resetBuild}
                className="btn"
                style={{ fontSize: 11 }}
              >
                Build another repo
              </button>
            </div>
          )}
          {build.status === "failed" && (
            <div>
              <div className="font-mono text-[12px] mb-2" style={{ color: "var(--debit)" }}>
                Build failed
              </div>
              {build.error && (
                <p className="font-mono text-[12px] leading-relaxed mb-3" style={{ color: "var(--ink-55)" }}>
                  {build.error}
                </p>
              )}
              <button
                type="button"
                onClick={resetBuild}
                className="btn"
                style={{ fontSize: 11 }}
              >
                Try again
              </button>
            </div>
          )}
          {build.status === "scope_up_required" && (
            <div>
              <div className="font-mono text-[12px] mb-2" style={{ color: "var(--ink-80)", fontWeight: 600 }}>
                This repo is private — grant access to continue
              </div>
              <p className="font-mono text-[12px] leading-relaxed mb-3" style={{ color: "var(--ink-55)" }}>
                Building genomes from private repos requires an additional GitHub
                permission. We only read your code — never push or modify it.
              </p>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <a
                  href={`/auth/github/scope-up?sid=${encodeURIComponent(
                    (() => {
                      // Generate a fresh 32-hex sid stored in sessionStorage so the
                      // done page can identify the session after the OAuth round-trip.
                      const existing = sessionStorage.getItem("ashlr.scopeup.sid");
                      if (existing) return existing;
                      const sid = Array.from(crypto.getRandomValues(new Uint8Array(16)))
                        .map((b) => b.toString(16).padStart(2, "0"))
                        .join("");
                      sessionStorage.setItem("ashlr.scopeup.sid", sid);
                      sessionStorage.setItem("ashlr.scopeup.pendingOwner", build.pendingRepo?.owner ?? "");
                      sessionStorage.setItem("ashlr.scopeup.pendingRepo", build.pendingRepo?.name ?? "");
                      return sid;
                    })()
                  )}`}
                  className="btn"
                  style={{ fontSize: 11, textDecoration: "none" }}
                >
                  Grant private repo access
                </a>
                <button
                  type="button"
                  onClick={resetBuild}
                  className="font-mono text-[11px]"
                  style={{ color: "var(--ink-30)", background: "none", border: "none", cursor: "pointer", padding: 0 }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Repo list */}
      <div
        className="ledger-card overflow-hidden"
        style={{ background: "var(--paper-deep)" }}
      >
        {loadError && (
          <div
            className="px-5 py-4 font-mono text-[12px]"
            style={{ color: "var(--debit)" }}
          >
            {loadError}
          </div>
        )}

        {!loadError && repos === null && (
          <>
            {Array.from({ length: 10 }).map((_, i) => (
              <SkeletonRow key={i} />
            ))}
          </>
        )}

        {repos && repos.length === 0 && (
          <div
            className="px-5 py-6 font-mono text-[12px]"
            style={{ color: "var(--ink-30)", textAlign: "center" }}
          >
            No public repositories found.
          </div>
        )}

        {repos && repos.map((repo, i) => {
          const label = `${repo.owner}/${repo.name}`;
          return (
            <button
              key={label}
              type="button"
              onClick={() => startBuild(repo)}
              disabled={isBuilding}
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                width: "100%",
                padding: "14px 20px",
                borderBottom: i < repos.length - 1 ? "1px dashed var(--ink-10)" : "none",
                background: "transparent",
                border: "none",
                borderBottomStyle: i < repos.length - 1 ? "dashed" : undefined,
                borderBottomColor: "var(--ink-10)",
                borderBottomWidth: i < repos.length - 1 ? 1 : 0,
                cursor: isBuilding ? "not-allowed" : "pointer",
                opacity: isBuilding ? 0.5 : 1,
                textAlign: "left",
                gap: 12,
              }}
              onMouseEnter={(e) => {
                if (!isBuilding) (e.currentTarget as HTMLButtonElement).style.background = "var(--paper)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "transparent";
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  className="font-mono text-[12px] font-semibold"
                  style={{ color: "var(--ink)", marginBottom: 2 }}
                >
                  {repo.owner}/{repo.name}
                  {repo.visibility === "private" && (
                    <span
                      className="font-mono text-[10px]"
                      style={{
                        marginLeft: 6,
                        background: "var(--ink-10)",
                        color: "var(--ink-55)",
                        borderRadius: 2,
                        padding: "1px 5px",
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                      }}
                    >
                      private
                    </span>
                  )}
                </div>
                {repo.description && (
                  <div
                    className="font-mono text-[11px]"
                    style={{
                      color: "var(--ink-55)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      maxWidth: 340,
                    }}
                  >
                    {repo.description}
                  </div>
                )}
              </div>
              <div
                style={{
                  flexShrink: 0,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-end",
                  gap: 2,
                }}
              >
                {repo.stars > 0 && (
                  <span
                    className="font-mono text-[11px]"
                    style={{ color: "var(--ink-30)" }}
                  >
                    {repo.stars >= 1000
                      ? `${(repo.stars / 1000).toFixed(1)}k`
                      : repo.stars}{" "}
                    *
                  </span>
                )}
                <span
                  className="font-mono text-[10px]"
                  style={{ color: "var(--ink-30)" }}
                >
                  {timeAgo(repo.lastPushed)}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
