"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import CountUp from "./bits/CountUp";
import Magnet from "./bits/Magnet";
import TerminalMock from "./terminal-mock";
import CopyButton from "./copy-button";

// Dynamic import Threads so SSR doesn't break canvas
const Threads = dynamic(() => import("./bits/Threads"), { ssr: false });

// Dynamic import DecryptedText (client only)
const DecryptedText = dynamic(() => import("./bits/DecryptedText"), {
  ssr: false,
  loading: () => (
    <span>The token ledger for Claude Code.</span>
  ),
});

const INSTALL_CMD = "claude mcp add ashlr -- npx -y ashlr-plugin";

export default function Hero() {
  const [inView, setInView] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setInView(true);
    }, { threshold: 0.1 });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <section
      ref={ref}
      className="relative overflow-hidden"
      style={{ minHeight: "90vh", display: "flex", flexDirection: "column" }}
    >
      {/* Background threads — absolutely positioned, pointer-events: none */}
      <div
        className="absolute inset-0 z-0"
        aria-hidden="true"
        style={{ opacity: 0.6 }}
      >
        <Threads
          color={[139, 46, 26]}
          amplitude={80}
          distance={0.25}
          enableMouseInteraction
        />
      </div>

      <div className="wrap relative z-10 flex flex-col flex-1 py-20 lg:py-28">
        {/* Eyebrow */}
        <div className="eyebrow">
          Open-source · MIT · Zero telemetry
        </div>

        {/* Headline */}
        <h1
          className="display-head mb-8"
          style={{ maxWidth: 900 }}
        >
          <DecryptedText
            text="The token ledger"
            speed={40}
            maxIterations={12}
            characters="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%"
            animateOn="mount"
            className=""
            encryptedClassName="italic-accent"
          />
          <br />
          <span className="italic-accent">
            for Claude Code.
          </span>
        </h1>

        {/* Subhead */}
        <p
          className="mb-12"
          style={{
            fontFamily: "var(--font-fraunces), ui-serif, Georgia, serif",
            fontWeight: 300,
            fontSize: "clamp(18px, 2vw, 24px)",
            lineHeight: 1.45,
            color: "var(--ink-80)",
            maxWidth: 640,
            fontVariationSettings: '"opsz" 36',
          }}
        >
          Mean &minus;79.5% token savings on files&nbsp;&ge;&nbsp;2&nbsp;KB.
          MIT-licensed. Zero telemetry.
        </p>

        {/* Live counter */}
        <div className="mb-12">
          <div
            className="ledger-card inline-block px-8 py-6"
            style={{ minWidth: 280 }}
          >
            <div
              className="font-mono text-[11px] tracking-[0.18em] uppercase mb-3"
              style={{ color: "var(--ink-55)" }}
            >
              Tokens saved by users this week
            </div>
            <div
              className="font-mono tabular-nums leading-none"
              style={{
                fontSize: "clamp(36px, 5vw, 52px)",
                fontWeight: 600,
                color: "var(--debit)",
                letterSpacing: "-0.02em",
              }}
            >
              +
              <CountUp
                to={4300000}
                from={0}
                duration={2600}
                separator=","
                startWhen={inView}
              />
            </div>
          </div>
        </div>

        {/* Terminal mock */}
        <div className="mb-14" style={{ maxWidth: 640 }}>
          <TerminalMock />
        </div>

        {/* CTA */}
        <div className="flex flex-col gap-5" style={{ maxWidth: 540 }}>
          <div className="flex flex-wrap gap-4 items-center">
            <Magnet magnetStrength={0.25} padding={40}>
              <a
                href="#install"
                className="btn btn-primary"
              >
                Install in 30 seconds
                <span
                  className="inline-block transition-transform duration-200"
                  style={{ transform: "none" }}
                  aria-hidden="true"
                >
                  &rarr;
                </span>
              </a>
            </Magnet>

            <a
              href="https://github.com/ashlrai/ashlr-plugin"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary"
            >
              GitHub
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <path
                  d="M2 10L10 2M10 2H4M10 2v6"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </a>
          </div>

          {/* Install command */}
          <div id="install" className="ledger-card overflow-hidden">
            <div
              className="flex items-center justify-between px-4 py-2 border-b border-[var(--ink-10)]"
              style={{ background: "var(--paper)" }}
            >
              <span className="mono-label">Install command</span>
              <CopyButton text={INSTALL_CMD} />
            </div>
            <div className="px-4 py-3" style={{ background: "var(--paper-deep)" }}>
              <code
                className="font-mono text-[13px] break-all"
                style={{ color: "var(--ink-80)" }}
              >
                <span style={{ color: "var(--ink-30)", userSelect: "none" }}>$ </span>
                {INSTALL_CMD}
              </code>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
