import type { Metadata } from "next";
import Footer from "@/components/footer";

export const metadata: Metadata = {
  title: "Data Processing Addendum — ashlr",
  description:
    "GDPR and CCPA compliance statement, sub-processor list, and security measures for ashlr team and enterprise customers.",
};

const LAST_UPDATED = "2026-04-17";

export default function DpaPage() {
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
            Data Processing Addendum
          </h1>
          <p
            className="font-mono text-[12px]"
            style={{ color: "var(--ink-30)", marginBottom: 16 }}
          >
            Last updated: {LAST_UPDATED}
          </p>
          <p
            style={{
              color: "var(--ink-55)",
              fontSize: 14,
              lineHeight: 1.6,
              marginBottom: 48,
              fontFamily: "var(--font-ibm-plex), ui-sans-serif, system-ui",
            }}
          >
            This DPA stub applies to Team and Enterprise customers who process personal
            data through ashlr on behalf of EU or California residents. A countersigned DPA
            is available on request — email{" "}
            <a href="mailto:support@ashlr.ai" style={{ color: "var(--debit)" }}>
              support@ashlr.ai
            </a>
            .
          </p>

          <div
            style={{
              color: "var(--ink-80)",
              lineHeight: 1.75,
              fontSize: 15,
              fontFamily: "var(--font-ibm-plex), ui-sans-serif, system-ui",
            }}
          >
            {/* 1 Compliance */}
            <h2
              style={{
                fontFamily: "var(--font-fraunces), ui-serif",
                fontSize: 22,
                fontWeight: 400,
                letterSpacing: "-0.01em",
                color: "var(--ink)",
                marginBottom: 16,
                marginTop: 0,
              }}
            >
              1. GDPR and CCPA compliance
            </h2>
            <p style={{ marginBottom: 16 }}>
              ashlr acts as a <strong>data processor</strong> when processing personal data
              on behalf of customers (&ldquo;controllers&rdquo;) under the EU General Data
              Protection Regulation (GDPR) and the California Consumer Privacy Act (CCPA).
              We process personal data only as instructed by the controller and as described
              in our Privacy Policy.
            </p>
            <p style={{ marginBottom: 40 }}>
              For CCPA purposes, ashlr does not sell personal information and does not use
              it for any purpose beyond providing the contracted service.
            </p>

            <hr style={{ border: "none", borderTop: "1px solid var(--ink-10)", marginBottom: 40 }} />

            {/* 2 Sub-processors */}
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
              2. Sub-processors
            </h2>
            <p style={{ marginBottom: 20 }}>
              We engage the following sub-processors. We will notify customers at least 30
              days before adding a material new sub-processor.
            </p>
            <div className="ledger-card" style={{ padding: "24px 28px", marginBottom: 24 }}>
              <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--ink-10)" }}>
                    <th style={{ textAlign: "left", paddingBottom: 10, fontWeight: 600, color: "var(--ink)" }}>Name</th>
                    <th style={{ textAlign: "left", paddingBottom: 10, fontWeight: 600, color: "var(--ink)" }}>Purpose</th>
                    <th style={{ textAlign: "left", paddingBottom: 10, fontWeight: 600, color: "var(--ink)" }}>Location</th>
                  </tr>
                </thead>
                <tbody>
                  <tr style={{ borderBottom: "1px solid var(--ink-10)" }}>
                    <td style={{ paddingTop: 12, paddingBottom: 12, color: "var(--ink-80)", verticalAlign: "top" }}>
                      <a href="https://stripe.com/privacy" target="_blank" rel="noopener noreferrer" style={{ color: "var(--debit)" }}>Stripe, Inc.</a>
                    </td>
                    <td style={{ paddingTop: 12, paddingBottom: 12, color: "var(--ink-55)", verticalAlign: "top" }}>Payment processing, subscription billing</td>
                    <td style={{ paddingTop: 12, paddingBottom: 12, color: "var(--ink-55)", verticalAlign: "top" }}>US / global</td>
                  </tr>
                  <tr style={{ borderBottom: "1px solid var(--ink-10)" }}>
                    <td style={{ paddingTop: 12, paddingBottom: 12, color: "var(--ink-80)", verticalAlign: "top" }}>
                      <a href="https://resend.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer" style={{ color: "var(--debit)" }}>Resend, Inc.</a>
                    </td>
                    <td style={{ paddingTop: 12, paddingBottom: 12, color: "var(--ink-55)", verticalAlign: "top" }}>Transactional email delivery</td>
                    <td style={{ paddingTop: 12, paddingBottom: 12, color: "var(--ink-55)", verticalAlign: "top" }}>US</td>
                  </tr>
                  <tr style={{ borderBottom: "1px solid var(--ink-10)" }}>
                    <td style={{ paddingTop: 12, paddingBottom: 12, color: "var(--ink-80)", verticalAlign: "top" }}>
                      <a href="https://fly.io/legal/privacy-policy" target="_blank" rel="noopener noreferrer" style={{ color: "var(--debit)" }}>Fly.io, Inc.</a>
                    </td>
                    <td style={{ paddingTop: 12, paddingBottom: 12, color: "var(--ink-55)", verticalAlign: "top" }}>API backend hosting, compute</td>
                    <td style={{ paddingTop: 12, paddingBottom: 12, color: "var(--ink-55)", verticalAlign: "top" }}>US-East (iad); EU on request</td>
                  </tr>
                  <tr style={{ borderBottom: "1px solid var(--ink-10)" }}>
                    <td style={{ paddingTop: 12, paddingBottom: 12, color: "var(--ink-80)", verticalAlign: "top" }}>
                      <a href="https://neon.tech/privacy-policy" target="_blank" rel="noopener noreferrer" style={{ color: "var(--debit)" }}>Neon, Inc.</a>
                    </td>
                    <td style={{ paddingTop: 12, paddingBottom: 12, color: "var(--ink-55)", verticalAlign: "top" }}>Postgres database (accounts, stats, audit logs)</td>
                    <td style={{ paddingTop: 12, paddingBottom: 12, color: "var(--ink-55)", verticalAlign: "top" }}>US-East; EU on request</td>
                  </tr>
                  <tr>
                    <td style={{ paddingTop: 12, color: "var(--ink-80)", verticalAlign: "top" }}>
                      <a href="https://vercel.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer" style={{ color: "var(--debit)" }}>Vercel, Inc.</a>
                    </td>
                    <td style={{ paddingTop: 12, color: "var(--ink-55)", verticalAlign: "top" }}>Marketing site hosting</td>
                    <td style={{ paddingTop: 12, color: "var(--ink-55)", verticalAlign: "top" }}>US / global CDN</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* 3 International transfers */}
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
              3. International data transfers
            </h2>
            <p style={{ marginBottom: 16 }}>
              Personal data originating in the European Economic Area (EEA) or UK is
              transferred to the United States under the Standard Contractual Clauses (SCCs)
              adopted by the European Commission under GDPR Article 46(2)(c). We apply the
              2021 SCCs (Module 2: controller-to-processor) in our agreements with each
              sub-processor listed above.
            </p>
            <p style={{ marginBottom: 40 }}>
              Enterprise customers requiring in-region EEA processing can request EU-region
              deployment — contact{" "}
              <a href="mailto:support@ashlr.ai" style={{ color: "var(--debit)" }}>
                support@ashlr.ai
              </a>
              .
            </p>

            {/* 4 Security */}
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
              4. Security measures
            </h2>
            <ul style={{ paddingLeft: 24, marginBottom: 16 }}>
              <li style={{ marginBottom: 10 }}>
                <strong>Encryption in transit:</strong> all API traffic is TLS 1.2 or higher.
              </li>
              <li style={{ marginBottom: 10 }}>
                <strong>Encryption at rest:</strong> database volumes are AES-256 encrypted
                at the infrastructure level (Neon + Fly.io).
              </li>
              <li style={{ marginBottom: 10 }}>
                <strong>Access control:</strong> production database access is limited to the
                API service account and named engineers. All human access requires MFA and is
                logged.
              </li>
              <li style={{ marginBottom: 10 }}>
                <strong>Audit logs:</strong> all API authentication events and gated tool
                calls are logged with timestamps and retained for 7 years.
              </li>
              <li style={{ marginBottom: 10 }}>
                <strong>Vulnerability management:</strong> dependencies are scanned
                continuously via GitHub Dependabot. Critical patches are applied within 72
                hours.
              </li>
            </ul>

            {/* 5 Breach notification */}
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
              5. Breach notification
            </h2>
            <p style={{ marginBottom: 16 }}>
              In the event of a personal data breach, ashlr will notify affected customers
              without undue delay and in any event within <strong>72 hours</strong> of
              becoming aware of the breach, to the extent required by GDPR Article 33. The
              notification will include, to the extent known at the time: the nature of the
              breach, the categories and approximate number of data subjects affected, likely
              consequences, and measures taken or proposed.
            </p>

            {/* 6 DPO / Contact */}
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
              6. Contact and DPO requests
            </h2>
            <p style={{ marginBottom: 40 }}>
              ashlr does not currently meet the threshold requiring a formal DPO appointment
              under GDPR Article 37. Data protection inquiries, requests for a countersigned
              DPA, and data subject rights requests should be sent to:{" "}
              <a href="mailto:support@ashlr.ai" style={{ color: "var(--debit)" }}>
                support@ashlr.ai
              </a>
              . We aim to respond within 5 business days.
            </p>
          </div>
        </div>
      </main>

      <Footer />
    </>
  );
}
