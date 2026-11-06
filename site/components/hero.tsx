"use client";

import product from "@/lib/product.generated.json";
import { useState } from "react";
import CopyButton from "./copy-button";
import TerminalMock from "./terminal-mock";

const INSTALL_TABS = [
  {
    id: "claude",
    label: "Claude Code",
    logo: "/logos/claude.svg",
    cmd: product.install.claude,
  },
  {
    id: "codex",
    label: "Codex",
    logo: "/logos/openai.svg",
    cmd: product.install.codex,
  },
  {
    id: "cursor",
    label: "Cursor",
    logo: "/logos/cursor.svg",
    cmd: product.install.cursor,
  },
  {
    id: "goose",
    label: "Goose",
    logo: "/logos/goose.svg",
    cmd: product.install.goose,
  },
] as const;

const proof = [
  { value: "75%", label: "fewer read tokens per call" },
  { value: "27%", label: "fewer grep tokens per call" },
  { value: String(product.counts.mcpTools), label: "MCP tools in one router" },
] as const;

const hosts = [
  { label: "Claude Code", logo: "/logos/claude.svg" },
  { label: "Codex / OpenAI", logo: "/logos/openai.svg" },
  { label: "Cursor", logo: "/logos/cursor.svg" },
  { label: "Goose", logo: "/logos/goose.svg" },
  { label: "Generic MCP", logo: "/logos/mcp.svg" },
] as const;

type TabId = (typeof INSTALL_TABS)[number]["id"];

export default function Hero() {
  const [activeTab, setActiveTab] = useState<TabId>("claude");
  const currentTab = INSTALL_TABS.find((tab) => tab.id === activeTab)!;

  return (
    <section className="hero-clean">
      <div className="wrap">
        <div className="hero-clean__layout">
          <div className="hero-clean__copy">
            <p className="hero-kicker">Claude Code-ready. Codex-native. MCP everywhere.</p>
            <h1 className="hero-title">
              Cut AI coding context without cutting the work.
            </h1>
            <p className="hero-copy">
              Ashlr swaps noisy read, grep, edit, and shell output for compact MCP
              tools. Claude Code gets slash commands, redirects, and a status line;
              Codex gets plugin packaging, skills, and nudge hooks.
            </p>

            <div className="hero-actions" aria-label="Primary actions">
              <a href="#install" className="btn btn-primary">Install Ashlr</a>
              <a href="/llms.txt" className="btn btn-secondary">Agent index</a>
              <a href="https://github.com/ashlrai/ashlr-plugin" className="btn btn-secondary">Star on GitHub</a>
            </div>
          </div>

          <aside id="install" className="install-panel" aria-label="Install Ashlr">
            <div className="install-panel__header">
              <div>
                <p className="mono-label">Install path</p>
                <h2>Start with Claude Code, or bring any MCP host.</h2>
              </div>
              <CopyButton text={currentTab.cmd} />
            </div>

            <div className="install-tabs" role="tablist" aria-label="Install options">
              {INSTALL_TABS.map((tab) => (
                <button
                  key={tab.id}
                  id={`install-tab-${tab.id}`}
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  aria-controls={`install-panel-${tab.id}`}
                  onClick={() => setActiveTab(tab.id)}
                  className={activeTab === tab.id ? "is-active" : ""}
                  type="button"
                >
                  <img src={tab.logo} alt="" aria-hidden="true" />
                  {tab.label}
                </button>
              ))}
            </div>

            {INSTALL_TABS.map((tab) => (
              <pre
                key={tab.id}
                id={`install-panel-${tab.id}`}
                role="tabpanel"
                aria-labelledby={`install-tab-${tab.id}`}
                hidden={activeTab !== tab.id}
                className="install-command"
              >
                <code>{tab.cmd}</code>
              </pre>
            ))}

            <div className="hero-terminal">
              <TerminalMock />
            </div>
          </aside>

          <div className="hero-meta">
            <div className="hero-proof" aria-label="Ashlr proof points">
              {proof.map((item) => (
                <article key={item.label}>
                  <strong>{item.value}</strong>
                  <span>{item.label}</span>
                </article>
              ))}
            </div>
            <p className="hero-benchmark">
              2026-10-17 reference run. Per tool call, not a whole session.{" "}
              <a href="/benchmarks">Methodology</a>
            </p>

            <div className="host-strip" aria-label="Supported hosts">
              {hosts.map((host) => (
                <span key={host.label}>
                  <img src={host.logo} alt="" aria-hidden="true" />
                  {host.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
