import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { renderReport } from "../scripts/hook-timings-report.ts";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const reference = read("docs/commands.md");

describe("command documentation coverage", () => {
  test("slash catalog matches shipped commands exactly, with working source links", () => {
    const shipped = readdirSync(join(root, "commands"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -3)).sort();
    const documented = [...reference.matchAll(/\| \[`\/([^`]+)`\]\(\.\.\/commands\/([^ )]+)\)/g)];
    expect(documented.map((match) => match[1]).sort()).toEqual(shipped);
    for (const [, name, file] of documented) {
      expect(file).toBe(`${name}.md`);
      expect(existsSync(join(root, "commands", file))).toBe(true);
    }
  });

  test("every slash command has a matching invocation and a nonempty output excerpt", () => {
    const slashSection = reference.split("## Claude Code slash commands")[1].split("## Common workflows")[0];
    expect(slashSection).toContain("| Command | Purpose | Example output |");
    const rows = slashSection.split("\n").filter((line) => line.startsWith("| [`/"));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const cells = row.split("|").map((cell) => cell.trim());
      expect(cells).toHaveLength(5);
      const name = cells[1].match(/^\[`\/([^`]+)`\]/)?.[1];
      const example = cells[3].match(/^`\/([^`]+)` → `([^`]+)`$/);
      expect(name).toBeDefined();
      expect(example).not.toBeNull();
      expect(example![1].split(" ")[0]).toBe(name ?? "");
      expect(example![2].trim().length).toBeGreaterThan(0);
    }
  });

  test("representative fixed output excerpts match their command sources", () => {
    for (const [command, excerpt] of [
      ["ashlr-brief", "ashlr-brief: standard ON. Effective on the next response."],
      ["ashlr-eco-mode", "Eco mode OFF. All behaviors restored to defaults."],
      ["ashlr-genome-loop", "ashlr genome loop: disabled"],
      ["ashlr-orchestrate", "Press y to execute, n to cancel, e to edit YAML."],
      ["ashlr-team-invite", "Expires in 7 days."],
    ]) {
      expect(reference).toContain(excerpt);
      const source = read(`commands/${command}.md`);
      expect(source.replace("<level>", "standard")).toContain(excerpt);
    }
  });

  test("each example is grounded in its command's output or instructions", () => {
    // The source anchor may be a template when the example supplies a value.
    // Keep the example alongside it so changing either side requires a review.
    const cases: Record<string, [string, string, string]> = {
      "ashlr-allow": ["scripts/install-permissions.ts", "All ashlr MCP tool entries already in allowlist. Nothing to do.", "All ashlr MCP tool entries already in allowlist. Nothing to do."],
      "ashlr-benchmark": ["commands/ashlr-benchmark.md", "mean savings on files ≥ 2KB: 42%", "mean savings on files ≥ 2KB: X%"],
      "ashlr-brief": ["commands/ashlr-brief.md", "ashlr-brief: standard ON. Effective on the next response.", "ashlr-brief: <level> ON. Effective on the next response."],
      "ashlr-budget": ["commands/ashlr-budget.md", "Budget set to 200000 tokens.", "Budget set to `<N>` tokens."],
      "ashlr-compact": ["commands/ashlr-compact.md", "less than 5 KB of stale tool output. No recompression needed yet.", "less than 5 KB of stale tool output. No recompression needed yet."],
      "ashlr-dashboard": ["scripts/savings-dashboard.ts", "no tool usage recorded yet.", "no tool usage recorded yet."],
      "ashlr-doctor": ["commands/ashlr-doctor.md", "0 warnings · 0 failures", "N warnings · M failures"],
      "ashlr-eco-mode": ["commands/ashlr-eco-mode.md", "Eco mode OFF. All behaviors restored to defaults.", "Eco mode OFF. All behaviors restored to defaults."],
      "ashlr-fleet": ["commands/ashlr-fleet.md", "/peers lists sessions in the local Locus peer registry.", "`/peers` lists sessions in the local Locus peer registry."],
      "ashlr-genome-init": ["scripts/genome-init.ts", "✓ Initialized genome at /project/.ashlrcode/genome/", "Initialized genome at ${pathStr}"],
      "ashlr-genome-keygen": ["scripts/genome-keygen.ts", "Already registered.", "Already registered."],
      "ashlr-genome-loop": ["commands/ashlr-genome-loop.md", "ashlr genome loop: disabled", "ashlr genome loop: disabled"],
      "ashlr-genome-push": ["scripts/genome-cloud-push.ts", "Pushed 5 section(s) to genome-123.", "Pushed ${payloadSections.length} section(s) to ${genomeId}."],
      "ashlr-genome-rewrap": ["scripts/genome-team-init.ts", "Wrapped 2 envelope(s). Skipped 0 member(s) without a pubkey yet.", "Wrapped ${wrapped} envelope(s). Skipped ${skipped.length} member(s) without a pubkey yet."],
      "ashlr-genome-team-init": ["scripts/genome-team-init.ts", "Team-cloud genome initialized for this repo.", "Team-cloud genome initialized for this repo."],
      "ashlr-handoff": ["scripts/savings-dashboard.ts", "Branch:      main", "Branch:      ${branch}"],
      "ashlr-help": ["commands/ashlr-help.md", "/ashlr-doctor    Under-10-second health check of your ashlr install", "/ashlr-doctor    Under-10-second health check of your ashlr install"],
      "ashlr-hook-timings": ["scripts/hook-timings-report.ts", "ashlr hook timings · last 24h · 3 records · median 12ms", "ashlr hook timings · last ${windowHours}h · ${fmtNum(totalRecords)} records · median ${fmtMs(med)}"],
      "ashlr-leaderboard": ["commands/ashlr-leaderboard.md", "Leaderboard: off (opted out)", "`off` (opted out)"],
      "ashlr-legend": ["scripts/print-legend.ts", "tokens saved in THIS terminal since the", "tokens saved in THIS terminal since the"],
      "ashlr-ollama-setup": ["scripts/ollama-setup.ts", "ollama pull llama3.2:3b", "ollama pull ${RECOMMENDED_MODELS[0].name}"],
      "ashlr-orchestrate-status": ["scripts/cli-orchestrate-status.ts", "No orchestration runs yet", "No orchestration runs yet"],
      "ashlr-orchestrate": ["commands/ashlr-orchestrate.md", "Press y to execute, n to cancel, e to edit YAML.", "Press y to execute, n to cancel, e to edit YAML."],
      "ashlr-parallelize": ["commands/ashlr-parallelize.md", "1 agents · task: explain exports", "<N> agents · task: <task>"],
      "ashlr-report-crash": ["scripts/report-crash.ts", "--dry-run: nothing uploaded.", "--dry-run: nothing uploaded."],
      "ashlr-resume": ["scripts/session-resume.ts", "No prior sessions found", "No prior sessions found"],
      "ashlr-savings": ["commands/ashlr-savings.md", "No ashlr__read/grep/edit calls yet", "No ashlr__read/grep/edit calls yet"],
      "ashlr-selftest": ["scripts/selftest.ts", "40 passed · 0 failed · 15 skipped · 0 uncovered", "${s.ok} passed · ${s.failed} failed · ${s.skipped} skipped · ${s.uncovered} uncovered"],
      "ashlr-settings": ["commands/ashlr-settings.md", "statusLine: true", '"statusLine": true'],
      "ashlr-spawn": ["commands/ashlr-spawn.md", "1 agent(s) completed", "<N> agent(s) completed"],
      "ashlr-start": ["commands/ashlr-start.md", "Wizard complete. Run /ashlr-savings any time to see your running totals", "Wizard complete. Run /ashlr-savings any time to see your running\n   totals"],
      "ashlr-status": ["commands/ashlr-status.md", "server:  ✓ reachable", "server:  ✓ reachable"],
      "ashlr-team-invite": ["commands/ashlr-team-invite.md", "✓ invite sent to alice@example.com. Expires in 7 days.", "✓ invite sent to <email>. Expires in 7 days."],
      "ashlr-tier": ["commands/ashlr-tier.md", "Phase 1: Discovery (explore / haiku)", "Phase 1: Discovery (explore / haiku)"],
      "ashlr-tour": ["commands/ashlr-tour.md", "This is what every element in your status line means", "This is what every element in your status line means"],
      "ashlr-update": ["commands/ashlr-update.md", "ashlr-plugin already up to date at abc1234.", "ashlr-plugin already up to date at <sha>."],
      "ashlr-upgrade": ["scripts/upgrade-flow.ts", "Sign in with:", "Sign in with:"],
      "goal": ["commands/goal.md", 'Usage: ashlr goal "<objective>" [--project <repo>] [--allow-cloud] [--plan-only] [--direct]', 'Usage: ashlr goal "<objective>" [--project <repo>] [--allow-cloud] [--plan-only] [--direct]'],
      "loop": ["commands/loop.md", "Any proposals filed await review in", "Any proposals filed await review in"],
    };
    const rows = [...reference.matchAll(/\| \[`\/([^`]+)`\]\([^\n]+?\| `\/[^`]+` → `([^`]+)` \|/g)];
    expect(rows.map((row) => row[1]).sort()).toEqual(Object.keys(cases).sort());
    for (const [, command, output] of rows) {
      const [path, expected, anchor] = cases[command];
      expect(output).toBe(expected);
      expect(read(path)).toContain(anchor);
    }
  });

  test("hook timings example is an illustrative excerpt of a populated report", () => {
    expect(reference).toContain("Each example is illustrative");
    const row = reference.split("\n").find((line) => line.startsWith("| [`/ashlr-hook-timings`]"));
    const excerpt = row?.match(/`\/ashlr-hook-timings` → `([^`]+)`/)?.[1];
    const report = renderReport([
      { hook: "pretooluse", calls: 3, p50: 12, p95: 15, max: 15, errorPct: 0, blockPct: 0, timeoutPct: 0 },
    ], 24, 3);
    expect(excerpt).toBeDefined();
    expect(excerpt).toBe(report.split("\n")[0]);
    expect(read("commands/ashlr-hook-timings.md")).toContain("Capture stdout and display it verbatim");
  });

  test("terminal catalog matches CLI dispatch including aliases", () => {
    const cases = [...read("scripts/cli.ts").matchAll(/^    case "([^"]+)":/gm)]
      .map((match) => match[1]);
    const documented = [...reference.matchAll(/\| `ashlr-plugin ([\w-]+)/g)]
      .map((match) => match[1]);
    const terminal = reference.split("## Claude Code slash commands")[0];
    const aliases = [...terminal.matchAll(/(?:Alias|Aliases): ([^\n]+)/g)]
      .flatMap((match) => [...match[1].matchAll(/`([^`]+)`/g)].map((alias) => alias[1]));
    expect([...documented, ...aliases].sort()).toEqual(cases.sort());
  });

  test("entry points link to the reference without a stale slash-command count", () => {
    for (const path of ["README.md", "docs/README.md"]) {
      expect(read(path)).toContain("commands.md");
      expect(read(path)).not.toMatch(/\d+ slash commands/);
      expect(read(path)).not.toContain("\u2014");
    }
    expect(reference).not.toContain("\u2014");
  });
});
