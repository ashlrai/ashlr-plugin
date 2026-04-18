import type { Metadata } from "next";
import Footer from "@/components/footer";

export const metadata: Metadata = {
  title: "Privacy Policy — ashlr",
  description:
    "How ashlr collects, uses, and protects your data. Free tier: zero telemetry. Pro tier: minimal billing data only.",
};

const LAST_UPDATED = "2026-04-17";

export default function PrivacyPage() {
  return (
    <>
      <main
        style={{
          background: "var(--paper)",
          minHeight: "100vh",
          paddingTop: "clamp(48px, 8vw, 96px)",
          paddingBottom: "clamp(48px, 8vw, 96px)",
        }}
      >
        <div className="wrap" style={{ maxWidth: 760 }}>
          {/* Header */}
          <div className="mono-label mb-4">Legal</div>
          <h1
            style={{
              fontFamily: "var(--font-fraunces), ui-serif",
              fontSize: "clamp(28px, 5vw, 44px)",
              fontWeight: 300,
              letterSpacing: "-0.02em",
              fontVariationSettings: '"SOFT" 20, "opsz" 40',
              color: "var(--ink)",
              lineHeight: 1.15,
              marginBottom: 12,
            }}
          >
            Privacy Policy
          </h1>
          <p
            className="font-mono text-[12px]"
            style={{ color: "var(--ink-30)", marginBottom: 48 }}
          >
            Last updated: {LAST_UPDATED}
          </p>

          <div
            style={{
              color: "var(--ink-80)",
              lineHeight: 1.75,
              fontSize: 15,
              fontFamily: "var(--font-ibm-plex), ui-sans-serif, system-ui",
            }}
          >
            {/* Intro */}
            <p style={{ marginBottom: 24 }}>
              This policy describes how AshlrAI Inc (&ldquo;ashlr&rdquo;, &ldquo;we&rdquo;,
              &ldquo;us&rdquo;) handles information when you use the ashlr-plugin and the
              hosted services at{" "}
              <span className="font-mono text-[13px]">api.ashlr.ai</span> and{" "}
              <span className="font-mono text-[13px]">plugin.ashlr.ai</span>.
            </p>
            <p style={{ marginBottom: 40 }}>
              <strong>Controller:</strong> AshlrAI Inc, a Delaware corporation. Questions
              to{" "}
              <a href="mailto:support@ashlr.ai" style={{ color: "var(--debit)" }}>support@ashlr.ai</a>.
            </p>

            <hr style={{ border: "none", borderTop: "1px solid var(--ink-10)", marginBottom: 40 }} />

            {/* 1 */}
            <h2
              style={{
                fontFamily: "var(--font-fraunces), ui-serif",
                fontSize: 22,
                fontWeight: 400,
                letterSpacing: "-0.01em",
                color: "var(--ink)",
                marginBottom: 16,
                marginTop: 48,
              }}
            >
              1. What the free tier collects
            </h2>
            <p style={{ marginBottom: 16 }}>
              <strong>Nothing that leaves your machine.</strong> The free tier of ashlr-plugin
              runs entirely locally. Usage statistics (tool call counts, token totals, session
              durations) are written to{" "}
              <span className="font-mono text-[13px]">~/.ashlr/stats.json</span> on your own
              filesystem. That file never leaves your computer unless you explicitly copy it
              somewhere.
            </p>
            <p style={{ marginBottom: 16 }}>
              We do not run analytics, we do not phone home, and we do not collect crash
              reports on the free tier. The plugin ships with zero telemetry hooks.
            </p>

            {/* 2 */}
            <h2
              style={{
                fontFamily: "var(--font-fraunces), ui-serif",
                fontSize: 22,
                fontWeight: 400,
                letterSpacing: "-0.01em",
                color: "var(--ink)",
                marginBottom: 16,
                marginTop: 48,
              }}
            >
              2. What the Pro tier collects
            </h2>
            <p style={{ marginBottom: 16 }}>
              When you subscribe to ashlr Pro or Team, you create an account. We collect the
              minimum data necessary to operate the service:
            </p>
            <ul style={{ paddingLeft: 24, marginBottom: 16 }}>
              <li style={{ marginBottom: 10 }}>
                <strong>Email address</strong> — used for billing, magic-link sign-in, and
                transactional notifications (receipts, renewal reminders, material policy
                changes).
              </li>
              <li style={{ marginBottom: 10 }}>
                <strong>Aggregated usage statistics</strong> — tool call counts and total
                token figures per session, uploaded so your dashboard and savings ledger work
                across machines. These are numeric counters only. No file contents, no file
                paths, no working directory, no code, no chat transcripts.
              </li>
              <li style={{ marginBottom: 10 }}>
                <strong>Stripe payment metadata</strong> — subscription status, plan tier,
                billing interval, last-four digits of card, country. Stripe stores full card
                data; we never see or store raw card numbers.
              </li>
              <li style={{ marginBottom: 10 }}>
                <strong>Audit log of gated tool calls</strong> — timestamp, tool name, and
                whether the call was allowed or rate-limited. Stored for compliance. No
                arguments or outputs are logged.
              </li>
            </ul>

            {/* 3 */}
            <h2
              style={{
                fontFamily: "var(--font-fraunces), ui-serif",
                fontSize: 22,
                fontWeight: 400,
                letterSpacing: "-0.01em",
                color: "var(--ink)",
                marginBottom: 16,
                marginTop: 48,
              }}
            >
              3. What we will never collect
            </h2>
            <p style={{ marginBottom: 12 }}>
              Regardless of plan, we will never collect:
            </p>
            <ul style={{ paddingLeft: 24, marginBottom: 16 }}>
              <li style={{ marginBottom: 8 }}>File contents or code</li>
              <li style={{ marginBottom: 8 }}>File paths or working directory</li>
              <li style={{ marginBottom: 8 }}>Git history or diffs</li>
              <li style={{ marginBottom: 8 }}>Environment variables or shell state</li>
              <li style={{ marginBottom: 8 }}>Chat transcripts or LLM prompts/responses</li>
              <li style={{ marginBottom: 8 }}>IP addresses (beyond what Fly.io logs at the TLS layer and discards)</li>
              <li style={{ marginBottom: 8 }}>Any biometric, health, or financial data beyond what Stripe provides for billing</li>
            </ul>

            {/* 4 */}
            <h2
              style={{
                fontFamily: "var(--font-fraunces), ui-serif",
                fontSize: 22,
                fontWeight: 400,
                letterSpacing: "-0.01em",
                color: "var(--ink)",
                marginBottom: 16,
                marginTop: 48,
              }}
            >
              4. Third-party processors
            </h2>
            <p style={{ marginBottom: 16 }}>
              We share limited data with the following sub-processors, each under a Data
              Processing Agreement (DPA):
            </p>
            <div
              className="ledger-card"
              style={{ padding: "24px 28px", marginBottom: 24 }}
            >
              <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--ink-10)" }}>
                    <th style={{ textAlign: "left", paddingBottom: 10, fontWeight: 600, color: "var(--ink)" }}>Processor</th>
                    <th style={{ textAlign: "left", paddingBottom: 10, fontWeight: 600, color: "var(--ink)" }}>Purpose</th>
                    <th style={{ textAlign: "left", paddingBottom: 10, fontWeight: 600, color: "var(--ink)" }}>Data shared</th>
                  </tr>
                </thead>
                <tbody style={{ fontFamily: "var(--font-ibm-plex), ui-sans-serif" }}>
                  <tr style={{ borderBottom: "1px solid var(--ink-10)" }}>
                    <td style={{ paddingTop: 12, paddingBottom: 12, color: "var(--ink-80)", verticalAlign: "top" }}>
                      <a href="https://stripe.com/privacy" target="_blank" rel="noopener noreferrer" style={{ color: "var(--debit)" }}>Stripe</a>
                    </td>
                    <td style={{ paddingTop: 12, paddingBottom: 12, color: "var(--ink-55)", verticalAlign: "top" }}>Payment processing, subscription management</td>
                    <td style={{ paddingTop: 12, paddingBottom: 12, color: "var(--ink-55)", verticalAlign: "top" }}>Email, billing address, payment method</td>
                  </tr>
                  <tr style={{ borderBottom: "1px solid var(--ink-10)" }}>
                    <td style={{ paddingTop: 12, paddingBottom: 12, color: "var(--ink-80)", verticalAlign: "top" }}>
                      <a href="https://resend.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer" style={{ color: "var(--debit)" }}>Resend</a>
                    </td>
                    <td style={{ paddingTop: 12, paddingBottom: 12, color: "var(--ink-55)", verticalAlign: "top" }}>Transactional email delivery</td>
                    <td style={{ paddingTop: 12, paddingBottom: 12, color: "var(--ink-55)", verticalAlign: "top" }}>Email address, email content</td>
                  </tr>
                  <tr style={{ borderBottom: "1px solid var(--ink-10)" }}>
                    <td style={{ paddingTop: 12, paddingBottom: 12, color: "var(--ink-80)", verticalAlign: "top" }}>
                      <a href="https://fly.io/legal/privacy-policy" target="_blank" rel="noopener noreferrer" style={{ color: "var(--debit)" }}>Fly.io</a>
                    </td>
                    <td style={{ paddingTop: 12, paddingBottom: 12, color: "var(--ink-55)", verticalAlign: "top" }}>API backend hosting</td>
                    <td style={{ paddingTop: 12, paddingBottom: 12, color: "var(--ink-55)", verticalAlign: "top" }}>All API request data in transit</td>
                  </tr>
                  <tr style={{ borderBottom: "1px solid var(--ink-10)" }}>
                    <td style={{ paddingTop: 12, paddingBottom: 12, color: "var(--ink-80)", verticalAlign: "top" }}>
                      <a href="https://neon.tech/privacy-policy" target="_blank" rel="noopener noreferrer" style={{ color: "var(--debit)" }}>Neon</a>
                    </td>
                    <td style={{ paddingTop: 12, paddingBottom: 12, color: "var(--ink-55)", verticalAlign: "top" }}>Postgres database (accounts, stats, audit logs)</td>
                    <td style={{ paddingTop: 12, paddingBottom: 12, color: "var(--ink-55)", verticalAlign: "top" }}>All stored account data</td>
                  </tr>
                  <tr>
                    <td style={{ paddingTop: 12, color: "var(--ink-80)", verticalAlign: "top" }}>
                      <a href="https://vercel.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer" style={{ color: "var(--debit)" }}>Vercel</a>
                    </td>
                    <td style={{ paddingTop: 12, color: "var(--ink-55)", verticalAlign: "top" }}>Marketing site hosting</td>
                    <td style={{ paddingTop: 12, color: "var(--ink-55)", verticalAlign: "top" }}>Page request metadata (no user data stored)</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p style={{ marginBottom: 16 }}>
              We do not sell your data to any third party. We do not use advertising networks.
            </p>

            {/* 5 */}
            <h2
              style={{
                fontFamily: "var(--font-fraunces), ui-serif",
                fontSize: 22,
                fontWeight: 400,
                letterSpacing: "-0.01em",
                color: "var(--ink)",
                marginBottom: 16,
                marginTop: 48,
              }}
            >
              5. Cookies
            </h2>
            <p style={{ marginBottom: 16 }}>
              The ashlr marketing site does not set any cookies of its own. Stripe sets
              cookies on the checkout and billing portal pages only; those cookies are
              necessary for payment processing and fraud prevention. We display a notice on
              those pages before any Stripe script executes. We do not use advertising
              cookies, tracking pixels, or analytics cookies.
            </p>

            {/* 6 */}
            <h2
              style={{
                fontFamily: "var(--font-fraunces), ui-serif",
                fontSize: 22,
                fontWeight: 400,
                letterSpacing: "-0.01em",
                color: "var(--ink)",
                marginBottom: 16,
                marginTop: 48,
              }}
            >
              6. Data retention
            </h2>
            <ul style={{ paddingLeft: 24, marginBottom: 16 }}>
              <li style={{ marginBottom: 10 }}>
                <strong>Aggregated stats uploads:</strong> retained for 365 days, then
                permanently deleted.
              </li>
              <li style={{ marginBottom: 10 }}>
                <strong>Audit logs (gated tool calls):</strong> retained for 7 years in line
                with SOC 2 standards, then permanently deleted.
              </li>
              <li style={{ marginBottom: 10 }}>
                <strong>Account data (email, subscription status):</strong> retained until
                you request deletion or 90 days after subscription lapse, whichever comes
                first.
              </li>
              <li style={{ marginBottom: 10 }}>
                <strong>Stripe records:</strong> subject to Stripe&rsquo;s own retention
                policy; typically 7 years for financial records.
              </li>
            </ul>

            {/* 7 */}
            <h2
              style={{
                fontFamily: "var(--font-fraunces), ui-serif",
                fontSize: 22,
                fontWeight: 400,
                letterSpacing: "-0.01em",
                color: "var(--ink)",
                marginBottom: 16,
                marginTop: 48,
              }}
            >
              7. Your rights
            </h2>
            <p style={{ marginBottom: 16 }}>
              You may exercise the following rights at any time by emailing{" "}
              <a href="mailto:support@ashlr.ai" style={{ color: "var(--debit)" }}>support@ashlr.ai</a>:
            </p>
            <ul style={{ paddingLeft: 24, marginBottom: 16 }}>
              <li style={{ marginBottom: 8 }}><strong>Access:</strong> request a copy of the data we hold about you.</li>
              <li style={{ marginBottom: 8 }}><strong>Correction:</strong> ask us to fix inaccurate data.</li>
              <li style={{ marginBottom: 8 }}><strong>Deletion:</strong> request erasure of your account and associated data. We will fulfill within 30 days, subject to legal retention obligations (audit logs).</li>
              <li style={{ marginBottom: 8 }}><strong>Portability:</strong> receive your data in a machine-readable format (JSON).</li>
              <li style={{ marginBottom: 8 }}><strong>Objection / restriction:</strong> object to processing or ask us to restrict use while a dispute is resolved.</li>
            </ul>
            <p style={{ marginBottom: 16 }}>
              We will respond to rights requests within 30 days. We do not charge a fee for
              reasonable requests.
            </p>

            {/* 8 */}
            <h2
              style={{
                fontFamily: "var(--font-fraunces), ui-serif",
                fontSize: 22,
                fontWeight: 400,
                letterSpacing: "-0.01em",
                color: "var(--ink)",
                marginBottom: 16,
                marginTop: 48,
              }}
            >
              8. Data residency
            </h2>
            <p style={{ marginBottom: 16 }}>
              Data is stored primarily in <strong>US-East (iad)</strong> on Fly.io and Neon
              infrastructure. If you are an EU-based user or organization and require
              in-region data storage, contact{" "}
              <a href="mailto:support@ashlr.ai" style={{ color: "var(--debit)" }}>support@ashlr.ai</a>{" "}
              — we will stand up an EU region on demand. International transfers from the EU
              are governed by Standard Contractual Clauses (SCCs) under GDPR Article 46(2)(c).
            </p>

            {/* 9 */}
            <h2
              style={{
                fontFamily: "var(--font-fraunces), ui-serif",
                fontSize: 22,
                fontWeight: 400,
                letterSpacing: "-0.01em",
                color: "var(--ink)",
                marginBottom: 16,
                marginTop: 48,
              }}
            >
              9. Children
            </h2>
            <p style={{ marginBottom: 16 }}>
              ashlr is not directed at children under 13. We do not knowingly collect
              personal data from anyone under 13. If you believe a child has provided us
              personal data, contact{" "}
              <a href="mailto:support@ashlr.ai" style={{ color: "var(--debit)" }}>support@ashlr.ai</a>{" "}
              and we will delete it promptly.
            </p>

            {/* 10 */}
            <h2
              style={{
                fontFamily: "var(--font-fraunces), ui-serif",
                fontSize: 22,
                fontWeight: 400,
                letterSpacing: "-0.01em",
                color: "var(--ink)",
                marginBottom: 16,
                marginTop: 48,
              }}
            >
              10. Changes to this policy
            </h2>
            <p style={{ marginBottom: 16 }}>
              We will notify you by email at least <strong>30 days before</strong> any
              material change to this policy takes effect. Non-material changes (typos,
              clarifications, updated sub-processor links) may be made without notice, and
              the &ldquo;Last updated&rdquo; date at the top of this page will reflect them.
              Continued use of ashlr Pro after a material change becomes effective constitutes
              acceptance of the updated policy.
            </p>

            {/* 11 */}
            <h2
              style={{
                fontFamily: "var(--font-fraunces), ui-serif",
                fontSize: 22,
                fontWeight: 400,
                letterSpacing: "-0.01em",
                color: "var(--ink)",
                marginBottom: 16,
                marginTop: 48,
              }}
            >
              11. Contact
            </h2>
            <p style={{ marginBottom: 40 }}>
              Privacy inquiries:{" "}
              <a href="mailto:support@ashlr.ai" style={{ color: "var(--debit)" }}>support@ashlr.ai</a>
              <br />
              General inquiries:{" "}
              <a href="mailto:support@ashlr.ai" style={{ color: "var(--debit)" }}>support@ashlr.ai</a>
            </p>
          </div>
        </div>
      </main>

      <Footer />
    </>
  );
}
