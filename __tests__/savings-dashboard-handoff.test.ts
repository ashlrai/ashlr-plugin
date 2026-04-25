/**
 * Unit tests for the renderHandoff() helper used by /ashlr-handoff.
 *
 * The handoff is plain ASCII so it pastes cleanly into a fresh session;
 * these tests cover formatting and the no-data fallbacks. Real git state
 * and session-log shape are exercised via integration when the script
 * runs end-to-end on a real repo.
 */

import { describe, expect, test } from "bun:test";
import { renderHandoff } from "../scripts/savings-dashboard";

describe("renderHandoff", () => {
  test("renders a header and the working dir line", () => {
    const out = renderHandoff(null, { cwd: "/tmp/test-repo" });
    expect(out).toContain("# ashlr handoff — paste into next session");
    expect(out).toContain("Working dir: /tmp/test-repo");
  });

  test("includes session line when session stats are present", () => {
    const out = renderHandoff(
      { session: { calls: 17, tokensSaved: 12345 } },
      { cwd: "/x" },
    );
    expect(out).toContain("Session:     17 calls");
    expect(out).toContain("12,345 tokens saved");
  });

  test("renders top tools sorted by call count, top 5", () => {
    const out = renderHandoff(
      {
        session: {
          calls: 100,
          tokensSaved: 5000,
          byTool: {
            ashlr__read: { calls: 50, tokensSaved: 4000 },
            ashlr__grep: { calls: 30, tokensSaved: 800 },
            ashlr__edit: { calls: 10, tokensSaved: 200 },
            ashlr__bash: { calls: 5, tokensSaved: 0 },
            ashlr__test: { calls: 3, tokensSaved: 0 },
            ashlr__sql:  { calls: 2, tokensSaved: 0 },
          },
        },
      },
      { cwd: "/x" },
    );
    expect(out).toContain("Top tools this session:");
    expect(out).toContain("ashlr__read");
    expect(out).toContain("ashlr__grep");
    // 6th tool should be cut off (top 5 only)
    expect(out).not.toContain("ashlr__sql");
    // Ordering: read appears before grep
    const readIdx = out.indexOf("ashlr__read");
    const grepIdx = out.indexOf("ashlr__grep");
    expect(readIdx).toBeLessThan(grepIdx);
  });

  test("output is plain ASCII — no ANSI escape codes (paste-safe)", () => {
    const out = renderHandoff(
      { session: { calls: 1, tokensSaved: 1, byTool: { ashlr__read: { calls: 1 } } } },
      { cwd: "/x" },
    );
    expect(out).not.toMatch(/\x1b\[/);
  });

  test("ends with a tip pointing users at the rich dashboard", () => {
    const out = renderHandoff(null, { cwd: "/x" });
    expect(out).toContain("Tip: run /ashlr-savings or /ashlr-dashboard");
  });
});
