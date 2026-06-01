"use client";

import { useState, useEffect, useRef } from "react";
import { Menu, X } from "lucide-react";

const NAV_LINKS = [
  { href: "/docs", label: "Docs" },
  { href: "/community", label: "Savings" },
  { href: "/blog", label: "Blog" },
  { href: "/roadmap", label: "Roadmap" },
  { href: "/pricing", label: "Pricing" },
  { href: "#install", label: "Install" },
] as const;

export default function Nav() {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Prevent body scroll while mobile menu open
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  const monoStyle: React.CSSProperties = {
    fontFamily: "var(--font-jetbrains), ui-monospace",
    fontSize: 11,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    textDecoration: "none",
  };

  return (
    <>
      <header
        style={{
          borderBottom: "1px solid var(--ink-10)",
          position: "sticky",
          top: 0,
          zIndex: 50,
          background: "var(--paper)",
          backdropFilter: "blur(8px)",
        }}
      >
        <div
          className="wrap"
          style={{
            height: 60,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
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
              display: "flex",
              alignItems: "center",
              flexShrink: 0,
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
                flexShrink: 0,
              }}
            />
            ashlr
          </a>

          {/* Desktop nav — hidden below md via CSS */}
          <nav
            className="nav-desktop-links"
            aria-label="Main navigation"
            style={{
              ...monoStyle,
              display: "flex",
              gap: 24,
              alignItems: "center",
            }}
          >
            {NAV_LINKS.map((link) => (
              <a
                key={link.label}
                href={link.href}
                className="text-[var(--ink-55)] hover:text-[var(--ink)] transition-colors duration-200"
                style={{ textDecoration: "none", ...monoStyle }}
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
              style={{
                textDecoration: "none",
                display: "flex",
                alignItems: "center",
                gap: 6,
                ...monoStyle,
              }}
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

            {/* Desktop CTA */}
            <a
              href="#install"
              className="btn btn-primary"
              style={{ padding: "9px 18px", fontSize: 11 }}
            >
              Install &rarr;
            </a>
          </nav>

          {/* Hamburger — visible only below md via CSS */}
          <button
            className="nav-hamburger"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls="mobile-menu"
            onClick={() => setOpen((v) => !v)}
            style={{
              background: "transparent",
              border: "1px solid var(--ink-10)",
              borderRadius: 3,
              padding: "7px 9px",
              cursor: "pointer",
              color: "var(--ink)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {open ? <X size={18} strokeWidth={1.5} /> : <Menu size={18} strokeWidth={1.5} />}
          </button>
        </div>
      </header>

      {/* Mobile menu panel — slides down from header */}
      <div
        id="mobile-menu"
        ref={menuRef}
        role="dialog"
        aria-modal="true"
        aria-label="Mobile navigation"
        aria-hidden={!open}
        className="mobile-menu-panel"
        style={{
          position: "fixed",
          top: 60,
          left: 0,
          right: 0,
          bottom: 0,
          background: "var(--paper)",
          borderTop: "1px solid var(--ink-10)",
          zIndex: 49,
          display: "flex",
          flexDirection: "column",
          padding: "32px var(--gutter) 40px",
          transform: open ? "translateY(0)" : "translateY(-110%)",
          opacity: open ? 1 : 0,
          transition: "transform 0.22s cubic-bezier(0.4,0,0.2,1), opacity 0.18s ease",
          pointerEvents: open ? "auto" : "none",
          overflowY: "auto",
        }}
      >
        <nav aria-label="Mobile navigation links">
          <ul style={{ listStyle: "none", display: "flex", flexDirection: "column" }}>
            {NAV_LINKS.map((link) => (
              <li
                key={link.label}
                style={{ borderBottom: "1px solid var(--ink-10)" }}
              >
                <a
                  href={link.href}
                  onClick={() => setOpen(false)}
                  style={{
                    ...monoStyle,
                    display: "block",
                    padding: "18px 0",
                    color: "var(--ink-80)",
                  }}
                >
                  {link.label}
                </a>
              </li>
            ))}
            <li style={{ borderBottom: "1px solid var(--ink-10)" }}>
              <a
                href="https://github.com/ashlrai/ashlr-plugin"
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
                style={{
                  ...monoStyle,
                  display: "block",
                  padding: "18px 0",
                  color: "var(--ink-80)",
                }}
              >
                GitHub
              </a>
            </li>
          </ul>
        </nav>

        <div style={{ marginTop: 32 }}>
          <a
            href="#install"
            className="btn btn-primary"
            onClick={() => setOpen(false)}
            style={{
              display: "flex",
              width: "100%",
              justifyContent: "center",
            }}
          >
            Install in 30 seconds &rarr;
          </a>
        </div>
      </div>

      {/* Backdrop */}
      <div
        aria-hidden="true"
        onClick={() => setOpen(false)}
        style={{
          position: "fixed",
          top: 60,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(0,0,0,0.25)",
          zIndex: 48,
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: "opacity 0.2s ease",
        }}
      />
    </>
  );
}
