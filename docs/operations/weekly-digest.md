# Weekly Digest — Operations Guide

## Schedule

Runs every **Sunday at 14:00 UTC** via GitHub Actions (`.github/workflows/weekly-digest.yml`).

Eligible recipients: Pro and Team tier users with `weekly_digest_opt_in = 1` who have not received a digest in the last 6 days (dedupe window prevents double-sends on retries).

---

## Manual trigger

```bash
# Production send (requires repo write access)
gh workflow run weekly-digest.yml --ref main

# Dry-run (renders emails, no sends, no DB writes)
gh workflow run weekly-digest.yml --ref main -f dry_run=true
```

Or via GitHub UI: **Actions → Weekly Digest → Run workflow**.

---

## Local dry-run

```bash
cd server
ASHLR_MASTER_KEY=<key> SENDGRID_API_KEY=<key> DATABASE_URL=<url> \
  bun src/jobs/weekly-digest-cron.ts --dry-run
```

No emails are sent; rendered output is written to stderr.

---

## Debugging a failed run

1. **GitHub Actions logs** — go to Actions → Weekly Digest → failed run. The job streams structured pino JSON; search for `"event":"cron_end"` to see final counts, or `"event":"cron_start"` to confirm the job started.

2. **Key log lines to look for:**

   | Field | Meaning |
   |-------|---------|
   | `event: "cron_start"` | Job began, includes `dryRun` flag |
   | `event: "cron_end"` | Job finished; `sent`, `skipped`, `failed`, `durationMs` |
   | `weekly-digest: failed for user` | Per-user error with `userId` and `err` |

3. **Partial failure is safe** — users whose send failed are not marked as sent in the DB, so the next scheduled run retries them automatically.

4. **Re-running manually** — trigger via `gh workflow run` above. The 6-day dedupe window means already-sent users are skipped; only failed/missed users receive the email.

---

## Failure visibility

GitHub Actions emails the repo owner on any job failure by default. No additional configuration needed.

To add Slack/PagerDuty alerts, add a notification step at the end of the `send` job in `.github/workflows/weekly-digest.yml`.

---

## User opt-out

Users can unsubscribe via:

- **Unsubscribe link** in every digest email → `GET /unsubscribe?token=<signed-token>` → sets `weekly_digest_opt_in = 0`
- **Email preferences API** → `GET/POST /api/email-prefs` (see `docs/email-templates.md` for the full unsubscribe flow)

Opted-out users are excluded at query time; no re-opt-in happens automatically.
