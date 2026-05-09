/**
 * weekly-digest-cron.ts — Pro weekly digest email sender.
 *
 * Invocation:
 *   bun server/src/jobs/weekly-digest-cron.ts [--dry-run]
 *
 * Scheduling: invoke via an external scheduler pointed at the command above.
 * Recommended cron: every Sunday at 14:00 UTC.
 *   Render Cron:        0 14 * * 0
 *   GitHub Actions:     schedule: [{ cron: "0 14 * * 0" }]
 *
 * The function `runWeeklyDigestSend` is also exported for integration tests.
 *
 * Rate-limiting: users are processed in batches of 50 with a 1-second pause
 * between batches to avoid SendGrid throughput limits.
 *
 * Deduplification: users whose `weekly_digest_last_sent_at` is within the
 * last 6 days are skipped, so re-running after a partial failure is safe.
 */

import { getDb } from "../db.js";
import { sendEmail } from "../lib/email.js";
import { logger } from "../lib/logger.js";
import { captureException } from "../lib/sentry.js";
import { getWeeklyDigestForUser } from "./weekly-digest-data.js";
import { buildSubject, plainText } from "../emails/weekly-digest.js";
import { render } from "@react-email/render";
import * as React from "react";
import WeeklyDigestEmail from "../emails/weekly-digest.js";
import { signUnsubscribeToken } from "../lib/unsubscribe.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_SIZE = 50;
const BATCH_SLEEP_MS = 1_000;
const DEDUPE_WINDOW_DAYS = 6;
const SITE_URL = process.env["ASHLR_SITE_URL"] ?? "https://plugin.ashlr.ai";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DigestSendResult {
  sent: number;
  skipped: number;
  failed: number;
}

interface EligibleUser {
  id: string;
  email: string;
  tier: string;
  weekly_digest_opt_in: number;
  weekly_digest_last_sent_at: string | null;
}

// ---------------------------------------------------------------------------
// DB helpers (local — not worth promoting to db/users.ts for now)
// ---------------------------------------------------------------------------

function getEligibleUsers(nowMs: number): EligibleUser[] {
  const db = getDb();
  const cutoff = new Date(nowMs - DEDUPE_WINDOW_DAYS * 86_400_000).toISOString();
  return db
    .query<EligibleUser, [string]>(
      `SELECT id, email, tier, weekly_digest_opt_in, weekly_digest_last_sent_at
       FROM users
       WHERE tier IN ('pro', 'team')
         AND weekly_digest_opt_in = 1
         AND (weekly_digest_last_sent_at IS NULL OR weekly_digest_last_sent_at < ?)`,
    )
    .all(cutoff);
}

function markDigestSent(userId: string, nowMs: number): void {
  getDb().run(
    `UPDATE users SET weekly_digest_last_sent_at = ? WHERE id = ?`,
    [new Date(nowMs).toISOString(), userId],
  );
}

// ---------------------------------------------------------------------------
// Sleep helper
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Main entry point.
 *
 * @param opts.dryRun  When true, renders emails but does not send or update DB.
 * @param opts.nowMs   Override "now" for testing.
 */
export async function runWeeklyDigestSend(opts: {
  dryRun?: boolean;
  nowMs?: number;
} = {}): Promise<DigestSendResult> {
  const { dryRun = false, nowMs = Date.now() } = opts;
  const startMs = Date.now();
  const result: DigestSendResult = { sent: 0, skipped: 0, failed: 0 };

  logger.info({ event: "cron_start", dryRun }, "weekly-digest: cron_start");

  const users = getEligibleUsers(nowMs);
  logger.info({ count: users.length, dryRun }, "weekly-digest: eligible users");

  // Process in batches
  for (let i = 0; i < users.length; i += BATCH_SIZE) {
    const batch = users.slice(i, i + BATCH_SIZE);

    for (const user of batch) {
      try {
        const data = await getWeeklyDigestForUser(user.id, user.email, nowMs);
        const unsubscribeToken = signUnsubscribeToken(user.id);
        const subject = buildSubject(data.weekOf);

        const emailProps = {
          weekOf: data.weekOf,
          handle: data.handle,
          weekTokensSaved: data.weekTokensSaved,
          weekDollarsSaved: data.weekDollarsSaved,
          topTools: data.topTools,
          genomeSectionsAdded: data.genomeSectionsAdded,
          streakDays: data.streakDays,
          unsubscribeToken,
          siteUrl: SITE_URL,
        };

        const html = await render(React.createElement(WeeklyDigestEmail, emailProps));
        const text = plainText(emailProps);

        if (dryRun) {
          logger.info({ userId: user.id, subject, dryRun: true }, "weekly-digest: dry-run skip send");
          result.sent++;
          continue;
        }

        // Optimistic write: mark sent BEFORE calling sendEmail.
        // Trade-off: a process crash after markDigestSent but before sendEmail
        // causes a missed delivery (acceptable). The reverse order risks a
        // duplicate delivery on restart (unacceptable for transactional email).
        markDigestSent(user.id, nowMs);

        // Send via SendGrid (sendEmail never throws — errors are logged internally)
        await sendEmail("weekly-digest", {
          to: user.email,
          data: { subject, html, text },
        });

        result.sent++;
        logger.info({ userId: user.id, subject }, "weekly-digest: sent");
      } catch (err) {
        result.failed++;
        logger.error({ userId: user.id, err: String(err) }, "weekly-digest: failed for user");
        // Do NOT mark as sent — will retry on next run
      }
    }

    // Pause between batches (skip after last batch)
    if (i + BATCH_SIZE < users.length) {
      await sleep(BATCH_SLEEP_MS);
    }
  }

  const durationMs = Date.now() - startMs;
  const total = result.sent + result.skipped + result.failed;
  const failureRatio = total === 0 ? 0 : result.failed / total;
  logger.info(
    { event: "cron_end", sent: result.sent, skipped: result.skipped, failed: result.failed, failureRatio, durationMs },
    "weekly-digest: cron_end",
  );
  return result;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const dryRun = process.argv.includes("--dry-run");

  if (dryRun) {
    console.log("[weekly-digest] dry-run mode — no emails will be sent");
  }

  runWeeklyDigestSend({ dryRun })
    .then((result) => {
      const total = result.sent + result.skipped + result.failed;
      const failureRatio = total === 0 ? 0 : result.failed / total;
      console.log(
        `[weekly-digest] done: sent=${result.sent} skipped=${result.skipped} failed=${result.failed} failure_ratio=${failureRatio.toFixed(4)}`,
      );
      // Exit 1 only when failure rate exceeds 5% — transient SendGrid 429s on
      // large lists produce noise below that threshold. Observability can alert
      // on the failure_ratio field in the cron_end structured log independently.
      if (failureRatio > 0.05) {
        console.error(`[weekly-digest] failure ratio ${(failureRatio * 100).toFixed(1)}% exceeds 5% threshold`);
        process.exit(1);
      }
      if (result.failed > 0) {
        console.warn(`[weekly-digest] ${result.failed} failure(s) within acceptable threshold — exiting 0`);
      }
      process.exit(0);
    })
    .catch((err) => {
      captureException(err, { job: "weekly-digest-cron" });
      console.error("[weekly-digest] fatal:", err);
      process.exit(1);
    });
}
