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
import { rebuildGenomeDelta } from "../services/genome-build.js";
import { logger } from "../lib/logger.js";

const webhooks = new Hono();

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

  // Read raw body for signature verification
  const rawBody = new Uint8Array(await c.req.arrayBuffer());
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

  // Unknown events — acknowledge and ignore
  if (eventType !== "push") {
    return c.json({ message: "ignored" }, 202);
  }

  // Parse push payload
  let payload: PushPayload;
  try {
    payload = JSON.parse(Buffer.from(rawBody).toString("utf8")) as PushPayload;
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }

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

  // Idempotency: dedup by delivery id (unique per GitHub delivery)
  if (hasProcessedDelivery(deliveryId)) {
    return c.json({ message: "already processed" }, 200);
  }

  // Record the webhook event
  recordWebhookEvent({
    id: deliveryId,
    event_type: eventType,
    genome_id: genome.id,
    commit_sha: headSha,
    status: "received",
  });

  // Parse changed files from commits
  const changedFiles: string[] = [];
  for (const commit of payload.commits ?? []) {
    changedFiles.push(...(commit.added ?? []), ...(commit.modified ?? []), ...(commit.removed ?? []));
  }

  // Deduplicate changed files
  const uniqueFiles = [...new Set(changedFiles)];

  // Parse owner/repo from full_name
  const [owner, repo] = fullName.split("/") as [string, string];

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
    added?: string[];
    modified?: string[];
    removed?: string[];
  }>;
  sender?: {
    login: string;
  };
}

export default webhooks;
