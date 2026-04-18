"use client";

export default function SocialProof() {
  return (
    <section
      style={{
        padding: "72px 0",
        borderTop: "1px solid var(--ink-10)",
      }}
    >
      <div className="wrap">
        <div className="eyebrow">
          <span
            className="font-mono text-[10px] border px-2 py-0.5"
            style={{ borderColor: "var(--ink-30)", color: "var(--ink)" }}
          >
            05
          </span>
          Open source
        </div>

        <h2 className="section-head mb-10" style={{ maxWidth: 580 }}>
          Auditable to the{" "}
          <span className="italic-accent">last byte.</span>
        </h2>

        <div className="flex flex-wrap gap-5 mb-10">
          {/* MIT badge */}
          <a
            href="https://github.com/ashlrai/ashlr-plugin/blob/main/LICENSE"
            target="_blank"
            rel="noopener noreferrer"
            className="ledger-card px-5 py-3 flex items-center gap-3 hover:border-[var(--debit)] transition-colors"
            style={{ textDecoration: "none" }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="https://img.shields.io/badge/license-MIT-4F5B3F?style=flat-square&labelColor=ECE2CE"
              alt="MIT License badge"
              height="20"
              width="90"
            />
            <span
              className="font-mono text-[12px]"
              style={{ color: "var(--ink-55)" }}
            >
              MIT License
            </span>
          </a>

          {/* GitHub stars */}
          <a
            href="https://github.com/ashlrai/ashlr-plugin"
            target="_blank"
            rel="noopener noreferrer"
            className="ledger-card px-5 py-3 flex items-center gap-3 hover:border-[var(--debit)] transition-colors"
            style={{ textDecoration: "none" }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="https://img.shields.io/github/stars/ashlrai/ashlr-plugin?style=flat-square&labelColor=ECE2CE&color=8B2E1A"
              alt="GitHub stars"
              height="20"
              width="90"
            />
            <span
              className="font-mono text-[12px]"
              style={{ color: "var(--ink-55)" }}
            >
              GitHub
            </span>
          </a>
        </div>

        {/* Link row */}
        <div className="flex flex-wrap gap-x-8 gap-y-3">
          {[
            { href: "https://github.com/ashlrai/ashlr-plugin", label: "Source code" },
            { href: "https://github.com/ashlrai/ashlr-plugin/tree/main/ports", label: "Cursor + Goose ports" },
            { href: "https://github.com/ashlrai/ashlr-plugin/blob/main/CHANGELOG.md", label: "Changelog" },
          ].map((link) => (
            <a
              key={link.href}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[12px] inline-flex items-center gap-1.5 text-[var(--ink-55)] hover:text-[var(--debit)] transition-colors duration-200"
            >
              {link.label}
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <path
                  d="M1.5 8.5L8.5 1.5M8.5 1.5H3.5M8.5 1.5V6.5"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}
