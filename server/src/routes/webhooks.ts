/**
 * webhooks.ts — GitHub webhook receiver (v1.14).
 *
 * POST /webhooks/github
 *   - Validates x-hub-signature-256 (HMAC-SHA256, timingSafeEqual)
 *   - Dispatches push / ping events
 *   - Deduplicates by GitHub delivery id (webhook_events table)
 *   - Returns 2xx fast; actual genome rebuild runs in background
 */

import { Hono } from "hono";
import { timingSafeEqual, createHmac } from "node:crypto";
import {
  recordWebhookEvent,
  hasProcessedDelivery,
  updateWebhookEventStatus,
  getPersonalGenomeByRepoUrl,
} from "../db.js";
import { isValidGitHubOwner, isValidGitHubRepo, rebuildGenomeDelta } from "../services/genome-build.js";
import { logger } from "../lib/logger.js";
import { recordGenomeDelta } from "../lib/genome-deltas.js";

const webhooks = new Hono();
const MAX_GITHUB_WEBHOOK_BYTES = 1_048_576;

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

function verifyGitHubSignature(rawBody: Uint8Array, sigHeader: string | null, secret: string): boolean {
  if (!sigHeader || !sigHeader.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(`sha256=${expected}`, "utf8");
  const actualBuf = Buffer.from(sigHeader, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

// ---------------------------------------------------------------------------
// POST /webhooks/github
// ---------------------------------------------------------------------------

webhooks.post("/webhooks/github", async (c) => {
  const secret = process.env["GITHUB_WEBHOOK_SECRET"];
  if (!secret) {
    return c.json({ error: "webhook not configured" }, 500);
  }

  const contentLength = c.req.header("content-length");
  if (contentLength !== undefined) {
    const length = Number(contentLength);
    if (!Number.isFinite(length) || length < 0) {
      return c.json({ error: "invalid content length" }, 400);
    }
    if (length > MAX_GITHUB_WEBHOOK_BYTES) {
      return c.json({ error: "payload too large" }, 413);
    }
  }

  // Read raw body for signature verification
  const rawBody = new Uint8Array(await c.req.arrayBuffer());
  if (rawBody.byteLength > MAX_GITHUB_WEBHOOK_BYTES) {
    return c.json({ error: "payload too large" }, 413);
  }
  const sigHeader = c.req.header("x-hub-signature-256") ?? null;

  if (!verifyGitHubSignature(rawBody, sigHeader, secret)) {
    return c.json({ error: "invalid signature" }, 401);
  }

  const eventType = c.req.header("x-github-event") ?? "unknown";
  const deliveryId = c.req.header("x-github-delivery") ?? crypto.randomUUID();

  // ping — immediate response, no DB write needed
  if (eventType === "ping") {
    return c.json({ pong: true }, 200);
  }

  // Parse JSON once for all events we handle.
  // Push, pull_request, issues all carry a `repository.full_name`.
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }

  // PR merged → record pr_merged delta (no rebuild — we keep that for pushes).
  if (eventType === "pull_request") {
    return handlePullRequestEvent(c, parsed as PullRequestPayload, deliveryId);
  }
  // Issue closed → record issue_closed delta.
  if (eventType === "issues") {
    return handleIssuesEvent(c, parsed as IssuesPayload, deliveryId);
  }
  // Anything other than push is now acknowledged + ignored.
  if (eventType !== "push") {
    return c.json({ message: "ignored" }, 202);
  }

  const payload = parsed as PushPayload;

  const fullName = payload.repository?.full_name;
  const headSha = payload.after ?? payload.commits?.[0]?.id ?? "";

  if (!fullName) {
    return c.json({ message: "no repository in payload" }, 200);
  }

  const canonicalUrl = `https://github.com/${fullName.toLowerCase()}`;

  // Look up genome
  const genome = getPersonalGenomeByRepoUrl(canonicalUrl);
  if (!genome) {
    return c.json({ message: "no subscribed genome" }, 200);
  }

  // Idempotency: single atomic INSERT OR IGNORE on the UNIQUE delivery id.
  // .inserted === false means another concurrent delivery of the same id
  // already got there — short-circuit without spawning a second rebuild.
  const { inserted } = recordWebhookEvent({
    id: deliveryId,
    event_type: eventType,
    genome_id: genome.id,
    commit_sha: headSha,
    status: "received",
  });
  if (!inserted) {
    return c.json({ message: "already processed" }, 200);
  }

  // Parse changed files from commits + record one commit delta per commit.
  // Idempotent on (genome_id, "commit", source_sha) via the UNIQUE index.
  const changedFiles: string[] = [];
  for (const commit of payload.commits ?? []) {
    const files = [
      ...(commit.added ?? []),
      ...(commit.modified ?? []),
      ...(commit.removed ?? []),
    ];
    changedFiles.push(...files);
    if (commit.id) {
      try {
        recordGenomeDelta({
          genomeId: genome.id,
          kind: "commit",
          sourceSha: commit.id,
          payload: {
            kind: "commit",
            sha: commit.id,
            message: (commit.message ?? "").slice(0, 4096),
            author: commit.author?.name,
            date: commit.timestamp,
            filesChanged: files.slice(0, 200), // cap for sanity
          },
        });
      } catch (err) {
        // Never fail the webhook on a delta-record failure — the rebuild is
        // the contract; deltas are best-effort.
        logger.warn(
          { genomeId: genome.id, sha: commit.id, err: String(err) },
          "failed to record commit delta",
        );
      }
    }
  }

  // Deduplicate changed files
  const uniqueFiles = [...new Set(changedFiles)];

  // Parse owner/repo from full_name
  const [owner, repo] = fullName.split("/") as [string, string];
  if (!isValidGitHubOwner(owner) || !isValidGitHubRepo(repo)) {
    return c.json({ error: "invalid repository full_name" }, 400);
  }

  // Return 202 immediately — rebuild happens in background
  void (async () => {
    try {
      await rebuildGenomeDelta({
        userId: genome.owner_user_id!,
        owner,
        repo,
        genomeId: genome.id,
        changedFiles: uniqueFiles,
      });
      updateWebhookEventStatus(deliveryId, "processed");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ deliveryId, genomeId: genome.id, err: msg }, "webhook rebuild failed");
      updateWebhookEventStatus(deliveryId, "failed", msg.slice(0, 500));
    }
  })();

  return c.json({ message: "queued" }, 202);
});

// ---------------------------------------------------------------------------
// Push payload types
// ---------------------------------------------------------------------------

interface PushPayload {
  after?: string;
  ref?: string;
  repository?: {
    full_name: string;
    private?: boolean;
  };
  commits?: Array<{
    id: string;
    message?: string;
    timestamp?: string;
    author?: { name?: string; email?: string };
    added?: string[];
    modified?: string[];
    removed?: string[];
  }>;
  sender?: {
    login: string;
  };
}

// ---------------------------------------------------------------------------
// pull_request handler — only `closed` action with `merged: true` counts.
// ---------------------------------------------------------------------------

interface PullRequestPayload {
  action?: string;
  pull_request?: {
    number?: number;
    title?: string;
    merged?: boolean;
    merge_commit_sha?: string | null;
    merged_at?: string | null;
    user?: { login?: string };
    body?: string | null;
  };
  repository?: { full_name?: string };
}

async function handlePullRequestEvent(
  c: import("hono").Context,
  payload: PullRequestPayload,
  deliveryId: string,
): Promise<Response> {
  const action = payload.action ?? "";
  const pr = payload.pull_request;
  const fullName = payload.repository?.full_name;
  if (!fullName) return c.json({ message: "no repository in payload" }, 200);
  if (!pr || action !== "closed" || !pr.merged) {
    return c.json({ message: "ignored" }, 202);
  }

  const canonicalUrl = `https://github.com/${fullName.toLowerCase()}`;
  const genome = getPersonalGenomeByRepoUrl(canonicalUrl);
  if (!genome) return c.json({ message: "no subscribed genome" }, 200);

  const sourceSha = String(pr.number ?? pr.merge_commit_sha ?? deliveryId);
  try {
    recordGenomeDelta({
      genomeId: genome.id,
      kind: "pr_merged",
      sourceSha,
      payload: {
        kind: "pr_merged",
        number: pr.number ?? 0,
        title: (pr.title ?? "").slice(0, 512),
        mergedSha: pr.merge_commit_sha ?? undefined,
        author: pr.user?.login,
        mergedAt: pr.merged_at ?? undefined,
        filesChanged: [], // GitHub doesn't ship files in this payload — keep empty
        summary: (pr.body ?? "").slice(0, 1024) || undefined,
      },
    });
  } catch (err) {
    logger.warn(
      { genomeId: genome.id, prNumber: pr.number, err: String(err) },
      "failed to record pr_merged delta",
    );
  }
  return c.json({ message: "delta recorded" }, 202);
}

// ---------------------------------------------------------------------------
// issues handler — only `closed` action counts.
// ---------------------------------------------------------------------------

interface IssuesPayload {
  action?: string;
  issue?: {
    number?: number;
    title?: string;
    closed_at?: string | null;
    user?: { login?: string };
    body?: string | null;
  };
  repository?: { full_name?: string };
}

async function handleIssuesEvent(
  c: import("hono").Context,
  payload: IssuesPayload,
  deliveryId: string,
): Promise<Response> {
  const action = payload.action ?? "";
  const issue = payload.issue;
  const fullName = payload.repository?.full_name;
  if (!fullName) return c.json({ message: "no repository in payload" }, 200);
  if (!issue || action !== "closed") {
    return c.json({ message: "ignored" }, 202);
  }

  const canonicalUrl = `https://github.com/${fullName.toLowerCase()}`;
  const genome = getPersonalGenomeByRepoUrl(canonicalUrl);
  if (!genome) return c.json({ message: "no subscribed genome" }, 200);

  const sourceSha = String(issue.number ?? deliveryId);
  try {
    recordGenomeDelta({
      genomeId: genome.id,
      kind: "issue_closed",
      sourceSha,
      payload: {
        kind: "issue_closed",
        number: issue.number ?? 0,
        title: (issue.title ?? "").slice(0, 512),
        closedAt: issue.closed_at ?? undefined,
        author: issue.user?.login,
        summary: (issue.body ?? "").slice(0, 1024) || undefined,
      },
    });
  } catch (err) {
    logger.warn(
      { genomeId: genome.id, issueNumber: issue.number, err: String(err) },
      "failed to record issue_closed delta",
    );
  }
  return c.json({ message: "delta recorded" }, 202);
}

export default webhooks;
