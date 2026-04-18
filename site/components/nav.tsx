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

        <nav
          style={{
            fontFamily: "var(--font-jetbrains), ui-monospace",
            fontSize: 11,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            display: "flex",
            gap: 28,
          }}
        >
          {[
            { href: "#install", label: "Install" },
            { href: "/pricing", label: "Pricing" },
            { href: "https://github.com/ashlrai/ashlr-plugin", label: "GitHub", external: true },
          ].map((link) => (
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
        </nav>
      </div>
    </header>
  );
}
