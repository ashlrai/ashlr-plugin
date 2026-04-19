/**
 * team-invite.tsx — Invitation email for team-tier membership.
 *
 * Subject: "You're invited to {{teamName}} on ashlr"
 * Props:   { email, teamName, inviterEmail, link }
 */

import { Section, Text, Hr } from "@react-email/components";
import * as React from "react";
import { EmailShell, EmailContainer, EmailHeader, EmailBody, EmailFooter, colors, fonts } from "./shared.js";

export interface TeamInviteEmailProps {
  email:        string;
  teamName:     string;
  inviterEmail: string;
  role:         "admin" | "member";
  link:         string;
}

export const subject = "You're invited to a team on ashlr";

export function plainText({ teamName, inviterEmail, role, link }: TeamInviteEmailProps): string {
  return [
    `${inviterEmail} invited you to ${teamName} on ashlr as a ${role}.`,
    "",
    `Accept the invitation: ${link}`,
    "",
    "This invitation expires in 7 days. If you didn't expect it, just ignore this email.",
    "",
    "— ashlr",
  ].join("\n");
}

export default function TeamInviteEmail({
  email,
  teamName,
  inviterEmail,
  role,
  link,
}: TeamInviteEmailProps): React.JSX.Element {
  return (
    <EmailShell previewText={`${inviterEmail} invited you to ${teamName} on ashlr.`}>
      <EmailContainer>
        <EmailHeader />
        <EmailBody>
          <Text
            role="heading"
            style={{
              fontFamily: fonts.heading,
              fontSize: 28,
              lineHeight: 1.15,
              color: colors.accent,
              margin: "0 0 16px 0",
              fontWeight: 700,
              letterSpacing: "-0.01em",
            }}
          >
            You've been invited to <em>{teamName}</em>.
          </Text>

          <Text style={{ fontFamily: fonts.body, fontSize: 16, color: colors.ink, lineHeight: 1.55 }}>
            <strong>{inviterEmail}</strong> has invited you ({email}) to join{" "}
            <strong>{teamName}</strong> on ashlr as a <strong>{role}</strong>. Team membership gets you
            access to shared encrypted genomes, aggregated per-member savings, and unified billing.
          </Text>

          <Section style={{ textAlign: "center", padding: "28px 0" }}>
            <a
              href={link}
              style={{
                display: "inline-block",
                fontFamily: fonts.body,
                fontSize: 16,
                fontWeight: 600,
                color: colors.paper,
                background: colors.accent,
                padding: "14px 28px",
                textDecoration: "none",
                borderRadius: 4,
                letterSpacing: "0.02em",
              }}
            >
              Accept invitation
            </a>
          </Section>

          <Text style={{ fontFamily: fonts.body, fontSize: 13, color: colors.muted, lineHeight: 1.55 }}>
            Or copy this link into your browser:
            <br />
            <span style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", wordBreak: "break-all" }}>{link}</span>
          </Text>

          <Hr style={{ borderColor: colors.border, margin: "24px 0" }} />

          <Text style={{ fontFamily: fonts.body, fontSize: 13, color: colors.muted, lineHeight: 1.55 }}>
            This invitation expires in 7 days. If you didn't expect it, just ignore this email — no
            account is created until you accept.
          </Text>
        </EmailBody>
        <EmailFooter />
      </EmailContainer>
    </EmailShell>
  );
}
