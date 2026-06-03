import Link from "next/link";

export default function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer
      style={{
        borderTop: "1px solid var(--ink-10)",
        background: "var(--paper-deep)",
      }}
    >
      <div className="wrap" style={{ paddingTop: "clamp(40px, 5vw, 64px)", paddingBottom: "clamp(32px, 4vw, 48px)" }}>
        <div
          className="flex flex-wrap justify-between items-start gap-8"
        >
          {/* Brand */}
          <div>
            <div
              className="font-display font-light mb-2"
              style={{
                fontSize: 18,
                fontFamily: "var(--font-fraunces), ui-serif",
                letterSpacing: "-0.01em",
                fontVariationSettings: '"SOFT" 30, "opsz" 30',
              }}
            >
              ashlr
            </div>
            <p
              className="font-mono text-[11px]"
              style={{ color: "var(--ink-30)", maxWidth: 260, lineHeight: 1.6 }}
            >
              The token ledger for Codex, Claude Code, and MCP hosts.
              MIT-licensed. Open-source forever.
            </p>
          </div>

          {/* Links */}
          <nav
            className="grid grid-cols-2 sm:flex sm:flex-wrap gap-x-10 gap-y-6"
            aria-label="Footer navigation"
          >
            <div className="flex flex-col gap-2">
              <span className="mono-label mb-1" style={{ fontSize: 10 }}>Company</span>
              <Link
                href="/blog"
                className="font-mono text-[12px] hover:text-[var(--debit)] transition-colors"
                style={{ color: "var(--ink-55)" }}
              >
                Blog
              </Link>
              <Link
                href="/roadmap"
                className="font-mono text-[12px] hover:text-[var(--debit)] transition-colors"
                style={{ color: "var(--ink-55)" }}
              >
                Roadmap
              </Link>
              <a
                href="mailto:support@ashlr.ai"
                className="font-mono text-[12px] hover:text-[var(--debit)] transition-colors"
                style={{ color: "var(--ink-55)" }}
              >
                support@ashlr.ai
              </a>
            </div>

            <div className="flex flex-col gap-2">
              <span className="mono-label mb-1" style={{ fontSize: 10 }}>Project</span>
              <a
                href="https://github.com/ashlrai/ashlr-plugin"
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-[12px] hover:text-[var(--debit)] transition-colors"
                style={{ color: "var(--ink-55)" }}
              >
                GitHub
              </a>
              <a
                href="https://github.com/ashlrai/ashlr-plugin/blob/main/CHANGELOG.md"
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-[12px] hover:text-[var(--debit)] transition-colors"
                style={{ color: "var(--ink-55)" }}
              >
                Changelog
              </a>
              <a
                href="https://github.com/ashlrai/ashlr-plugin/blob/main/LICENSE"
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-[12px] hover:text-[var(--debit)] transition-colors"
                style={{ color: "var(--ink-55)" }}
              >
                MIT License
              </a>
            </div>

            <div className="flex flex-col gap-2">
              <span className="mono-label mb-1" style={{ fontSize: 10 }}>Hosts</span>
              <a
                href="https://github.com/ashlrai/ashlr-plugin/tree/main/.codex-plugin"
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-[12px] hover:text-[var(--debit)] transition-colors"
                style={{ color: "var(--ink-55)" }}
              >
                Codex
              </a>
              <a
                href="https://github.com/ashlrai/ashlr-plugin/tree/main/.claude-plugin"
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-[12px] hover:text-[var(--debit)] transition-colors"
                style={{ color: "var(--ink-55)" }}
              >
                Claude Code
              </a>
              <a
                href="https://github.com/ashlrai/ashlr-plugin/tree/main/ports"
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-[12px] hover:text-[var(--debit)] transition-colors"
                style={{ color: "var(--ink-55)" }}
              >
                Cursor
              </a>
              <a
                href="https://github.com/ashlrai/ashlr-plugin/tree/main/ports"
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-[12px] hover:text-[var(--debit)] transition-colors"
                style={{ color: "var(--ink-55)" }}
              >
                Goose
              </a>
            </div>

            <div className="flex flex-col gap-2">
              <span className="mono-label mb-1" style={{ fontSize: 10 }}>Pricing</span>
              <Link
                href="/pricing"
                className="font-mono text-[12px] hover:text-[var(--debit)] transition-colors"
                style={{ color: "var(--ink-55)" }}
              >
                Plans
              </Link>
              <a
                href="mailto:support@ashlr.ai"
                className="font-mono text-[12px] hover:text-[var(--debit)] transition-colors"
                style={{ color: "var(--ink-55)" }}
              >
                Enterprise
              </a>
            </div>

            <div className="flex flex-col gap-2">
              <span className="mono-label mb-1" style={{ fontSize: 10 }}>Legal</span>
              <Link
                href="/privacy"
                className="font-mono text-[12px] hover:text-[var(--debit)] transition-colors"
                style={{ color: "var(--ink-55)" }}
              >
                Privacy
              </Link>
              <Link
                href="/terms"
                className="font-mono text-[12px] hover:text-[var(--debit)] transition-colors"
                style={{ color: "var(--ink-55)" }}
              >
                Terms
              </Link>
              <Link
                href="/dpa"
                className="font-mono text-[12px] hover:text-[var(--debit)] transition-colors"
                style={{ color: "var(--ink-55)" }}
              >
                DPA
              </Link>
              <a
                href="mailto:support@ashlr.ai"
                className="font-mono text-[12px] hover:text-[var(--debit)] transition-colors"
                style={{ color: "var(--ink-55)" }}
              >
                support@ashlr.ai
              </a>
            </div>
          </nav>
        </div>

        {/* Bottom bar */}
        <div
          className="flex flex-wrap items-center justify-between gap-4 mt-10 pt-6"
          style={{ borderTop: "1px dashed var(--ink-10)" }}
        >
          <span
            className="font-mono text-[11px]"
            style={{ color: "var(--ink-30)" }}
          >
            &copy; {year} Mason Wyatt &mdash; ashlr
          </span>

          <span
            className="font-mono text-[10px]"
            style={{ color: "var(--ink-30)" }}
          >
            Open source. Local-first. Opt-in telemetry.
          </span>

          <span
            className="font-mono text-[10px]"
            style={{ color: "var(--ink-30)" }}
          >
            Built for Codex, Claude Code, and MCP hosts
          </span>
        </div>
      </div>
    </footer>
  );
}
