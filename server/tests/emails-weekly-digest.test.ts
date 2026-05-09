/**
 * emails-weekly-digest.test.ts — Unit tests for the weekly digest email template.
 *
 * Covers:
 *   1. HTML renders without throwing and is non-empty
 *   2. Plain-text fallback renders without throwing and is non-empty
 *   3. Subject line format and length ≤ 70 chars
 *   4. CTA URL points to /dashboard
 *   5. Unsubscribe link is present in both HTML and plain text
 *   6. Email address is NOT present in body or subject
 *   7. Zero-savings case (no crash)
 *   8. No-tools case (no crash)
 *   9. Streak displayed vs hidden correctly
 *  10. fmtTokens edge cases embedded in rendered output
 */

import { describe, it, expect } from "bun:test";
import * as React from "react";
import { render } from "@react-email/render";

import WeeklyDigestEmail, {
  plainText,
  buildSubject,
  type WeeklyDigestEmailProps,
} from "../src/emails/weekly-digest.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SITE = "https://plugin.ashlr.ai";
const TOKEN = "userid123.9999999999999.abc-def_xyz";
const EMAIL = "mason@evero-consulting.com"; // must NEVER appear in output

function makeProps(overrides: Partial<WeeklyDigestEmailProps> = {}): WeeklyDigestEmailProps {
  return {
    weekOf: "2026-05-04",
    handle: "mason",           // email local-part — NOT the full address
    weekTokensSaved: 1_250_000,
    weekDollarsSaved: 3.75,
    topTools: [
      { name: "ashlr__read", calls: 420 },
      { name: "ashlr__grep", calls: 310 },
      { name: "ashlr__edit", calls: 200 },
    ],
    genomeSectionsAdded: 12,
    streakDays: 7,
    unsubscribeToken: TOKEN,
    siteUrl: SITE,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. HTML renders
// ---------------------------------------------------------------------------

describe("WeeklyDigestEmail HTML", () => {
  it("renders without throwing", async () => {
    const html = await render(React.createElement(WeeklyDigestEmail, makeProps()));
    expect(html.length).toBeGreaterThan(100);
  });

  it("contains savings figures", async () => {
    const html = await render(React.createElement(WeeklyDigestEmail, makeProps()));
    expect(html).toContain("1.3M"); // fmtTokens(1_250_000)
    expect(html).toContain("$3.75");
  });

  it("contains top tools", async () => {
    const html = await render(React.createElement(WeeklyDigestEmail, makeProps()));
    expect(html).toContain("ashlr__read");
    expect(html).toContain("ashlr__grep");
  });

  it("CTA link points to /dashboard", async () => {
    const html = await render(React.createElement(WeeklyDigestEmail, makeProps()));
    expect(html).toContain(`${SITE}/dashboard`);
  });

  it("contains unsubscribe link", async () => {
    const html = await render(React.createElement(WeeklyDigestEmail, makeProps()));
    expect(html).toContain("/unsubscribe?token=");
    expect(html).toContain(encodeURIComponent(TOKEN));
  });

  it("does NOT contain the full email address", async () => {
    const html = await render(React.createElement(WeeklyDigestEmail, makeProps()));
    expect(html).not.toContain(EMAIL);
  });
});

// ---------------------------------------------------------------------------
// 2. Plain-text fallback
// ---------------------------------------------------------------------------

describe("WeeklyDigestEmail plain text", () => {
  it("renders without throwing and is non-empty", () => {
    const text = plainText(makeProps());
    expect(text.length).toBeGreaterThan(50);
  });

  it("contains savings figures", () => {
    const text = plainText(makeProps());
    expect(text).toContain("1.3M");
    expect(text).toContain("$3.75");
  });

  it("contains top tools", () => {
    const text = plainText(makeProps());
    expect(text).toContain("ashlr__read");
    expect(text).toContain("ashlr__grep");
  });

  it("contains dashboard URL", () => {
    const text = plainText(makeProps());
    expect(text).toContain(`${SITE}/dashboard`);
  });

  it("contains unsubscribe URL", () => {
    const text = plainText(makeProps());
    expect(text).toContain("/unsubscribe?token=");
  });

  it("does NOT contain the full email address", () => {
    const text = plainText(makeProps());
    expect(text).not.toContain(EMAIL);
  });
});

// ---------------------------------------------------------------------------
// 3. Subject
// ---------------------------------------------------------------------------

describe("buildSubject", () => {
  it("contains the weekOf date", () => {
    expect(buildSubject("2026-05-04")).toContain("2026-05-04");
  });

  it("is ≤ 70 characters", () => {
    expect(buildSubject("2026-05-04").length).toBeLessThanOrEqual(70);
  });
});

// ---------------------------------------------------------------------------
// 4. Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("zero savings does not crash", async () => {
    const html = await render(
      React.createElement(WeeklyDigestEmail, makeProps({ weekTokensSaved: 0, weekDollarsSaved: 0 })),
    );
    expect(html).toContain("$0.00");
  });

  it("empty topTools array does not crash", async () => {
    const html = await render(
      React.createElement(WeeklyDigestEmail, makeProps({ topTools: [] })),
    );
    expect(html.length).toBeGreaterThan(100);
  });

  it("zero streak shows 'em dash' sentinel in HTML", async () => {
    const html = await render(
      React.createElement(WeeklyDigestEmail, makeProps({ streakDays: 0 })),
    );
    // The component renders "—" for zero streak
    expect(html).toMatch(/—|&#x2014;|&mdash;/);
  });

  it("non-zero streak shows day count in plain text", () => {
    const text = plainText(makeProps({ streakDays: 14 }));
    expect(text).toContain("14 days");
  });

  it("large token counts use M suffix", () => {
    const text = plainText(makeProps({ weekTokensSaved: 2_500_000 }));
    expect(text).toContain("2.5M");
  });

  it("sub-1000 token counts render as plain number", () => {
    const text = plainText(makeProps({ weekTokensSaved: 750 }));
    expect(text).toContain("750");
  });

  it("default siteUrl is plugin.ashlr.ai when not provided", () => {
    // Omit the optional siteUrl by spreading only the required fields
    const { siteUrl: _omit, ...propsWithoutSite } = makeProps();
    const text = plainText(propsWithoutSite as WeeklyDigestEmailProps);
    expect(text).toContain("plugin.ashlr.ai");
  });
});
