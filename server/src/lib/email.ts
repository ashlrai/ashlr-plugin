/**
 * email.ts — Central email dispatch via react-email + SendGrid.
 *
 * Usage:
 *   await sendEmail("magic-link", { to: "user@example.com", data: { email, link } });
 *
 * In TESTING=1 or when SENDGRID_API_KEY is unset the rendered HTML is written
 * to stderr and no real send is attempted.  All errors are caught — this
 * function never throws.
 */

import { render } from "@react-email/render";
import sendgrid from "@sendgrid/mail";
import * as React from "react";

// ---------------------------------------------------------------------------
// Lazy SendGrid client (one-time init on first send)
// ---------------------------------------------------------------------------

let _sendgridInitialized = false;

function ensureSendgrid(): boolean {
  const key = process.env["SENDGRID_API_KEY"] ?? "";
  if (!key) return false;
  if (!_sendgridInitialized) {
    sendgrid.setApiKey(key);
    _sendgridInitialized = true;
  }
  return true;
}

function isTesting(): boolean {
  return process.env["TESTING"] === "1";
}

// ---------------------------------------------------------------------------
// Template registry
// ---------------------------------------------------------------------------

import MagicLinkEmail, {
  subject as magicLinkSubject,
  plainText as magicLinkPlain,
  type MagicLinkEmailProps,
} from "../emails/magic-link.js";

import WelcomeEmail, {
  subject as welcomeSubject,
  plainText as welcomePlain,
  type WelcomeEmailProps,
} from "../emails/welcome.js";

import PaymentSuccessEmail, {
  subject as paymentSuccessSubject,
  plainText as paymentSuccessPlain,
  type PaymentSuccessEmailProps,
} from "../emails/payment-success.js";

import PaymentFailedEmail, {
  subject as paymentFailedSubject,
  plainText as paymentFailedPlain,
  type PaymentFailedEmailProps,
} from "../emails/payment-failed.js";

import SubscriptionCanceledEmail, {
  subject as subscriptionCanceledSubject,
  plainText as subscriptionCanceledPlain,
  type SubscriptionCanceledEmailProps,
} from "../emails/subscription-canceled.js";

import DailyCapReachedEmail, {
  subject as dailyCapReachedSubject,
  plainText as dailyCapReachedPlain,
  type DailyCapReachedEmailProps,
} from "../emails/daily-cap-reached.js";

import StatusConfirmEmail, {
  subject as statusConfirmSubject,
  plainText as statusConfirmPlain,
  type StatusConfirmEmailProps,
} from "../emails/status-confirm.js";

import BroadcastEmail, {
  subjectFor as broadcastSubject,
  plainText as broadcastPlain,
  type BroadcastEmailProps,
} from "../emails/broadcast.js";

import TeamInviteEmail, {
  subject as teamInviteSubject,
  plainText as teamInvitePlain,
  type TeamInviteEmailProps,
} from "../emails/team-invite.js";

// ---------------------------------------------------------------------------
// Discriminated union: template name → data type
// ---------------------------------------------------------------------------

export type TemplateMap = {
  "magic-link":            MagicLinkEmailProps;
  "welcome":               WelcomeEmailProps;
  "payment-success":       PaymentSuccessEmailProps;
  "payment-failed":        PaymentFailedEmailProps;
  "subscription-canceled": SubscriptionCanceledEmailProps;
  "daily-cap-reached":     DailyCapReachedEmailProps;
  "status-confirm":        StatusConfirmEmailProps;
  "broadcast":             BroadcastEmailProps;
  "team-invite":           TeamInviteEmailProps;
};

export type TemplateName = keyof TemplateMap;

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

async function renderTemplate<T extends TemplateName>(
  name: T,
  data: TemplateMap[T],
): Promise<{ subject: string; html: string; text: string }> {
  switch (name) {
    case "magic-link": {
      const d = data as MagicLinkEmailProps;
      const html = await render(React.createElement(MagicLinkEmail, d));
      return { subject: magicLinkSubject, html, text: magicLinkPlain(d) };
    }
    case "welcome": {
      const d = data as WelcomeEmailProps;
      const html = await render(React.createElement(WelcomeEmail, d));
      return { subject: welcomeSubject, html, text: welcomePlain(d) };
    }
    case "payment-success": {
      const d = data as PaymentSuccessEmailProps;
      const html = await render(React.createElement(PaymentSuccessEmail, d));
      return { subject: paymentSuccessSubject, html, text: paymentSuccessPlain(d) };
    }
    case "payment-failed": {
      const d = data as PaymentFailedEmailProps;
      const html = await render(React.createElement(PaymentFailedEmail, d));
      return { subject: paymentFailedSubject, html, text: paymentFailedPlain(d) };
    }
    case "subscription-canceled": {
      const d = data as SubscriptionCanceledEmailProps;
      const html = await render(React.createElement(SubscriptionCanceledEmail, d));
      return { subject: subscriptionCanceledSubject, html, text: subscriptionCanceledPlain(d) };
    }
    case "daily-cap-reached": {
      const d = data as DailyCapReachedEmailProps;
      const html = await render(React.createElement(DailyCapReachedEmail, d));
      return { subject: dailyCapReachedSubject, html, text: dailyCapReachedPlain(d) };
    }
    case "status-confirm": {
      const d = data as StatusConfirmEmailProps;
      const html = await render(React.createElement(StatusConfirmEmail, d));
      return { subject: statusConfirmSubject, html, text: statusConfirmPlain(d) };
    }
    case "broadcast": {
      const d = data as BroadcastEmailProps;
      const html = await render(React.createElement(BroadcastEmail, d));
      return { subject: broadcastSubject(d), html, text: broadcastPlain(d) };
    }
    case "team-invite": {
      const d = data as TeamInviteEmailProps;
      const html = await render(React.createElement(TeamInviteEmail, d));
      return { subject: teamInviteSubject, html, text: teamInvitePlain(d) };
    }
    default:
      throw new Error(`Unknown email template: ${String(name)}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SendEmailOptions<T extends TemplateName> {
  to:   string;
  data: TemplateMap[T];
  /** Override the from address — defaults to noreply@ashlr.ai */
  from?: string;
}

/**
 * Render a React email template and send it via SendGrid.
 *
 * Falls back to logging rendered HTML to stderr if:
 *   - SENDGRID_API_KEY is unset, OR
 *   - TESTING=1
 *
 * Never throws — all errors are caught and logged.
 */
export async function sendEmail<T extends TemplateName>(
  template: T,
  { to, data, from = "ashlr <noreply@ashlr.ai>" }: SendEmailOptions<T>,
): Promise<void> {
  try {
    const rendered = await renderTemplate(template, data);

    if (isTesting() || !process.env["SENDGRID_API_KEY"]) {
      process.stderr.write(
        `[ashlr-email] TESTING send to=${to} subject="${rendered.subject}"\n` +
        `[ashlr-email] html length=${rendered.html.length}\n` +
        `[ashlr-email] text:\n${rendered.text}\n`,
      );
      return;
    }

    if (!ensureSendgrid()) return;

    // Parse `"ashlr <noreply@ashlr.ai>"` into SendGrid's {name, email} shape.
    const fromAddr = parseAddress(from);

    try {
      await sendgrid.send({
        from:    fromAddr,
        to,
        subject: rendered.subject,
        html:    rendered.html,
        text:    rendered.text,
      });
    } catch (sgErr) {
      const err = sgErr as { code?: number; message?: string; response?: { body?: unknown } };
      process.stderr.write(
        `[ashlr-email] SendGrid error for template=${template} to=${to}: ` +
        `code=${err.code ?? "?"} msg="${err.message ?? String(sgErr)}"` +
        (err.response?.body ? ` body=${JSON.stringify(err.response.body)}` : "") +
        `\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `[ashlr-email] unexpected error for template=${template} to=${to}: ${String(err)}\n`,
    );
  }
}

/**
 * Parse an RFC 5322-ish from-address string like `"ashlr <noreply@ashlr.ai>"`
 * into SendGrid's `{ name, email }` shape. If the string is just a bare
 * address it returns that as `email` with no `name`.
 */
function parseAddress(s: string): { name?: string; email: string } {
  const m = /^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/.exec(s);
  if (m && m[2]) {
    const name = (m[1] ?? "").trim();
    return name ? { name, email: m[2] } : { email: m[2] };
  }
  return { email: s.trim() };
}
