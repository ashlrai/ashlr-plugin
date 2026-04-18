export interface Tool {
  name: string;
  description: string;
}

export interface Skill {
  name: string;
  description: string;
}

// 14 MCP servers from plugin.json (ashlr- prefix stripped for display)
export const tools: Tool[] = [
  {
    name: "efficiency",
    description:
      "read, grep, edit, savings — snipCompact truncation + genome RAG + diff-only edits in one server.",
  },
  {
    name: "sql",
    description:
      "Query SQLite, Postgres, or any libsql database without echoing the full schema back every time.",
  },
  {
    name: "bash",
    description:
      "Long-running shell commands with live tail, start/stop control, and output capped to budget.",
  },
  {
    name: "tree",
    description:
      "Directory tree with depth and ignore controls — returns a compact structure map, not a file flood.",
  },
  {
    name: "http",
    description:
      "Authenticated HTTP requests with response truncation; no raw 50 KB JSON dumps in context.",
  },
  {
    name: "diff",
    description:
      "Unified diff between two file paths or two text blobs — surface the delta, not the full files.",
  },
  {
    name: "logs",
    description:
      "Tail and search structured log files with time-window filters and line budget.",
  },
  {
    name: "genome",
    description:
      "Propose and consolidate repo knowledge entries — the scribe loop that keeps RAG retrieval sharp.",
  },
  {
    name: "orient",
    description:
      "Entry-point overview of an unfamiliar repo: top files, recent commits, and genome summary in one call.",
  },
  {
    name: "github",
    description:
      "Create and read issues and PRs with body truncation — no 200-line diff blobs poisoning context.",
  },
  {
    name: "glob",
    description:
      "Pattern-match file paths across the repo with depth limits and gitignore awareness.",
  },
  {
    name: "webfetch",
    description:
      "Fetch a URL and return only the readable text — strips boilerplate, headers, and nav chrome.",
  },
  {
    name: "multi-edit",
    description:
      "Atomic batched edits across N files in a single call — one round-trip instead of N sequential patches.",
  },
  {
    name: "ask",
    description:
      "Pose a targeted question to a sub-agent with a minimal context slice — haiku-priced delegation.",
  },
  {
    name: "diff-semantic",
    description:
      "Semantic diff that groups changes by intent (rename, extract, refactor) rather than raw line delta.",
  },
];

// 9 skills for display
export const skills: Skill[] = [
  { name: "allow", description: "Auto-approve every ashlr tool at session start" },
  { name: "usage", description: "Per-tool call counts and token breakdown for this session" },
  { name: "errors", description: "Deduplicated MCP server error log with root-cause hints" },
  { name: "demo", description: "30-second scripted showcase of savings on your actual repo" },
  { name: "badge", description: "Generate and embed an SVG savings badge in your README" },
  { name: "legend", description: "Plain-text guide to every element in the ashlr status line" },
  { name: "dashboard", description: "Rich per-tool bar charts and 7d/30d savings history" },
  { name: "coach", description: "Proactive nudges based on your session patterns" },
  { name: "handoff", description: "Context-pack for the next session to resume cold" },
];

// Benchmark data (mirrors docs/benchmarks.json)
export const benchmarkSummary = {
  withoutAshlr: 100000,
  withAshlr: 20500,
  savingsPct: 79.5,
  label: "mean on files >= 2 KB",
};

// Benchmark rows for the chart
export const benchmarkRows = [
  { path: "genome/retriever.ts", rawTokens: 2001, ashlrTokens: 406, savedPct: 79.7 },
  { path: "genome/fitness.ts", rawTokens: 2009, ashlrTokens: 406, savedPct: 79.8 },
  { path: "genome/scribe.ts", rawTokens: 2131, ashlrTokens: 406, savedPct: 80.9 },
  { path: "genome/generations.ts", rawTokens: 2878, ashlrTokens: 406, savedPct: 85.9 },
  { path: "compression/context.ts", rawTokens: 1517, ashlrTokens: 406, savedPct: 73.2 },
];
