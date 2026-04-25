"use client";

import { motion } from "framer-motion";
import { skills } from "@/lib/tools";

export default function SkillsGrid() {
  return (
    <section style={{ padding: "0 0 96px" }}>
      <div className="wrap">
        <div className="eyebrow">
          <span
            className="font-mono text-[10px] border px-2 py-0.5"
            style={{ borderColor: "var(--ink-30)", color: "var(--ink)" }}
          >
            02
          </span>
          Slash Commands
        </div>

        <h2 className="section-head mb-3" style={{ maxWidth: 640 }}>
          30 skills.{" "}
          <span className="italic-accent">Zero friction.</span>
        </h2>

        <p
          className="mb-10"
          style={{
            fontFamily: "var(--font-fraunces), ui-serif",
            fontSize: 20,
            color: "var(--ink-55)",
            maxWidth: 540,
            lineHeight: 1.45,
            fontVariationSettings: '"opsz" 32',
          }}
        >
          Type <code className="font-mono text-[15px]" style={{ color: "var(--debit)" }}>/ashlr-</code>
          {" "}in Claude Code to access dashboards, demos, and diagnostics.
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 260px), 1fr))",
            gap: "1px",
            border: "1px solid var(--ink)",
            background: "var(--ink)",
          }}
        >
          {skills.map((skill, i) => (
            <motion.div
              key={skill.name}
              initial={{ opacity: 0, y: 8 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-40px" }}
              transition={{ duration: 0.35, delay: (i % 3) * 0.05 }}
              className="group"
              style={{
                background: "var(--paper-deep)",
                padding: "20px 22px 18px",
              }}
            >
              <div className="mb-1.5">
                <span
                  className="font-mono text-[12px] font-semibold group-hover:text-[var(--debit)] transition-colors duration-200"
                  style={{ color: "var(--ink)" }}
                >
                  /ashlr-{skill.name}
                </span>
              </div>
              <p
                className="font-mono text-[11px] leading-relaxed"
                style={{ color: "var(--ink-55)" }}
              >
                {skill.description}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
