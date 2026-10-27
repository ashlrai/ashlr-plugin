import product from "./product.generated.json";

// Browser-safe product facts generated from the MCP catalog and command frontmatter.
export const tools = product.tools.filter((tool) => !("enableEnv" in tool)).map((tool) => ({
  name: tool.name.replace(/^ashlr__/, "").replaceAll("_", "-"),
  description: tool.description,
  docHref: "/docs/tools",
}));

export const skills = product.commands.map((command) => ({
  name: command.name.replace(/^ashlr-/, ""),
  description: command.description,
}));

// Benchmark data (mirrors the current cross-repo headline).
export const benchmarkSummary = {
  withoutAshlr: 100000,
  withAshlr: 40500,
  savingsPct: 60,
  label: "cross-repo benchmark",
};

// Benchmark rows for the chart
export const benchmarkRows = [
  { path: "vercel/ai · TypeScript", rawTokens: 100000, ashlrTokens: 40000, savedPct: 60.0 },
  { path: "pandas · Python", rawTokens: 100000, ashlrTokens: 36700, savedPct: 63.3 },
  { path: "tokio · Rust", rawTokens: 100000, ashlrTokens: 44700, savedPct: 55.3 },
  { path: "read workflows · mean", rawTokens: 100000, ashlrTokens: 25600, savedPct: 74.4 },
  { path: "grep workflows · mean", rawTokens: 100000, ashlrTokens: 72800, savedPct: 27.2 },
];
