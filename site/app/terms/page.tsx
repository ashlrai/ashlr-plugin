import type { Metadata } from "next";
import Footer from "@/components/footer";

export const metadata: Metadata = {
  title: "Terms of Service — ashlr",
  description:
    "Terms governing use of the ashlr hosted backend and Pro/Team subscriptions.",
};

const LAST_UPDATED = "2026-04-17";

export default function TermsPage() {
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
            Terms of Service
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
            {/* 1 Acceptance */}
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
              1. Acceptance
            </h2>
            <p style={{ marginBottom: 24 }}>
              By creating an ashlr account or using the hosted backend at{" "}
              <span className="font-mono text-[13px]">api.ashlr.ai</span>, you agree to
              these Terms of Service (&ldquo;Terms&rdquo;). If you are using ashlr on behalf
              of an organization, you represent that you have authority to bind that
              organization. If you do not agree, do not use the hosted service.
            </p>
            <p style={{ marginBottom: 40 }}>
              The ashlr-plugin itself is MIT-licensed open-source software. These Terms
              govern only the <em>hosted backend</em> and paid subscription tiers, not the
              open-source plugin.
            </p>

            <hr style={{ border: "none", borderTop: "1px solid var(--ink-10)", marginBottom: 40 }} />

            {/* 2 Service */}
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
              2. Service description
            </h2>
            <p style={{ marginBottom: 16 }}>
              ashlr operates a hosted backend that provides cloud sync for usage statistics,
              a savings dashboard, magic-link authentication, and gated access to additional
              MCP tools and skills for subscribers. The ashlr-plugin (the local Claude Code
              plugin) is MIT-licensed and free forever — a subscription is required only to
              use the hosted components.
            </p>

            {/* 3 Account */}
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
              3. Account requirements
            </h2>
            <ul style={{ paddingLeft: 24, marginBottom: 16 }}>
              <li style={{ marginBottom: 10 }}>You must be at least 13 years old.</li>
              <li style={{ marginBottom: 10 }}>You must provide an accurate, working email address and keep it up to date.</li>
              <li style={{ marginBottom: 10 }}>You are responsible for keeping your magic-link tokens and API keys secure. Do not share credentials with others or commit them to public repositories.</li>
              <li style={{ marginBottom: 10 }}>One account per person. Team plans allow multiple seats under a single billing account.</li>
            </ul>

            {/* 4 Acceptable use */}
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
              4. Acceptable use
            </h2>
            <p style={{ marginBottom: 16 }}>You agree not to:</p>
            <ul style={{ paddingLeft: 24, marginBottom: 16 }}>
              <li style={{ marginBottom: 10 }}>
                Reverse-engineer, decompile, or attempt to extract the source code or
                proprietary logic of the hosted backend at{" "}
                <span className="font-mono text-[13px]">api.ashlr.ai</span>.
              </li>
              <li style={{ marginBottom: 10 }}>
                Exceed fair-use limits. Daily rate caps are enforced per account. Automated
                scripts that generate artificial tool call volume in excess of normal
                development workflows are prohibited.
              </li>
              <li style={{ marginBottom: 10 }}>
                Resell, sublicense, or wrap the hosted backend as a service offered to third
                parties without a written reseller agreement.
              </li>
              <li style={{ marginBottom: 10 }}>
                Use the service for any unlawful purpose, to harass others, or to violate
                any applicable law or regulation.
              </li>
              <li style={{ marginBottom: 10 }}>
                Attempt to circumvent authentication, rate limits, or account restrictions.
              </li>
            </ul>
            <p style={{ marginBottom: 16 }}>
              The open-source ashlr-plugin (MIT) has no usage restrictions beyond the MIT
              license terms.
            </p>

            {/* 5 Payment */}
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
              5. Payment and billing
            </h2>
            <p style={{ marginBottom: 16 }}>
              Subscriptions are billed monthly or annually in advance via Stripe. Prices are
              listed on the{" "}
              <a href="/pricing" style={{ color: "var(--debit)" }}>pricing page</a> and may
              change with 30 days&rsquo; notice.
            </p>
            <ul style={{ paddingLeft: 24, marginBottom: 16 }}>
              <li style={{ marginBottom: 10 }}>
                <strong>Auto-renewal:</strong> subscriptions renew automatically at the end
                of each billing period. You can cancel at any time via the billing portal;
                access continues until the end of the paid period.
              </li>
              <li style={{ marginBottom: 10 }}>
                <strong>Refunds:</strong> if you request a refund within 14 days of a charge
                and have not used the hosted backend in that period, we will issue a
                prorated refund. Email{" "}
                <a href="mailto:support@ashlr.ai" style={{ color: "var(--debit)" }}>
                  support@ashlr.ai
                </a>{" "}
                with your request.
              </li>
              <li style={{ marginBottom: 10 }}>
                <strong>Failed payments:</strong> if a payment fails, we will retry three
                times over seven days, then suspend access to hosted features. Your
                open-source plugin continues to work.
              </li>
              <li style={{ marginBottom: 10 }}>
                <strong>Taxes:</strong> prices are exclusive of applicable taxes. You are
                responsible for any sales tax, VAT, or GST owed in your jurisdiction.
              </li>
            </ul>

            {/* 6 IP */}
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
              6. Intellectual property
            </h2>
            <p style={{ marginBottom: 16 }}>
              <strong>ashlr-plugin (open source):</strong> licensed under the MIT License.
              You retain all rights to your code, configs, and any derivative works you
              build on top of the open-source plugin. See the{" "}
              <a
                href="https://github.com/ashlrai/ashlr-plugin/blob/main/LICENSE"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--debit)" }}
              >
                LICENSE file
              </a>
              .
            </p>
            <p style={{ marginBottom: 16 }}>
              <strong>Hosted backend (</strong>
              <span className="font-mono text-[13px]">api.ashlr.ai</span>
              <strong>):</strong> proprietary. All rights reserved. The hosted backend&rsquo;s
              source code, algorithms, and infrastructure configuration are not covered by
              the MIT license and may not be copied, redistributed, or wrapped in a competing
              service.
            </p>

            {/* 7 Warranties */}
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
              7. Warranties and availability
            </h2>
            <p style={{ marginBottom: 16 }}>
              THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; WITHOUT WARRANTY OF ANY KIND,
              EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF
              MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, OR NON-INFRINGEMENT.
            </p>
            <ul style={{ paddingLeft: 24, marginBottom: 16 }}>
              <li style={{ marginBottom: 10 }}>
                <strong>Free and Pro tiers:</strong> no uptime SLA. We aim for high
                availability but do not guarantee it.
              </li>
              <li style={{ marginBottom: 10 }}>
                <strong>Enterprise tier:</strong> 99.5% monthly uptime SLA as specified in
                your enterprise agreement.
              </li>
            </ul>

            {/* 8 Limitation of liability */}
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
              8. Limitation of liability
            </h2>
            <p style={{ marginBottom: 16 }}>
              TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, ASHLR&rsquo;S TOTAL
              LIABILITY TO YOU FOR ANY CLAIM ARISING OUT OF OR RELATING TO THESE TERMS OR
              THE SERVICE SHALL NOT EXCEED THE GREATER OF (A) THE FEES YOU PAID TO ASHLR
              DURING THE 12 MONTHS PRECEDING THE CLAIM, OR (B) USD $100.
            </p>
            <p style={{ marginBottom: 16 }}>
              IN NO EVENT SHALL ASHLR BE LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL,
              CONSEQUENTIAL, OR PUNITIVE DAMAGES, EVEN IF ADVISED OF THE POSSIBILITY OF
              SUCH DAMAGES. SOME JURISDICTIONS DO NOT ALLOW EXCLUSION OF CERTAIN WARRANTIES
              OR LIMITATIONS OF LIABILITY; IN THOSE JURISDICTIONS, LIABILITY IS LIMITED TO
              THE FULLEST EXTENT PERMITTED BY LAW.
            </p>

            {/* 9 Termination */}
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
              9. Termination
            </h2>
            <p style={{ marginBottom: 16 }}>
              Either party may terminate at any time. You may cancel your subscription via
              the billing portal; your access to hosted features ends at the close of the
              current billing period. We may suspend or terminate your account immediately
              if you violate these Terms, with or without notice, and we will provide a
              prorated refund of any unused prepaid period.
            </p>
            <p style={{ marginBottom: 16 }}>
              Termination does not affect your rights under the MIT license to continue
              using the open-source plugin.
            </p>

            {/* 10 Governing law */}
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
              10. Governing law
            </h2>
            <p style={{ marginBottom: 16 }}>
              These Terms are governed by the laws of the State of Delaware, United States,
              without regard to conflict-of-law principles. AshlrAI Inc is a Delaware
              corporation.
            </p>

            {/* 11 Dispute resolution */}
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
              11. Dispute resolution
            </h2>
            <p style={{ marginBottom: 16 }}>
              Any dispute arising out of or relating to these Terms or the service that
              cannot be resolved informally within 30 days of written notice shall be
              resolved by binding arbitration administered by the American Arbitration
              Association (AAA) under its Commercial Arbitration Rules. The arbitration
              shall take place in Delaware or by video conference. The arbitrator&rsquo;s
              award shall be final and binding and may be entered in any court of competent
              jurisdiction.
            </p>
            <p style={{ marginBottom: 16 }}>
              Nothing in this clause prevents either party from seeking emergency injunctive
              or equitable relief in a court of competent jurisdiction to protect
              intellectual property or confidential information.
            </p>

            {/* 12 General */}
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
              12. General provisions
            </h2>
            <ul style={{ paddingLeft: 24, marginBottom: 40 }}>
              <li style={{ marginBottom: 10 }}>
                <strong>Entire agreement:</strong> these Terms, together with the Privacy
                Policy and any applicable DPA or enterprise agreement, constitute the entire
                agreement between you and ashlr regarding the hosted service.
              </li>
              <li style={{ marginBottom: 10 }}>
                <strong>Severability:</strong> if any provision is found unenforceable, the
                remaining provisions continue in full force.
              </li>
              <li style={{ marginBottom: 10 }}>
                <strong>No waiver:</strong> failure to enforce any provision is not a waiver
                of the right to enforce it later.
              </li>
              <li style={{ marginBottom: 10 }}>
                <strong>Assignment:</strong> you may not assign your rights or obligations
                under these Terms without our written consent. We may assign ours in
                connection with a merger, acquisition, or sale of assets.
              </li>
              <li style={{ marginBottom: 10 }}>
                <strong>Changes:</strong> we will notify you at least 30 days before
                material changes to these Terms via email. Continued use after the effective
                date constitutes acceptance.
              </li>
            </ul>
          </div>
        </div>
      </main>

      <Footer />
    </>
  );
}
