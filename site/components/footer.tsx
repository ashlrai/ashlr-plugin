import Link from "next/link";

export default function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer
      style={{
        borderTop: "1px solid var(--ink-10)",
        padding: "40px 0 36px",
        background: "var(--paper-deep)",
      }}
    >
      <div className="wrap">
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
              The token ledger for Claude Code.
              MIT-licensed. Open-source forever.
            </p>
          </div>

          {/* Links */}
          <nav
            className="flex flex-wrap gap-x-10 gap-y-4"
            aria-label="Footer navigation"
          >
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
              <span className="mono-label mb-1" style={{ fontSize: 10 }}>Ports</span>
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
                href="mailto:mason@evero-consulting.com"
                className="font-mono text-[12px] hover:text-[var(--debit)] transition-colors"
                style={{ color: "var(--ink-55)" }}
              >
                Enterprise
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

          {/* Badges */}
          <div className="flex items-center gap-4">
            <a
              href="https://github.com/ashlrai/ashlr-plugin/blob/main/LICENSE"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="MIT License"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="https://img.shields.io/badge/license-MIT-4F5B3F?style=flat-square&labelColor=ECE2CE"
                alt="MIT License"
                height="20"
                width="90"
              />
            </a>
            <a
              href="https://github.com/ashlrai/ashlr-plugin"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="GitHub stars"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="https://img.shields.io/github/stars/ashlrai/ashlr-plugin?style=flat-square&labelColor=ECE2CE&color=8B2E1A"
                alt="GitHub stars"
                height="20"
                width="90"
              />
            </a>
          </div>

          <span
            className="font-mono text-[10px]"
            style={{ color: "var(--ink-30)" }}
          >
            Built for Anthropic&rsquo;s Claude Code
          </span>
        </div>
      </div>
    </footer>
  );
}
