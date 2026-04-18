"use client";

import { motion } from "framer-motion";
import { tools } from "@/lib/tools";

export default function ToolsGrid() {
  return (
    <section style={{ padding: "96px 0", borderTop: "1px solid var(--ink-10)" }}>
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
          14 tools.{" "}
          <span className="italic-accent">Every read fewer tokens.</span>
        </h2>

        <p
          className="mb-14"
          style={{
            fontFamily: "var(--font-fraunces), ui-serif",
            fontSize: 20,
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
          {tools.map((tool, i) => (
            <motion.div
              key={tool.name}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{ duration: 0.4, delay: (i % 4) * 0.06 }}
              className="group"
              style={{
                background: "var(--paper-deep)",
                padding: "24px 24px 22px",
                cursor: "default",
              }}
            >
              <div className="flex items-baseline gap-2 mb-2">
                <span
                  className="font-mono text-[13px] font-semibold group-hover:text-[var(--debit)] transition-colors duration-200"
                  style={{ color: "var(--ink)" }}
                >
                  ashlr__{tool.name.replace("-", "_")}
                </span>
              </div>
              <p
                className="font-mono text-[12px] leading-relaxed"
                style={{ color: "var(--ink-55)" }}
              >
                {tool.description}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
