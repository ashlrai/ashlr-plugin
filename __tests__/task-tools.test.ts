/**
 * Tests for ashlr__task_list and ashlr__task_get.
 *
 * No native subprocess calls are made. Tests exercise processTaskListResults
 * and processTaskGetResult — the pure data-transformation pipelines.
 */

import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock recordSavingAccurate before importing the server module.
// ---------------------------------------------------------------------------
import * as accounting from "../servers/_accounting";

let savingCalls: Array<{ rawBytes: number; compactBytes: number; toolName: string; cacheHit: boolean }> = [];

const recordSavingAccurateSpy = spyOn(accounting, "recordSavingAccurate").mockImplementation(async (opts) => {
  savingCalls.push(opts);
});

// CI-test-isolation fix: bun's spyOn patches the module global. Without
// restoring on suite teardown, this mock leaks into other test files that
// import _accounting (test ordering varies between local and CI).
afterAll(() => {
  recordSavingAccurateSpy.mockRestore();
});

import { processTaskListResults, processTaskGetResult } from "../servers/task-server-handlers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTask(overrides: {
  id?: string;
  status?: string;
  subject?: string;
  owner?: string;
  description?: string;
  createdAt?: string;
} = {}) {
  const now = new Date(Date.now() - 30 * 60_000).toISOString(); // 30 min ago
  return {
    id: overrides.id ?? "task-001",
    status: overrides.status ?? "open",
    subject: overrides.subject ?? "Fix the bug",
    owner: overrides.owner ?? "alice",
    description: overrides.description ?? "Short description.",
    createdAt: overrides.createdAt ?? now,
  };
}

// ---------------------------------------------------------------------------
// processTaskListResults
// ---------------------------------------------------------------------------

beforeEach(() => {
  savingCalls = [];
  recordSavingAccurateSpy.mockClear();
});

describe("processTaskListResults — basic", () => {
  test("returns all tasks when no filters applied", async () => {
    const tasks = [makeTask({ id: "1" }), makeTask({ id: "2" }), makeTask({ id: "3" })];
    const out = await processTaskListResults(tasks);
    expect(out.tasks).toHaveLength(3);
    expect(out.totalCount).toBe(3);
    expect(out.droppedCount).toBe(0);
  });

  test("compact rows have the expected shape", async () => {
    const tasks = [makeTask({ id: "abc", status: "open", subject: "Do a thing", owner: "bob" })];
    const out = await processTaskListResults(tasks);
    const row = out.tasks[0]!;
    expect(row.taskId).toBe("abc");
    expect(row.status).toBe("open");
    expect(row.subject).toBe("Do a thing");
    expect(typeof row.ageMin).toBe("number");
    expect(row.ageMin).toBeGreaterThanOrEqual(0);
  });

  test("recordSavingAccurate is called once with toolName=ashlr__task_list", async () => {
    await processTaskListResults([makeTask()]);
    expect(savingCalls).toHaveLength(1);
    expect(savingCalls[0]!.toolName).toBe("ashlr__task_list");
    expect(savingCalls[0]!.cacheHit).toBe(false);
  });
});

describe("processTaskListResults — filter by status", () => {
  test("filters to only open tasks", async () => {
    const tasks = [
      makeTask({ id: "1", status: "open" }),
      makeTask({ id: "2", status: "closed" }),
      makeTask({ id: "3", status: "open" }),
    ];
    const out = await processTaskListResults(tasks, { status: "open" });
    expect(out.tasks).toHaveLength(2);
    expect(out.tasks.every((t) => t.status === "open")).toBe(true);
    expect(out.totalCount).toBe(2);
  });

  test("case-insensitive status filter", async () => {
    const tasks = [makeTask({ status: "OPEN" }), makeTask({ status: "Closed" })];
    const out = await processTaskListResults(tasks, { status: "open" });
    expect(out.tasks).toHaveLength(1);
  });

  test("filter by owner", async () => {
    const tasks = [
      makeTask({ id: "1", owner: "alice" }),
      makeTask({ id: "2", owner: "bob" }),
      makeTask({ id: "3", owner: "Alice" }), // case variant
    ];
    const out = await processTaskListResults(tasks, { owner: "alice" });
    expect(out.tasks).toHaveLength(2);
  });
});

describe("processTaskListResults — limit", () => {
  test("limits output to the specified count", async () => {
    const tasks = Array.from({ length: 50 }, (_, i) => makeTask({ id: String(i) }));
    const out = await processTaskListResults(tasks, { limit: 10 });
    expect(out.tasks).toHaveLength(10);
    expect(out.totalCount).toBe(50);
    expect(out.droppedCount).toBe(40);
  });

  test("default limit is 30", async () => {
    const tasks = Array.from({ length: 40 }, (_, i) => makeTask({ id: String(i) }));
    const out = await processTaskListResults(tasks);
    expect(out.tasks).toHaveLength(30);
    expect(out.droppedCount).toBe(10);
  });
});

describe("processTaskListResults — subject truncation", () => {
  test("subject truncated at 80 chars", async () => {
    const longSubject = "a".repeat(200);
    const tasks = [makeTask({ subject: longSubject })];
    const out = await processTaskListResults(tasks);
    expect(out.tasks[0]!.subject.length).toBeLessThanOrEqual(80);
  });
});

// ---------------------------------------------------------------------------
// processTaskGetResult
// ---------------------------------------------------------------------------

describe("processTaskGetResult — basic", () => {
  test("returns compact task view for short description", async () => {
    const task = makeTask({ id: "t1", status: "open", subject: "Fix bug", description: "Short." });
    const out = await processTaskGetResult(task);
    expect(out.taskId).toBe("t1");
    expect(out.status).toBe("open");
    expect(out.subject).toBe("Fix bug");
    expect(out.descriptionCompact).toBe("Short.");
    expect(out.fullLength).toBe("Short.".length);
  });

  test("recordSavingAccurate is called with toolName=ashlr__task_get", async () => {
    await processTaskGetResult(makeTask());
    expect(savingCalls).toHaveLength(1);
    expect(savingCalls[0]!.toolName).toBe("ashlr__task_get");
    expect(savingCalls[0]!.cacheHit).toBe(false);
  });
});

describe("processTaskGetResult — description truncation", () => {
  test("description > 2KB is snipCompacted", async () => {
    const longDesc = "word ".repeat(1000); // ~5000 chars
    const task = makeTask({ description: longDesc });
    const out = await processTaskGetResult(task);
    expect(out.fullLength).toBe(longDesc.length);
    expect(out.descriptionCompact.length).toBeLessThan(longDesc.length);
    expect(out.descriptionCompact).toContain("chars elided");
  });

  test("description exactly at 2KB is not snipped", async () => {
    const desc = "x".repeat(2048);
    const task = makeTask({ description: desc });
    const out = await processTaskGetResult(task);
    expect(out.descriptionCompact).toBe(desc);
    expect(out.descriptionCompact).not.toContain("elided");
  });

  test("description just over 2KB is snipped", async () => {
    const desc = "y".repeat(2049);
    const task = makeTask({ description: desc });
    const out = await processTaskGetResult(task);
    expect(out.descriptionCompact).toContain("elided");
    expect(out.fullLength).toBe(2049);
  });
});

describe("processTaskGetResult — savings accounting", () => {
  test("rawBytes > compactBytes when description is large", async () => {
    const task = makeTask({ description: "z".repeat(5000) });
    await processTaskGetResult(task);
    expect(savingCalls[0]!.rawBytes).toBeGreaterThan(savingCalls[0]!.compactBytes);
  });
});
