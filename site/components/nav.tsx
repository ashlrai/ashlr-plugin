"use client";

export default function Nav() {
  return (
    <header
      style={{
        borderBottom: "1px solid var(--ink-10)",
        padding: "20px 0",
        position: "sticky",
        top: 0,
        zIndex: 50,
        background: "var(--paper)",
        backdropFilter: "blur(8px)",
      }}
    >
      <div className="wrap flex items-baseline justify-between gap-6">
        {/* Wordmark */}
        <a
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
          <span
            aria-hidden="true"
            style={{
              display: "inline-block",
              width: 7,
              height: 7,
              background: "var(--debit)",
              borderRadius: 1,
              marginRight: 8,
              transform: "translateY(-3px)",
            }}
          />
          ashlr
        </a>

        {/* Nav links */}
        <nav
          style={{
            fontFamily: "var(--font-jetbrains), ui-monospace",
            fontSize: 11,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            display: "flex",
            gap: 24,
            alignItems: "center",
          }}
        >
          {(
            [
              { href: "/docs", label: "Docs" },
              { href: "/pricing", label: "Pricing" },
              { href: "#install", label: "Install" },
            ] as { href: string; label: string; external?: boolean }[]
          ).map((link) => (
            <a
              key={link.label}
              href={link.href}
              target={link.external ? "_blank" : undefined}
              rel={link.external ? "noopener noreferrer" : undefined}
              className="text-[var(--ink-55)] hover:text-[var(--ink)] transition-colors duration-200"
              style={{ textDecoration: "none" }}
            >
              {link.label}
            </a>
          ))}

          {/* GitHub with star badge */}
          <a
            href="https://github.com/ashlrai/ashlr-plugin"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--ink-55)] hover:text-[var(--ink)] transition-colors duration-200"
            style={{ textDecoration: "none", display: "flex", alignItems: "center", gap: 6 }}
            aria-label="GitHub repository"
          >
            GitHub
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                fontFamily: "var(--font-jetbrains), ui-monospace, monospace",
                fontSize: 9,
                letterSpacing: "0.06em",
                color: "var(--ink-30)",
                border: "1px solid var(--ink-10)",
                borderRadius: 3,
                padding: "1px 5px",
                lineHeight: 1.6,
              }}
              aria-hidden="true"
            >
              <svg width="8" height="8" viewBox="0 0 12 12" fill="none">
                <path
                  d="M6 1l1.4 2.9L11 4.4 8.5 6.9l.6 3.6L6 8.9l-3.1 1.6.6-3.6L1 4.4l3.6-.5L6 1z"
                  fill="currentColor"
                />
              </svg>
              Star
            </span>
          </a>
        </nav>
      </div>
    </header>
  );
}
