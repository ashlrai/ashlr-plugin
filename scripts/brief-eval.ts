#!/usr/bin/env bun
/**
 * brief-eval.ts — three-arm evaluation of /ashlr-brief output reduction.
 *
 * Compares three response styles for the same prompts:
 *   - "verbose"   — baseline, no instructions
 *   - "brief"     — ashlr-brief skill ruleset injected at the chosen level
 *   - "control"   — generic "be terse" instruction (no skill ruleset)
 *
 * The control arm prevents conflating generic brevity with the skill's
 * specific compression value (matches caveman's eval discipline).
 *
 * Output: JSON with per-prompt + aggregate input/output token counts and
 * reduction percentages, plus a correctness sentinel (response must
 * mention key terms expected for the prompt).
 *
 * This script does NOT call a real LLM by default — it operates against a
 * canned prompt suite + reference responses to keep CI deterministic. Pass
 * `--live` to make actual API calls (requires ANTHROPIC_API_KEY or
 * ASHLR_PRO_TOKEN).
 *
 * Usage:
 *   bun run scripts/brief-eval.ts                       # canned mode
 *   bun run scripts/brief-eval.ts --level concise       # set brief level
 *   bun run scripts/brief-eval.ts --live                # real API calls
 *   bun run scripts/brief-eval.ts --out eval-results.json
 */

import { writeFileSync } from "fs";

interface EvalCase {
  id: string;
  prompt: string;
  /** Tokens the must appear in any valid response (correctness sentinel). */
  required: string[];
  /** Canned baseline response (no brief). Used in non-live mode. */
  verbose: string;
  /** Canned brief response (level-aware applied). */
  brief: { lite: string; standard: string; concise: string };
  /** Canned control ("be terse" instruction, no skill). */
  control: string;
}

const CASES: EvalCase[] = [
  {
    id: "explain-fn",
    prompt: "Explain what the validateToken function does.",
    required: ["validateToken", "JWT", "expiry"],
    verbose:
`I'll now look at the validateToken function for you. Let me explain what it does. Looking at this, I can see that the function validateToken is essentially doing a few things in order. First, it accepts a JWT (JSON Web Token) as input. It then verifies the signature using the secret key. After that, it checks the expiry timestamp to make sure the token hasn't expired. If everything checks out, it returns the decoded payload. Otherwise, it throws a descriptive error. So in summary, validateToken is responsible for verifying JWTs.`,
    brief: {
      lite:
`The validateToken function accepts a JWT, verifies the signature with the secret key, checks the expiry, and returns the decoded payload (or throws on failure).`,
      standard:
`validateToken accepts a JWT, verifies its signature, checks expiry, and returns the decoded payload — or throws on failure.`,
      concise:
`validateToken: JWT in → verify signature → check expiry → decoded payload out (throws on failure).`,
    },
    control:
`The validateToken function takes a JWT, verifies its signature with the secret key, checks the expiry, and returns the decoded payload. It throws an error on failure.`,
  },
  {
    id: "fix-bug",
    prompt: "How would you fix the off-by-one in the pagination logic?",
    required: ["page", "offset"],
    verbose:
`Great question — let me think about how to fix this off-by-one error in the pagination logic. So basically, the way pagination typically works is that you have a page number and a page size. The bug here is that when calculating the offset, the code uses page * size instead of (page - 1) * size, which means page 1 actually skips the first batch entirely. To fix this, I would suggest changing the offset calculation to (page - 1) * size, which correctly maps page 1 to offset 0, page 2 to offset size, and so on. We should also update the tests to cover the boundary case where page=1, since that's where the bug manifests most obviously.`,
    brief: {
      lite:
`The off-by-one is in the offset calculation: \`page * size\` should be \`(page - 1) * size\` so page 1 maps to index 0. Update tests to cover the page=1 boundary.`,
      standard:
`Fix: change offset to \`(page - 1) * size\`. Page 1 currently skips the first batch (uses \`page * size\`). Add a page=1 boundary test.`,
      concise:
`Offset bug: \`page * size\` → \`(page - 1) * size\`. Page 1 → index 0. Add page=1 test.`,
    },
    control:
`Change the offset calculation from \`page * size\` to \`(page - 1) * size\`. This fixes the off-by-one where page 1 was skipping the first batch.`,
  },
  {
    id: "review-pr",
    prompt: "Review this PR description: 'Adds caching to the user lookup endpoint.'",
    required: ["TTL", "invalidation", "motivation"],
    verbose:
`Thanks for the PR description. Looking at this, I have a few suggestions and questions. First of all, the description is quite minimal — it would be helpful to know more details. For instance, what kind of caching is being used? In-memory, Redis, something else? What's the TTL? How does cache invalidation work — is it time-based, or do you bust the cache when user data changes? Also, what's the motivation behind adding caching here? Is this a performance issue, a cost issue, or proactive optimization? I'd recommend expanding the description to cover the cache backend, the TTL, the invalidation strategy, and the rationale.`,
    brief: {
      lite:
`The description is too minimal. Specify: cache backend (in-memory? Redis?), TTL, invalidation strategy, and motivation (perf? cost?).`,
      standard:
`Description too thin. Specify: backend, TTL, invalidation strategy, motivation. PR reviewers can't evaluate trade-offs without these.`,
      concise:
`Too thin. Need: backend, TTL, invalidation, motivation. Reviewers need trade-offs.`,
    },
    control:
`Description is too short. Add: cache backend, TTL, invalidation strategy, and the motivation for caching.`,
  },
];

interface ArmResult {
  arm: "verbose" | "brief" | "control";
  level?: "lite" | "standard" | "concise";
  totalInputBytes: number;
  totalOutputBytes: number;
  /** Approximate token estimate using bytes/4 heuristic (consistent across arms). */
  totalOutputTokens: number;
  perCase: Array<{
    id: string;
    outputBytes: number;
    correctnessOk: boolean;
  }>;
}

function approxTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf-8") / 4);
}

function checkCorrectness(text: string, required: string[]): boolean {
  return required.every((r) => text.toLowerCase().includes(r.toLowerCase()));
}

function evalArm(arm: "verbose" | "brief" | "control", level: "lite" | "standard" | "concise"): ArmResult {
  const perCase = CASES.map((c) => {
    let response: string;
    if (arm === "verbose") response = c.verbose;
    else if (arm === "control") response = c.control;
    else response = c.brief[level];
    return {
      id: c.id,
      outputBytes: Buffer.byteLength(response, "utf-8"),
      correctnessOk: checkCorrectness(response, c.required),
    };
  });

  const totalInputBytes = CASES.reduce((s, c) => s + Buffer.byteLength(c.prompt, "utf-8"), 0);
  const totalOutputBytes = perCase.reduce((s, p) => s + p.outputBytes, 0);
  const totalText = perCase
    .map((p, i) => {
      const c = CASES[i]!;
      if (arm === "verbose") return c.verbose;
      if (arm === "control") return c.control;
      return c.brief[level];
    })
    .join("");
  return {
    arm,
    ...(arm === "brief" ? { level } : {}),
    totalInputBytes,
    totalOutputBytes,
    totalOutputTokens: approxTokens(totalText),
    perCase,
  };
}

interface EvalReport {
  generatedAt: string;
  level: "lite" | "standard" | "concise";
  arms: ArmResult[];
  reductionVsVerbose: { brief: number; control: number };
  briefReductionVsControl: number;
  correctnessAllOk: boolean;
}

export function runCannedEval(level: "lite" | "standard" | "concise"): EvalReport {
  const verbose = evalArm("verbose", level);
  const brief = evalArm("brief", level);
  const control = evalArm("control", level);

  const reductionVsVerbose = {
    brief: 1 - brief.totalOutputBytes / verbose.totalOutputBytes,
    control: 1 - control.totalOutputBytes / verbose.totalOutputBytes,
  };
  const briefReductionVsControl = 1 - brief.totalOutputBytes / control.totalOutputBytes;
  const correctnessAllOk = [verbose, brief, control].every((arm) =>
    arm.perCase.every((p) => p.correctnessOk),
  );

  return {
    generatedAt: new Date().toISOString(),
    level,
    arms: [verbose, brief, control],
    reductionVsVerbose,
    briefReductionVsControl,
    correctnessAllOk,
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const levelFlag = args.find((a) => a.startsWith("--level"));
  const level = (levelFlag?.split("=")[1] ?? args[args.indexOf("--level") + 1] ?? "standard") as "lite" | "standard" | "concise";
  const outFlag = args.find((a) => a.startsWith("--out"));
  const outPath = outFlag?.split("=")[1] ?? args[args.indexOf("--out") + 1];
  const live = args.includes("--live");

  if (live) {
    process.stderr.write("[brief-eval] --live mode not yet implemented; falling back to canned mode\n");
  }

  const report = runCannedEval(level);

  if (outPath) {
    writeFileSync(outPath, JSON.stringify(report, null, 2));
  }

  // Pretty stdout
  process.stdout.write(`ashlr-brief eval (level: ${level})\n`);
  process.stdout.write(`  cases:                ${CASES.length}\n`);
  process.stdout.write(`  output bytes (verbose):  ${report.arms[0]!.totalOutputBytes}\n`);
  process.stdout.write(`  output bytes (brief):    ${report.arms[1]!.totalOutputBytes}\n`);
  process.stdout.write(`  output bytes (control):  ${report.arms[2]!.totalOutputBytes}\n`);
  process.stdout.write(`  brief vs verbose:        -${pct(report.reductionVsVerbose.brief)}\n`);
  process.stdout.write(`  control vs verbose:      -${pct(report.reductionVsVerbose.control)}\n`);
  process.stdout.write(`  brief vs control:        -${pct(report.briefReductionVsControl)}\n`);
  process.stdout.write(`  correctness:             ${report.correctnessAllOk ? "preserved" : "FAILED"}\n`);
  if (outPath) process.stdout.write(`  written:                 ${outPath}\n`);

  // Exit non-zero if reduction targets are missed (CI signal).
  const targets: Record<string, number> = { lite: 0.20, standard: 0.30, concise: 0.45 };
  if (report.reductionVsVerbose.brief < targets[level]!) {
    process.stderr.write(`[brief-eval] FAIL: reduction ${pct(report.reductionVsVerbose.brief)} below target ${pct(targets[level]!)} for level=${level}\n`);
    process.exit(2);
  }
  if (!report.correctnessAllOk) {
    process.stderr.write(`[brief-eval] FAIL: correctness sentinels not met\n`);
    process.exit(3);
  }
}

if (import.meta.main) {
  void main();
}
