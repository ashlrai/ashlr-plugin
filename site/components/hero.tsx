"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import CountUp from "./bits/CountUp";
import Magnet from "./bits/Magnet";
import TerminalMock from "./terminal-mock";
import HeroVideoPlayer from "./hero-video-player";
import InstallCountBadge from "./install-count-badge";
import CopyButton from "./copy-button";

const Threads = dynamic(() => import("./bits/Threads"), { ssr: false });
const DecryptedText = dynamic(() => import("./bits/DecryptedText"), {
  ssr: false,
  loading: () => <span>Ship less context.</span>,
});

const INSTALL_TABS = [
  {
    id: "claude",
    label: "Claude Code",
    cmd: "claude mcp add ashlr -- npx -y ashlr-plugin",
  },
  {
    id: "cursor",
    label: "Cursor",
    cmd: "curl -fsSL https://raw.githubusercontent.com/ashlrai/ashlr-plugin/main/ports/cursor/mcp.json \\\n  > ~/.cursor/mcp.json",
  },
  {
    id: "goose",
    label: "Goose",
    cmd: "curl -fsSL https://raw.githubusercontent.com/ashlrai/ashlr-plugin/main/ports/goose/recipe.yaml \\\n  > ~/.config/goose/recipes/ashlr.yaml",
  },
] as const;

type TabId = (typeof INSTALL_TABS)[number]["id"];

interface HeroProps {
  /** Overall mean token savings as a percentage string, e.g. "71.3".
   *  Read from docs/benchmarks-v2.json at build time by the parent server
   *  component. Falls back to "79.5" if the file is absent. */
  savingsPct?: string;
}

export default function Hero({ savingsPct = "79.5" }: HeroProps) {
  const [inView, setInView] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>("claude");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setInView(true); },
      { threshold: 0.1 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const currentTab = INSTALL_TABS.find((t) => t.id === activeTab)!;

  return (
    <section
      ref={ref}
      className="relative overflow-hidden"
      style={{ minHeight: "90vh", display: "flex", flexDirection: "column" }}
    >
      {/* Background threads */}
      <div className="absolute inset-0 z-0" aria-hidden="true" style={{ opacity: 0.6 }}>
        <Threads color={[139, 46, 26]} amplitude={80} distance={0.25} enableMouseInteraction />
      </div>

      <div className="wrap relative z-10 flex flex-col flex-1 py-12 sm:py-16 lg:py-28">
        {/* Eyebrow */}
        <div className="eyebrow">Open-source · MIT · Zero telemetry</div>

        {/* Headline */}
        <h1 className="display-head mb-6 sm:mb-8" style={{ maxWidth: 900 }}>
          <DecryptedText
            text="Ship less"
            speed={40}
            maxIterations={12}
            characters="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%"
            animateOn="mount"
            className=""
            encryptedClassName="italic-accent"
          />
          <br />
          <span className="italic-accent">context.</span>
        </h1>

        {/* Subhead */}
        <p
          className="mb-8 sm:mb-12"
          style={{
            fontFamily: "var(--font-fraunces), ui-serif, Georgia, serif",
            fontWeight: 300,
            fontSize: "clamp(17px, 2vw, 24px)",
            lineHeight: 1.45,
            color: "var(--ink-80)",
            maxWidth: 640,
            fontVariationSettings: '"opsz" 36',
          }}
        >
          Open-source token ledger for Claude Code. 19 MCP tools. Mean{" "}
          &minus;{savingsPct}% savings on files&nbsp;&ge;&nbsp;2&nbsp;KB,{" "}
          <a
            href="/benchmarks"
            style={{ color: "inherit", textDecoration: "underline", textDecorationStyle: "dotted", textUnderlineOffset: "3px" }}
          >
            measured to the byte
          </a>
          . MIT-licensed. Zero telemetry.
        </p>

        {/* Live counter */}
        <div className="mb-8 sm:mb-12">
          <div
            className="ledger-card inline-block px-6 py-5 sm:px-8 sm:py-6 max-w-full"
            style={{ minWidth: "min(280px, 100%)" }}
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
                fontSize: "clamp(32px, 5vw, 52px)",
                fontWeight: 600,
                color: "var(--debit)",
                letterSpacing: "-0.02em",
              }}
            >
              +
              <CountUp to={4300000} from={0} duration={2600} separator="," startWhen={inView} />
            </div>
          </div>
          <InstallCountBadge />
        </div>

        {/* Hero video (falls back to static terminal mock if video absent
            or reduced-motion requested) */}
        <div className="mb-10 sm:mb-14 w-full" style={{ maxWidth: 640 }}>
          <HeroVideoPlayer fallback={<TerminalMock />} />
        </div>

        {/* CTA */}
        <div className="flex flex-col gap-5" style={{ maxWidth: 580 }}>
          <div className="flex flex-wrap gap-4 items-center">
            <Magnet magnetStrength={0.25} padding={40}>
              <a href="#install" className="btn btn-primary">
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
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
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

          {/* Tabbed install switcher */}
          <div id="install" className="ledger-card overflow-hidden">
            {/* Tab bar — horizontal-scrollable on narrow screens so 3 tabs +
                copy button never overflow into a wrapped second row. */}
            <div
              className="flex items-stretch border-b border-[var(--ink-10)] overflow-x-auto"
              style={{ background: "var(--paper)", scrollbarWidth: "none" }}
              role="tablist"
              aria-label="Install options"
            >
              {INSTALL_TABS.map((tab) => {
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    role="tab"
                    aria-selected={isActive}
                    aria-controls={`install-panel-${tab.id}`}
                    id={`install-tab-${tab.id}`}
                    onClick={() => setActiveTab(tab.id)}
                    style={{
                      fontFamily: "var(--font-jetbrains), ui-monospace, monospace",
                      fontSize: 10,
                      letterSpacing: "0.14em",
                      textTransform: "uppercase",
                      padding: "10px 16px",
                      cursor: "pointer",
                      background: "transparent",
                      border: "none",
                      borderBottom: isActive
                        ? "2px solid var(--debit)"
                        : "2px solid transparent",
                      color: isActive ? "var(--ink)" : "var(--ink-30)",
                      transition: "color 0.15s, border-color 0.15s",
                      marginBottom: -1,
                      flexShrink: 0,
                    }}
                  >
                    {tab.label}
                  </button>
                );
              })}
              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", paddingRight: 12 }}>
                <CopyButton text={currentTab.cmd} />
              </div>
            </div>

            {/* Command panels */}
            {INSTALL_TABS.map((tab) => (
              <div
                key={tab.id}
                id={`install-panel-${tab.id}`}
                role="tabpanel"
                aria-labelledby={`install-tab-${tab.id}`}
                hidden={activeTab !== tab.id}
                style={{ background: "var(--paper-deep)" }}
              >
                <div className="px-4 py-3">
                  <code
                    className="font-mono text-[13px]"
                    style={{
                      color: "var(--ink-80)",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                      display: "block",
                    }}
                  >
                    <span style={{ color: "var(--ink-30)", userSelect: "none" }}>$ </span>
                    {tab.cmd}
                  </code>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
