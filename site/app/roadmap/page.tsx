import type { Metadata } from "next";
import Link from "next/link";
import Nav from "@/components/nav";
import Footer from "@/components/footer";

export const metadata: Metadata = {
  title: "Roadmap — ashlr · The Token Ledger",
  description:
    "What we're building next: cross-platform hardening, team genomes, enterprise billing, and more.",
};

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

type Status = "now" | "next" | "considering" | "shipped";
type Quarter = "Q2 2026" | "Q3 2026" | "Q4 2026" | "Someday";

interface RoadmapItem {
  title: string;
  description: string;
  eta: Quarter;
}

const NOW: RoadmapItem[] = [
  {
    title: "Windows-native MCP tooling hardening",
    description:
      "Eliminate remaining edge cases in the cross-platform hook layer: PowerShell path quoting, signal handling on Windows, and CI matrix coverage for all six hooks.",
    eta: "Q2 2026",
  },
  {
    title: "Cursor + Goose extensions reach feature parity with Claude Code",
    description:
      "Port the session-start greeting, onboarding wizard, and genome scribe loop to the Cursor and Goose adapters in /ports so every supported host gets the same first-run experience.",
    eta: "Q2 2026",
  },
  {
    title: "Auto-update notifier UX polish",
    description:
      "The session-start notifier already ships — it compares the installed version against the latest GitHub release and prints a one-line notice at most once per day per version. Q2 work focuses on richer presentation: changelog excerpt in the notice, opt-in one-command apply, and a quieter status-line indicator for users who'd rather not see stderr output.",
    eta: "Q2 2026",
  },
  {
    title: "Usage-based billing tier for enterprise (>1M tokens/month)",
    description:
      "A metered plan for large engineering teams that prefer per-token billing over per-seat. Requires a usage-reporting endpoint in the plugin and a Stripe metered subscription integration on the backend.",
    eta: "Q3 2026",
  },
  {
    title: "Public roadmap and blog on plugin.ashlr.ai",
    description:
      "This page, plus a bespoke MDX blog for technical deep-dives, release notes, and engineering transparency posts.",
    eta: "Q2 2026",
  },
];

const NEXT: RoadmapItem[] = [
  {
    title: "Multi-user team genome with X25519 envelope encryption",
    description:
      "Upgrade the team genome encryption model from a single shared AES-256-GCM key to per-member X25519 key exchange with encrypted key envelopes, so a member rotation does not require a full re-encrypt of the genome store.",
    eta: "Q3 2026",
  },
  {
    title: "Self-hosted pro backend via flyctl deploy",
    description:
      "A one-command deploy path for the Hono/Bun backend onto Fly.io, with a generated fly.toml and environment variable checklist. Teams that want full data sovereignty can run their own instance.",
    eta: "Q3 2026",
  },
  {
    title: "Grafana dashboard template for ops",
    description:
      "A JSON dashboard definition that works against the existing Postgres schema — per-team token savings, genome hit rate over time, LLM summarizer latency histogram. Import it in three clicks.",
    eta: "Q3 2026",
  },
  {
    title: "Cross-repo genome federation",
    description:
      "Allow a parent genome to pull sections from child repo genomes at build time, so a monorepo or multi-repo org can keep per-package genomes without duplicating shared architecture documentation.",
    eta: "Q4 2026",
  },
  {
    title: "CLI conflict resolver for genome merges",
    description:
      "When a CRDT merge produces a conflict in the genome store (two writers edit the same section within the same clock tick), surface a side-by-side diff in the terminal and prompt for a resolution strategy.",
    eta: "Q4 2026",
  },
  {
    title: "Leaderboard opt-in public profile",
    description:
      "Users who opt in can publish their anonymized savings stats to a public leaderboard page, enabling community benchmarking across codebases and team sizes.",
    eta: "Q4 2026",
  },
  {
    title: "Genome diff annotations on GitHub PRs",
    description:
      "A GitHub Actions step that posts a summary of genome changes as a PR comment: which sections were added, modified, or removed, and what token-savings impact the change has on the benchmark.",
    eta: "Q4 2026",
  },
];

const CONSIDERING: RoadmapItem[] = [
  {
    title: "ashlr for JetBrains IDEs",
    description:
      "A JetBrains plugin that exposes the same MCP tools to AI assistants inside IntelliJ IDEA, PyCharm, and Rider.",
    eta: "Someday",
  },
  {
    title: "ashlr for JupyterLab",
    description:
      "A JupyterLab extension that integrates the genome retrieval index with notebook context, so AI tools inside Jupyter see a compressed view of the project rather than full file contents.",
    eta: "Someday",
  },
  {
    title: "Local-only enterprise deployment with SSO",
    description:
      "A fully air-gapped deployment option: local inference, local genome store, SAML/OIDC SSO, and no outbound network calls except to the customer's own identity provider.",
    eta: "Someday",
  },
  {
    title: "Browser extension for cross-platform token tracking",
    description:
      "A browser extension that instruments ChatGPT, Claude.ai, and Gemini web interfaces and reports token usage to a unified dashboard alongside the plugin's native Claude Code stats.",
    eta: "Someday",
  },
  {
    title: "ashlr MCP server for VS Code Copilot",
    description:
      "Expose the genome retrieval index and compressed read/grep tools to GitHub Copilot via VS Code's MCP extension host, extending the savings to the Copilot workflow.",
    eta: "Someday",
  },
  {
    title: "Genome training loop",
    description:
      "A feedback mechanism where the agent rates genome sections by usefulness after each session, and the genome scribe loop uses those ratings to weight future section selection.",
    eta: "Someday",
  },
  {
    title: "ashlr for Zed",
    description:
      "Integration with Zed's AI assistant panel via the MCP protocol, giving Zed users access to compressed reads and genome retrieval.",
    eta: "Someday",
  },
];

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<Status, string> = {
  now: "var(--debit)",
  next: "var(--credit)",
  considering: "var(--ink-30)",
  shipped: "var(--ink-55)",
};

const ETA_BG: Record<Quarter, string> = {
  "Q2 2026": "rgba(139, 46, 26, 0.10)",
  "Q3 2026": "rgba(79, 91, 63, 0.10)",
  "Q4 2026": "rgba(18, 18, 18, 0.06)",
  "Someday": "rgba(18, 18, 18, 0.04)",
};

const ETA_COLOR: Record<Quarter, string> = {
  "Q2 2026": "var(--debit)",
  "Q3 2026": "var(--credit)",
  "Q4 2026": "var(--ink-55)",
  "Someday": "var(--ink-30)",
};

function EtaBadge({ eta }: { eta: Quarter }) {
  return (
    <span
      style={{
        display: "inline-block",
        fontFamily: "var(--font-jetbrains), ui-monospace",
        fontSize: 10,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        background: ETA_BG[eta],
        color: ETA_COLOR[eta],
        borderRadius: 3,
        padding: "2px 7px",
        lineHeight: 1.7,
        whiteSpace: "nowrap",
      }}
    >
      {eta}
    </span>
  );
}

function StatusDot({ status }: { status: Status }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: STATUS_COLORS[status],
        flexShrink: 0,
        marginTop: 6,
      }}
    />
  );
}

function ExplorationBadge() {
  return (
    <span
      style={{
        display: "inline-block",
        fontFamily: "var(--font-jetbrains), ui-monospace",
        fontSize: 10,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        background: "rgba(18, 18, 18, 0.05)",
        color: "var(--ink-30)",
        border: "1px dashed var(--ink-10)",
        borderRadius: 3,
        padding: "2px 7px",
        lineHeight: 1.7,
      }}
    >
      Exploration
    </span>
  );
}

function LedgerCard({
  item,
  status,
  showExploration = false,
}: {
  item: RoadmapItem;
  status: Status;
  showExploration?: boolean;
}) {
  return (
    <div
      style={{
        background: "var(--paper-deep)",
        border: "1px solid var(--ink-10)",
        borderRadius: 8,
        padding: "20px 24px",
        display: "flex",
        gap: 16,
      }}
    >
      <StatusDot status={status} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 8,
            marginBottom: 6,
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-ibm-plex), ui-sans-serif",
              fontWeight: 500,
              fontSize: 15,
              color: "var(--ink)",
              lineHeight: 1.3,
            }}
          >
            {item.title}
          </span>
          {showExploration && <ExplorationBadge />}
          <EtaBadge eta={item.eta} />
        </div>
        <p
          style={{
            fontFamily: "var(--font-ibm-plex), ui-sans-serif",
            fontSize: 13,
            color: "var(--ink-55)",
            lineHeight: 1.6,
            margin: 0,
          }}
        >
          {item.description}
        </p>
      </div>
    </div>
  );
}

function SectionHeader({
  label,
  title,
  subtitle,
}: {
  label: string;
  title: string;
  subtitle: string;
}) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div className="eyebrow" style={{ marginBottom: 10 }}>
        {label}
      </div>
      <h2
        style={{
          fontFamily: "var(--font-fraunces), ui-serif",
          fontWeight: 300,
          fontSize: "clamp(24px, 3vw, 36px)",
          lineHeight: 1.1,
          letterSpacing: "-0.01em",
          fontVariationSettings: '"SOFT" 30, "opsz" 48',
          color: "var(--ink)",
          marginBottom: 8,
        }}
      >
        {title}
      </h2>
      <p
        style={{
          fontFamily: "var(--font-ibm-plex), ui-sans-serif",
          fontSize: 15,
          color: "var(--ink-55)",
          lineHeight: 1.5,
          maxWidth: 560,
        }}
      >
        {subtitle}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function RoadmapPage() {
  return (
    <>
      <Nav />
      <main>
        {/* Hero */}
        <section style={{ padding: "80px 0 64px" }}>
          <div className="wrap">
            <div className="eyebrow" style={{ marginBottom: 16 }}>
              Roadmap
            </div>
            <h1
              className="section-head"
              style={{ maxWidth: 640, marginBottom: 20 }}
            >
              What we&rsquo;re{" "}
              <span className="italic-accent">building next.</span>
            </h1>
            <p
              style={{
                fontFamily: "var(--font-fraunces), ui-serif",
                fontSize: 20,
                color: "var(--ink-55)",
                maxWidth: 540,
                lineHeight: 1.5,
                fontVariationSettings: '"opsz" 32',
              }}
            >
              v1.9.0 is current. Below is what&rsquo;s actively in progress,
              what&rsquo;s planned, and what we&rsquo;re exploring.
            </p>
          </div>
        </section>

        {/* Now */}
        <section style={{ padding: "0 0 72px" }}>
          <div className="wrap">
            <SectionHeader
              label="Now"
              title="v1.9 — v2.0"
              subtitle="Features actively in development. Most land in Q2 2026 with the v2.0 milestone."
            />
            <div
              style={{ display: "flex", flexDirection: "column", gap: 12 }}
            >
              {NOW.map((item) => (
                <LedgerCard key={item.title} item={item} status="now" />
              ))}
            </div>
          </div>
        </section>

        {/* Divider */}
        <div
          className="wrap"
          style={{ borderTop: "1px dashed var(--ink-10)", marginBottom: 72 }}
        />

        {/* Next */}
        <section style={{ padding: "0 0 72px" }}>
          <div className="wrap">
            <SectionHeader
              label="Next"
              title="v2.x"
              subtitle="Committed work that hasn't started yet. Sequencing will shift based on user feedback."
            />
            <div
              style={{ display: "flex", flexDirection: "column", gap: 12 }}
            >
              {NEXT.map((item) => (
                <LedgerCard key={item.title} item={item} status="next" />
              ))}
            </div>
          </div>
        </section>

        {/* Divider */}
        <div
          className="wrap"
          style={{ borderTop: "1px dashed var(--ink-10)", marginBottom: 72 }}
        />

        {/* Considering */}
        <section style={{ padding: "0 0 72px" }}>
          <div className="wrap">
            <SectionHeader
              label="Considering"
              title="Ideas, not commitments"
              subtitle="Things we're thinking about. None of these are guaranteed. If one of these matters to you, email us."
            />
            <div
              style={{ display: "flex", flexDirection: "column", gap: 12 }}
            >
              {CONSIDERING.map((item) => (
                <LedgerCard
                  key={item.title}
                  item={item}
                  status="considering"
                  showExploration
                />
              ))}
            </div>
          </div>
        </section>

        {/* Divider */}
        <div
          className="wrap"
          style={{ borderTop: "1px dashed var(--ink-10)", marginBottom: 72 }}
        />

        {/* Shipped */}
        <section style={{ padding: "0 0 72px" }}>
          <div className="wrap">
            <SectionHeader
              label="Shipped"
              title="Highlight reel"
              subtitle="Recent milestones. Full history in the changelog."
            />
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 10,
                marginBottom: 24,
              }}
            >
              {[
                {
                  title: "v1.9.0 — Cross-platform + terminal-native Pro upgrade",
                  description:
                    "TypeScript hooks, Windows PowerShell shell selection, multi-OS CI matrix, VS Code extension packaging.",
                  eta: "Q2 2026" as Quarter,
                },
                {
                  title: "v1.8.0 — Client-side AES-256-GCM genome encryption",
                  description:
                    "Per-section random nonces, keys at ~/.ashlr/team-keys, server stores ciphertext only. Admin dashboard and public status page.",
                  eta: "Q2 2026" as Quarter,
                },
                {
                  title: "v1.7.0 — HTML emails and onboarding wizard",
                  description:
                    "Auto-firing first-run wizard, transactional HTML email templates, session greeting.",
                  eta: "Q2 2026" as Quarter,
                },
                {
                  title: "v1.6.0 — CRDT team genome sync",
                  description:
                    "Shared genome store with CRDT merge, conflict resolution, per-org retrieval index.",
                  eta: "Q2 2026" as Quarter,
                },
              ].map((item) => (
                <LedgerCard key={item.title} item={item} status="shipped" />
              ))}
            </div>
            <a
              href="https://github.com/ashlrai/ashlr-plugin/blob/main/CHANGELOG.md"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontFamily: "var(--font-jetbrains), ui-monospace",
                fontSize: 11,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "var(--debit)",
                textDecoration: "none",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              Full CHANGELOG on GitHub
              <span aria-hidden="true">&rarr;</span>
            </a>
          </div>
        </section>

        {/* Footnote */}
        <section
          style={{
            borderTop: "1px solid var(--ink-10)",
            padding: "40px 0",
            background: "var(--paper-deep)",
          }}
        >
          <div className="wrap">
            <p
              style={{
                fontFamily: "var(--font-ibm-plex), ui-sans-serif",
                fontSize: 13,
                color: "var(--ink-30)",
                lineHeight: 1.6,
                maxWidth: 680,
              }}
            >
              This roadmap is a best-guess. Priorities shift based on user
              feedback. If something here matters to you — or if something
              important is missing — email{" "}
              <a
                href="mailto:support@ashlr.ai"
                style={{ color: "var(--ink-55)", textDecoration: "underline" }}
              >
                support@ashlr.ai
              </a>
              .
            </p>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
