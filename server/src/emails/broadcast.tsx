/**
 * broadcast.tsx — Admin announcement email.
 *
 * Subject: supplied by caller
 * Props: { subject, body } (body is plain text / light markdown)
 */

import { Section, Text, Hr } from "@react-email/components";
import * as React from "react";
import { EmailShell, EmailContainer, EmailHeader, EmailBody, EmailFooter, colors, fonts } from "./shared.js";

export interface BroadcastEmailProps {
  subject: string;
  body: string;
}

export function subjectFor(props: BroadcastEmailProps): string {
  return props.subject;
}

export default function BroadcastEmail({ subject: _subject, body }: BroadcastEmailProps): React.JSX.Element {
  // Split body on blank lines into paragraphs
  const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  return (
    <EmailShell previewText={_subject}>
      <EmailContainer>
        <EmailHeader />
        <EmailBody>
          <Section>
            {paragraphs.map((para, i) => (
              <Text
                key={i}
                style={{
                  fontFamily: fonts.body,
                  color: colors.ink,
                  margin: "0 0 16px 0",
                  lineHeight: "1.6",
                  whiteSpace: "pre-wrap",
                }}
              >
                {para}
              </Text>
            ))}
          </Section>
          <Hr style={{ borderColor: colors.border, margin: "24px 0" }} />
          <EmailFooter />
        </EmailBody>
      </EmailContainer>
    </EmailShell>
  );
}

export function plainText({ subject: _subject, body }: BroadcastEmailProps): string {
  return [
    body,
    "",
    "--",
    "ashlr · plugin.ashlr.ai",
    "To manage preferences visit: https://plugin.ashlr.ai/preferences",
  ].join("\n");
}
