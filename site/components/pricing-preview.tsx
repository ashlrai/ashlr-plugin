"use client";

import { motion } from "framer-motion";
import Link from "next/link";

const plans = [
  {
    name: "Free",
    price: "$0",
    period: "forever",
    positioning: "The full plugin — every tool, every skill, no strings.",
    features: [
      "14 MCP tools + 23 skills",
      "Local genome scribe loop",
      "Per-session token ledger",
      "Cursor + Goose ports",
    ],
    cta: "Start free",
    ctaHref: "https://github.com/ashlrai/ashlr-plugin",
    ctaTier: null as null,
    ctaExternal: true,
    featured: false,
  },
  {
    name: "Pro",
    price: "$12",
    period: "per month",
    positioning: "Cloud infra for one developer who wants sync and speed.",
    features: [
      "Everything in Free",
      "Cloud LLM summarizer",
      "Cross-machine stats sync",
      "Live auto-updating badge",
    ],
    cta: "Upgrade to Pro",
    ctaHref: null,
    ctaTier: "pro" as const,
    ctaExternal: false,
    featured: true,
  },
  {
    name: "Team",
    price: "$24",
    period: "per user/month",
    positioning: "Shared genome and org-level visibility for engineering teams.",
    features: [
      "Everything in Pro",
      "Shared CRDT team genome",
      "Org savings dashboard",
      "SSO + SCIM + audit log",
    ],
    cta: "Upgrade to Team",
    ctaHref: null,
    ctaTier: "team" as const,
    ctaExternal: false,
    featured: false,
  },
];

export default function PricingPreview() {
  return (
    <section style={{ padding: "96px 0", borderTop: "1px solid var(--ink-10)" }}>
      <div className="wrap">
        <div className="eyebrow">
          <span
            className="font-mono text-[10px] border px-2 py-0.5"
            style={{ borderColor: "var(--ink-30)", color: "var(--ink)" }}
          >
            04
          </span>
          Pricing
        </div>

        <h2 className="section-head mb-3" style={{ maxWidth: 620 }}>
          Free forever.{" "}
          <span className="italic-accent">Cloud when you need it.</span>
        </h2>

        <p
          className="mb-14"
          style={{
            fontFamily: "var(--font-fraunces), ui-serif",
            fontSize: 20,
            color: "var(--ink-55)",
            maxWidth: 540,
            lineHeight: 1.45,
            fontVariationSettings: '"opsz" 32',
          }}
        >
          The free tier is the product. Pro adds hosted infrastructure — it
          does not remove or degrade anything in Free.
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 300px), 1fr))",
            gap: 24,
          }}
        >
          {plans.map((plan, i) => (
            <motion.div
              key={plan.name}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-40px" }}
              transition={{ duration: 0.4, delay: i * 0.1 }}
              className="ledger-card flex flex-col"
              style={{
                boxShadow: plan.featured ? `5px 5px 0 var(--debit)` : "5px 5px 0 var(--ink)",
                borderColor: plan.featured ? "var(--debit)" : "var(--ink)",
              }}
            >
              {/* Header */}
              <div
                className="px-6 py-5 border-b"
                style={{
                  borderColor: plan.featured ? "var(--debit)" : "var(--ink-10)",
                  background: plan.featured ? "var(--debit)" : "var(--paper)",
                }}
              >
                <div
                  className="font-mono text-[11px] tracking-[0.2em] uppercase mb-3"
                  style={{ color: plan.featured ? "rgba(243,234,219,0.7)" : "var(--ink-55)" }}
                >
                  {plan.name}
                </div>
                <div className="flex items-baseline gap-2">
                  <span
                    className="font-mono tabular-nums"
                    style={{
                      fontSize: 40,
                      fontWeight: 600,
                      lineHeight: 1,
                      color: plan.featured ? "var(--paper)" : "var(--ink)",
                    }}
                  >
                    {plan.price}
                  </span>
                  <span
                    className="font-mono text-[11px]"
                    style={{ color: plan.featured ? "rgba(243,234,219,0.6)" : "var(--ink-30)" }}
                  >
                    {plan.period}
                  </span>
                </div>
              </div>

              {/* Body */}
              <div className="px-6 py-5 flex-1 flex flex-col gap-5" style={{ background: "var(--paper-deep)" }}>
                <p
                  className="font-mono text-[12px] leading-relaxed"
                  style={{ color: "var(--ink-55)" }}
                >
                  {plan.positioning}
                </p>

                <ul className="space-y-2 flex-1">
                  {plan.features.map((f) => (
                    <li
                      key={f}
                      className="flex items-start gap-2 font-mono text-[12px]"
                      style={{ color: "var(--ink-80)" }}
                    >
                      <span style={{ color: "var(--credit)", flexShrink: 0 }}>+</span>
                      {f}
                    </li>
                  ))}
                </ul>

                {plan.ctaHref ? (
                  <a
                    href={plan.ctaHref}
                    target={plan.ctaExternal ? "_blank" : undefined}
                    rel={plan.ctaExternal ? "noopener noreferrer" : undefined}
                    className="btn mt-2"
                    style={{
                      justifyContent: "center",
                      background: plan.featured ? "var(--debit)" : "transparent",
                      borderColor: plan.featured ? "var(--debit)" : "var(--ink)",
                      color: plan.featured ? "var(--paper)" : "var(--ink)",
                    }}
                  >
                    {plan.cta}
                  </a>
                ) : (
                  <button
                    className="btn mt-2"
                    style={{
                      justifyContent: "center",
                      background: plan.featured ? "var(--debit)" : "transparent",
                      borderColor: plan.featured ? "var(--debit)" : "var(--ink)",
                      color: plan.featured ? "var(--paper)" : "var(--ink)",
                      cursor: "pointer",
                      width: "100%",
                    }}
                    onClick={() => {
                      // Provisioned users have an API token via the CLI.
                      // Until a web sign-in flow exists, direct to the README
                      // for CLI provisioning instructions.
                      alert(
                        "Sign in to your ashlr account to subscribe.\n\n" +
                        "See https://github.com/ashlrai/ashlr-plugin#readme for " +
                        "CLI provisioning instructions."
                      );
                    }}
                  >
                    {plan.cta}
                  </button>
                )}
              </div>
            </motion.div>
          ))}
        </div>

        <div className="mt-10 text-center">
          <Link
            href="/pricing"
            className="mono-label hover:text-[var(--ink)] transition-colors duration-200 inline-flex items-center gap-2"
          >
            Full feature comparison &rarr;
          </Link>
        </div>
      </div>
    </section>
  );
}
