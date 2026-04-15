#!/usr/bin/env bun
/**
 * ashlr-genome MCP server.
 *
 * The active genome scribe loop — exposes three tools that let an agent
 * propose, consolidate, and inspect evolutionary updates to the project
 * genome stored under `.ashlrcode/genome/`.
 *
 *   ashlr__genome_propose     — queue a proposed update to a section
 *   ashlr__genome_consolidate — merge pending proposals into the genome
 *                                (optionally via an OpenAI-compatible LLM)
 *   ashlr__genome_status      — compact report of pending + recent mutations
 *
 * All heavy lifting (pending queue, mutation log, merge semantics) lives in
 * @ashlr/core-efficiency's `scribe.ts`. This server is a thin MCP adapter.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  consolidateProposals,
  genomeExists,
  loadManifest,
  loadMutations,
  loadPendingProposals,
  proposeUpdate,
} from "@ashlr/core-efficiency/genome";
import type {
  GenomeProposal,
  MutationRecord,
} from "@ashlr/core-efficiency/genome";
import type {
  LLMSummarizer,
  ProviderRequest,
  StreamEvent,
} from "@ashlr/core-efficiency";

// ---------------------------------------------------------------------------
// LLM shim — OpenAI-compatible chat.completions streaming
// ---------------------------------------------------------------------------

/**
 * Build a minimal LLMSummarizer that hits an OpenAI-compatible endpoint.
 *
 * Precedence:
 *   1. explicit `modelUrl` arg (per-call override)
 *   2. $ASHLR_LLM_URL / $ASHLR_LLM_KEY
 *   3. local LM Studio at http://localhost:1234/v1 (no key required)
 *
 * Returns null if no endpoint is configured AND no override given — the
 * scribe falls back to sequential-apply merging in that case.
 */
export function buildLLMShim(modelUrl?: string): LLMSummarizer | undefined {
  const base =
    modelUrl ??
    process.env.ASHLR_LLM_URL ??
    "http://localhost:1234/v1";
  const key = process.env.ASHLR_LLM_KEY ?? "";
  const model = process.env.ASHLR_LLM_MODEL ?? "local";

  const endpoint = base.replace(/\/+$/, "") + "/chat/completions";

  return {
    async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent> {
      // Collapse the core-efficiency message shape into OpenAI format.
      const messages = [
        { role: "system", content: req.systemPrompt },
        ...req.messages.map((m) => ({
          role: m.role === "tool" ? "user" : m.role,
          content:
            typeof m.content === "string"
              ? m.content
              : m.content
                  .map((b) =>
                    b.type === "text"
                      ? b.text
                      : b.type === "thinking"
                        ? ""
                        : "",
                  )
                  .join(""),
        })),
      ];

      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(key ? { Authorization: `Bearer ${key}` } : {}),
          },
          body: JSON.stringify({
            model,
            messages,
            stream: true,
            max_tokens: req.maxTokens ?? 2048,
          }),
        });
      } catch (err) {
        // Network error — yield nothing so scribe falls through to sequential.
        yield { type: "message_end", stopReason: "end_turn" };
        return;
      }

      if (!res.ok || !res.body) {
        yield { type: "message_end", stopReason: "end_turn" };
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // OpenAI SSE: "data: {...}\n\n"
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const j = JSON.parse(payload);
            const delta = j?.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length > 0) {
              yield { type: "text_delta", text: delta };
            }
          } catch {
            /* skip malformed frame */
          }
        }
      }
      yield { type: "message_end", stopReason: "end_turn" };
    },
  };
}

// ---------------------------------------------------------------------------
// Tool arg types
// ---------------------------------------------------------------------------

interface ProposeArgs {
  section: string;
  content: string;
  operation?: "append" | "update" | "create";
  rationale: string;
  cwd?: string;
}

interface ConsolidateArgs {
  model?: string;
  cwd?: string;
}

interface StatusArgs {
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function resolveCwd(explicit?: string): Promise<string> {
  return explicit ?? process.cwd();
}

async function currentGeneration(cwd: string): Promise<number> {
  const m = await loadManifest(cwd);
  return m?.generation?.number ?? 1;
}

export async function handlePropose(args: ProposeArgs): Promise<string> {
  const cwd = await resolveCwd(args.cwd);
  if (!genomeExists(cwd)) {
    return "ashlr__genome_propose error: no genome found at .ashlrcode/genome — run /ashlr-genome-init first.";
  }
  if (typeof args.section !== "string" || args.section.length === 0) {
    return "ashlr__genome_propose error: 'section' is required";
  }
  if (typeof args.content !== "string" || args.content.length === 0) {
    return "ashlr__genome_propose error: 'content' is required";
  }
  if (typeof args.rationale !== "string" || args.rationale.length === 0) {
    return "ashlr__genome_propose error: 'rationale' is required";
  }
  const operation = args.operation ?? "append";
  if (!["append", "update", "create"].includes(operation)) {
    return `ashlr__genome_propose error: invalid operation '${operation}' (expected append|update|create)`;
  }
  const generation = await currentGeneration(cwd);
  const id = await proposeUpdate(cwd, {
    section: args.section,
    content: args.content,
    operation,
    rationale: args.rationale,
    agentId: "ashlr:code",
    generation,
  });
  return `proposal ${id} queued · section ${args.section} · op ${operation} · gen ${generation}`;
}

export async function handleConsolidate(args: ConsolidateArgs): Promise<string> {
  const cwd = await resolveCwd(args.cwd);
  if (!genomeExists(cwd)) {
    return "ashlr__genome_consolidate error: no genome found at .ashlrcode/genome";
  }
  const pending = await loadPendingProposals(cwd);
  if (pending.length === 0) {
    return "ashlr__genome_consolidate · no pending proposals";
  }
  // Only construct the LLM shim if caller explicitly requested one OR env is
  // configured. When args.model is the literal string "none", skip the shim
  // and fall through to sequential-apply.
  let router: LLMSummarizer | undefined;
  if (args.model === "none") {
    router = undefined;
  } else if (args.model || process.env.ASHLR_LLM_URL || process.env.ASHLR_LLM_KEY) {
    router = buildLLMShim(args.model);
  } else {
    // No configured endpoint — sequential-apply keeps this deterministic and
    // offline. Users opt into LLM merging by passing `model` or setting env.
    router = undefined;
  }
  const result = await consolidateProposals(cwd, router);
  return `consolidated · applied ${result.applied} · skipped ${result.skipped} · from ${pending.length} pending`;
}

export function renderStatus(
  pending: GenomeProposal[],
  mutations: MutationRecord[],
  currentGen: number,
): string {
  const genMutations = mutations.filter((m) => m.generation === currentGen);
  const lines: string[] = [];
  lines.push(
    `genome · ${pending.length} pending proposal${pending.length === 1 ? "" : "s"} · ${genMutations.length} mutation${genMutations.length === 1 ? "" : "s"} this gen`,
  );
  if (pending.length > 0) {
    lines.push("  pending:");
    for (const p of pending) {
      const snippet = (p.rationale ?? "").replace(/\s+/g, " ").slice(0, 80);
      lines.push(`    ${p.id}: ${p.section} · ${p.operation} · "${snippet}"`);
    }
  }
  if (mutations.length > 0) {
    lines.push("  recent mutations:");
    const recent = mutations.slice(-5);
    for (const m of recent) {
      const when = m.timestamp.slice(0, 16).replace("T", " ");
      lines.push(`    - ${when} · ${m.section} · by ${m.agentId}`);
    }
  }
  return lines.join("\n");
}

export async function handleStatus(args: StatusArgs): Promise<string> {
  const cwd = await resolveCwd(args.cwd);
  if (!genomeExists(cwd)) {
    return "ashlr__genome_status · no genome found at .ashlrcode/genome";
  }
  const [pending, mutations, gen] = await Promise.all([
    loadPendingProposals(cwd),
    loadMutations(cwd),
    currentGeneration(cwd),
  ]);
  return renderStatus(pending, mutations, gen);
}

// ---------------------------------------------------------------------------
// MCP server wiring
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "ashlr-genome", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ashlr__genome_propose",
      description:
        "Queue a proposed update to a named genome section. Fire-and-forget: the proposal is appended to the pending queue and will be merged into the genome on the next ashlr__genome_consolidate call. Use this to record project decisions, new strategies, architectural discoveries, or lessons learned so they persist across sessions.",
      inputSchema: {
        type: "object",
        properties: {
          section: {
            type: "string",
            description:
              "Section path relative to .ashlrcode/genome, e.g. 'knowledge/decisions.md' or 'strategies/active.md'",
          },
          content: {
            type: "string",
            description:
              "Proposed content (full section replace OR appended block; see 'operation')",
          },
          operation: {
            type: "string",
            enum: ["append", "update", "create"],
            description: "How to apply the content (default: append)",
          },
          rationale: {
            type: "string",
            description: "Why this change — 1-3 sentences",
          },
          cwd: {
            type: "string",
            description: "Override working directory (default: process.cwd())",
          },
        },
        required: ["section", "content", "rationale"],
      },
    },
    {
      name: "ashlr__genome_consolidate",
      description:
        "Merge pending proposals into the genome. Without `model` (and without $ASHLR_LLM_URL) runs a deterministic sequential-apply; with an OpenAI-compatible endpoint it uses the LLM to merge conflicting proposals for the same section.",
      inputSchema: {
        type: "object",
        properties: {
          model: {
            type: "string",
            description:
              "Optional OpenAI-compatible base URL (e.g. http://localhost:1234/v1). Pass 'none' to force offline sequential-apply. If omitted, falls back to $ASHLR_LLM_URL or sequential-apply.",
          },
          cwd: {
            type: "string",
            description: "Override working directory",
          },
        },
      },
    },
    {
      name: "ashlr__genome_status",
      description:
        "Show pending proposals and recent mutations for the current genome. Compact report suitable for inline context.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description: "Override working directory",
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    if (name === "ashlr__genome_propose") {
      const text = await handlePropose(args as unknown as ProposeArgs);
      return { content: [{ type: "text", text }] };
    }
    if (name === "ashlr__genome_consolidate") {
      const text = await handleConsolidate(args as unknown as ConsolidateArgs);
      return { content: [{ type: "text", text }] };
    }
    if (name === "ashlr__genome_status") {
      const text = await handleStatus(args as unknown as StatusArgs);
      return { content: [{ type: "text", text }] };
    }
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `ashlr-genome error: ${message}` }],
      isError: true,
    };
  }
});

if (import.meta.main) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
