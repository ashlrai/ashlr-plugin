/**
 * weekly-digest.tsx — Pro weekly digest email.
 *
 * Rendered by the cron job (server/src/jobs/weekly-digest-cron.ts) and sent
 * via SendGrid to Pro/Team users who have opted in.
 *
 * Export contract:
 *   default  WeeklyDigestEmail  — React Email component
 *   subject  string             — computed from weekOf date
 *   plainText(data) => string  — plain-text fallback
 *
 * Privacy: the recipient email address is NEVER included in the body.
 * Only the "handle" (part before @) is used if a display name is unavailable.
 */

import {
  Hr,
  Link,
  Section,
  Text,
} from "@react-email/components";
import * as React from "react";
import {
  colors,
  fonts,
  EmailShell,
  EmailContainer,
  EmailHeader,
  EmailBody,
  EmailFooter,
} from "./shared.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TopTool {
  name: string;
  calls: number;
}

export interface WeeklyDigestEmailProps {
  /** ISO week start date, "YYYY-MM-DD". Used in subject + header. */
  weekOf: string;
  /** Handle (name or email local-part). Never include full email. */
  handle: string;
  /** Tokens saved this ISO week. */
  weekTokensSaved: number;
  /** Estimated dollar savings this ISO week (tokens × rate). */
  weekDollarsSaved: number;
  /** Top tools all-time, already sorted descending by calls, up to 5. */
  topTools: TopTool[];
  /** Number of genome sections added this week. */
  genomeSectionsAdded: number;
  /** Current streak in days. 0 = no streak. */
  streakDays: number;
  /** Unsubscribe token (HMAC-signed userId). Embedded in footer link. */
  unsubscribeToken: string;
  /** Dashboard base URL, e.g. "https://plugin.ashlr.ai" */
  siteUrl?: string;
}

// ---------------------------------------------------------------------------
// Subject helper (exported separately so email.ts can reference it)
// ---------------------------------------------------------------------------

export function buildSubject(weekOf: string): string {
  return `Your ashlr week \xb7 ${weekOf}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SITE_DEFAULT = "https://plugin.ashlr.ai";

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function fmtDollars(n: number): string {
  return `$${n.toFixed(2)}`;
}

// Bar proportional to max value, rendered as background-color block.
function BarCell({ value, max }: { value: number; max: number }): React.JSX.Element {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <td style={{ width: "120px", paddingLeft: "8px", verticalAlign: "middle" }}>
      <div
        style={{
          width: `${pct}%`,
          minWidth: "4px",
          height: "8px",
          backgroundColor: colors.accent,
          borderRadius: "2px",
        }}
      />
    </td>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function WeeklyDigestEmail(props: WeeklyDigestEmailProps): React.JSX.Element {
  const {
    weekOf,
    handle,
    weekTokensSaved,
    weekDollarsSaved,
    topTools,
    genomeSectionsAdded,
    streakDays,
    unsubscribeToken,
    siteUrl = SITE_DEFAULT,
  } = props;

  const subject = buildSubject(weekOf);
  const dashUrl = `${siteUrl}/dashboard`;
  const unsubUrl = `${siteUrl}/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`;
  const maxCalls = topTools[0]?.calls ?? 1;

  return (
    <EmailShell previewText={`${fmtTokens(weekTokensSaved)} tokens saved this week · ${fmtDollars(weekDollarsSaved)} back in your pocket`}>
      <EmailContainer>
        <EmailHeader />

        <EmailBody>
          {/* ── Heading ── */}
          <Text
            role="heading"
            aria-level={1}
            style={{
              fontFamily: fonts.heading,
              fontStyle: "italic",
              fontWeight: 300,
              fontSize: "26px",
              color: colors.ink,
              margin: "0 0 4px",
              lineHeight: "1.2",
            }}
          >
            {subject}
          </Text>

          <Text
            style={{
              fontFamily: fonts.body,
              fontSize: "14px",
              color: colors.muted,
              margin: "0 0 28px",
            }}
          >
            Hi {handle} — here’s how your week looked.
          </Text>

          {/* ── Savings tile ── */}
          <Section
            style={{
              backgroundColor: "#1a0f0c",
              borderRadius: "6px",
              padding: "20px 24px",
              marginBottom: "24px",
            }}
          >
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <tbody>
                <tr>
                  <td style={{ verticalAlign: "top" }}>
                    <Text
                      style={{
                        fontFamily: fonts.heading,
                        fontStyle: "italic",
                        fontWeight: 300,
                        fontSize: "36px",
                        color: "#F3EADB",
                        margin: "0",
                        lineHeight: "1",
                      }}
                    >
                      {fmtTokens(weekTokensSaved)}
                    </Text>
                    <Text
                      style={{
                        fontFamily: fonts.body,
                        fontSize: "12px",
                        color: "#a09080",
                        margin: "4px 0 0",
                        letterSpacing: "0.04em",
                        textTransform: "uppercase",
                      }}
                    >
                      tokens saved this week
                    </Text>
                  </td>
                  <td style={{ verticalAlign: "top", textAlign: "right" }}>
                    <Text
                      style={{
                        fontFamily: fonts.heading,
                        fontStyle: "italic",
                        fontWeight: 300,
                        fontSize: "36px",
                        color: "#c2410c",
                        margin: "0",
                        lineHeight: "1",
                      }}
                    >
                      {fmtDollars(weekDollarsSaved)}
                    </Text>
                    <Text
                      style={{
                        fontFamily: fonts.body,
                        fontSize: "12px",
                        color: "#a09080",
                        margin: "4px 0 0",
                        letterSpacing: "0.04em",
                        textTransform: "uppercase",
                        textAlign: "right",
                      }}
                    >
                      estimated savings
                    </Text>
                  </td>
                </tr>
              </tbody>
            </table>
          </Section>

          {/* ── Top tools ── */}
          {topTools.length > 0 && (
            <>
              <Text
                role="heading"
                aria-level={2}
                style={{
                  fontFamily: fonts.heading,
                  fontStyle: "italic",
                  fontWeight: 300,
                  fontSize: "18px",
                  color: colors.ink,
                  margin: "0 0 12px",
                }}
              >
                Top tools (all time)
              </Text>

              <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "24px" }}>
                <tbody>
                  {topTools.slice(0, 5).map((tool) => (
                    <tr key={tool.name}>
                      <td
                        style={{
                          fontFamily: fonts.body,
                          fontSize: "13px",
                          color: colors.ink,
                          paddingBottom: "8px",
                          whiteSpace: "nowrap",
                          width: "180px",
                        }}
                      >
                        {tool.name}
                      </td>
                      <BarCell value={tool.calls} max={maxCalls} />
                      <td
                        style={{
                          fontFamily: fonts.body,
                          fontSize: "12px",
                          color: colors.muted,
                          paddingBottom: "8px",
                          paddingLeft: "8px",
                          textAlign: "right",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {tool.calls.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <Hr style={{ borderColor: colors.border, margin: "0 0 20px" }} />
            </>
          )}

          {/* ── Genome + streak ── */}
          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "28px" }}>
            <tbody>
              <tr>
                <td style={{ width: "50%", verticalAlign: "top", paddingRight: "12px" }}>
                  <Text
                    style={{
                      fontFamily: fonts.body,
                      fontSize: "11px",
                      color: colors.muted,
                      margin: "0 0 2px",
                      letterSpacing: "0.05em",
                      textTransform: "uppercase",
                    }}
                  >
                    Genome sections added
                  </Text>
                  <Text
                    style={{
                      fontFamily: fonts.heading,
                      fontStyle: "italic",
                      fontWeight: 300,
                      fontSize: "28px",
                      color: colors.ink,
                      margin: "0",
                      lineHeight: "1.1",
                    }}
                  >
                    {genomeSectionsAdded}
                  </Text>
                  <Text
                    style={{
                      fontFamily: fonts.body,
                      fontSize: "11px",
                      color: colors.muted,
                      margin: "2px 0 0",
                    }}
                  >
                    this week
                  </Text>
                </td>
                <td style={{ width: "50%", verticalAlign: "top" }}>
                  <Text
                    style={{
                      fontFamily: fonts.body,
                      fontSize: "11px",
                      color: colors.muted,
                      margin: "0 0 2px",
                      letterSpacing: "0.05em",
                      textTransform: "uppercase",
                    }}
                  >
                    Current streak
                  </Text>
                  <Text
                    style={{
                      fontFamily: fonts.heading,
                      fontStyle: "italic",
                      fontWeight: 300,
                      fontSize: "28px",
                      color: streakDays > 0 ? colors.accent : colors.muted,
                      margin: "0",
                      lineHeight: "1.1",
                    }}
                  >
                    {streakDays > 0 ? `${streakDays}d` : "—"}
                  </Text>
                  <Text
                    style={{
                      fontFamily: fonts.body,
                      fontSize: "11px",
                      color: colors.muted,
                      margin: "2px 0 0",
                    }}
                  >
                    {streakDays > 0 ? "keep it going" : "start one today"}
                  </Text>
                </td>
              </tr>
            </tbody>
          </table>

          {/* ── CTA ── */}
          <Section style={{ textAlign: "center", marginBottom: "4px" }}>
            <Link
              href={dashUrl}
              style={{
                display: "inline-block",
                backgroundColor: colors.accent,
                color: colors.white,
                fontFamily: fonts.body,
                fontSize: "14px",
                fontWeight: 600,
                textDecoration: "none",
                padding: "12px 28px",
                borderRadius: "5px",
                letterSpacing: "0.01em",
              }}
            >
              Open dashboard
            </Link>
          </Section>
        </EmailBody>

        {/* ── Footer (custom — adds unsubscribe) ── */}
        <Hr style={{ borderColor: colors.border, margin: "0" }} />
        <Section style={{ padding: "20px 32px", backgroundColor: colors.paper }}>
          <Text
            style={{
              fontFamily: fonts.body,
              fontSize: "11px",
              color: colors.muted,
              margin: "0",
              lineHeight: "1.8",
            }}
          >
            ashlr &middot; MIT-licensed plugin + proprietary hosted backend.{" "}
            <Link
              href={`${siteUrl}/dashboard/settings`}
              style={{ color: colors.muted, textDecoration: "underline" }}
            >
              Manage email preferences
            </Link>
            {" \xb7 "}
            <Link
              href={unsubUrl}
              style={{ color: colors.muted, textDecoration: "underline" }}
            >
              Unsubscribe
            </Link>
          </Text>
        </Section>
      </EmailContainer>
    </EmailShell>
  );
}

// ---------------------------------------------------------------------------
// Plain-text fallback
// ---------------------------------------------------------------------------

export function plainText(data: WeeklyDigestEmailProps): string {
  const {
    weekOf,
    handle,
    weekTokensSaved,
    weekDollarsSaved,
    topTools,
    genomeSectionsAdded,
    streakDays,
    unsubscribeToken,
    siteUrl = SITE_DEFAULT,
  } = data;

  const lines: string[] = [
    `Your ashlr week · ${weekOf}`,
    ``,
    `Hi ${handle},`,
    ``,
    `──────────────────────────`,
    `SAVINGS THIS WEEK`,
    `──────────────────────────`,
    `Tokens saved : ${fmtTokens(weekTokensSaved)}`,
    `Est. dollars : ${fmtDollars(weekDollarsSaved)}`,
    ``,
  ];

  if (topTools.length > 0) {
    lines.push(`──────────────────────────`);
    lines.push(`TOP TOOLS (ALL TIME)`);
    lines.push(`──────────────────────────`);
    for (const t of topTools.slice(0, 5)) {
      lines.push(`  ${t.name.padEnd(24)} ${t.calls.toLocaleString()}`);
    }
    lines.push(``);
  }

  lines.push(`──────────────────────────`);
  lines.push(`ACTIVITY`);
  lines.push(`──────────────────────────`);
  lines.push(`Genome sections added this week: ${genomeSectionsAdded}`);
  lines.push(`Current streak: ${streakDays > 0 ? `${streakDays} days` : "none — start one today"}`);
  lines.push(``);
  lines.push(`Open dashboard: ${siteUrl}/dashboard`);
  lines.push(``);
  lines.push(`--`);
  lines.push(`ashlr · MIT-licensed plugin + proprietary hosted backend.`);
  lines.push(`Manage email preferences: ${siteUrl}/dashboard/settings`);
  lines.push(`Unsubscribe: ${siteUrl}/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`);

  return lines.join("\n");
}
