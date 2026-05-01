"use client";

import { motion } from "framer-motion";
import { tools } from "@/lib/tools";

export default function ToolsGrid() {
  return (
    <section
      className="section-pad"
      style={{ borderTop: "1px solid var(--ink-10)" }}
    >
      <div className="wrap">
        {/* Section label */}
        <div className="eyebrow">
          <span
            className="font-mono text-[10px] border px-2 py-0.5"
            style={{ borderColor: "var(--ink-30)", color: "var(--ink)" }}
          >
            01
          </span>
          MCP Tools
        </div>

        <h2 className="section-head mb-3" style={{ maxWidth: 760 }}>
          {tools.length} tools.{" "}
          <span className="italic-accent">Every read fewer tokens.</span>
        </h2>

        <p
          className="mb-10 sm:mb-14"
          style={{
            fontFamily: "var(--font-fraunces), ui-serif",
            fontSize: "clamp(16px, 1.8vw, 20px)",
            color: "var(--ink-55)",
            maxWidth: 580,
            lineHeight: 1.45,
            fontVariationSettings: '"opsz" 32',
          }}
        >
          Drop-in replacements for Claude Code&rsquo;s built-ins. snipCompact
          trims large results head&plus;tail; genome RAG retrieves only what&rsquo;s
          relevant.
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 340px), 1fr))",
            gap: "1px",
            border: "1px solid var(--ink)",
            background: "var(--ink)",
          }}
        >
          {tools.map((tool, i) => {
            const Wrapper = tool.docHref ? "a" : "div";
            return (
              <motion.div
                key={tool.name}
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-60px" }}
                transition={{ duration: 0.4, delay: (i % 4) * 0.06 }}
                style={{
                  background: "var(--paper-deep)",
                }}
              >
                <Wrapper
                  {...(tool.docHref ? { href: tool.docHref } : {})}
                  className="group block"
                  style={{
                    padding: "24px 24px 22px",
                    cursor: tool.docHref ? "pointer" : "default",
                    textDecoration: "none",
                    color: "inherit",
                    display: "block",
                  }}
                >
                  <div className="flex items-baseline justify-between gap-3 mb-2">
                    <span
                      className="font-mono text-[13px] font-semibold group-hover:text-[var(--debit)] transition-colors duration-200"
                      style={{ color: "var(--ink)" }}
                    >
                      ashlr__{tool.name.replace("-", "_")}
                    </span>
                    {typeof tool.savingsPct === "number" && (
                      <span
                        className="font-mono text-[11px] font-semibold"
                        style={{
                          color: "var(--debit)",
                          background: "rgba(139, 46, 26, 0.08)",
                          padding: "2px 6px",
                          borderRadius: 3,
                          whiteSpace: "nowrap",
                        }}
                        title="Mean token savings on files ≥ 2 KB (benchmarks-v2.json)"
                      >
                        −{tool.savingsPct.toFixed(1)}%
                      </span>
                    )}
                  </div>
                  <p
                    className="font-mono text-[12px] leading-relaxed"
                    style={{ color: "var(--ink-55)" }}
                  >
                    {tool.description}
                  </p>
                </Wrapper>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
