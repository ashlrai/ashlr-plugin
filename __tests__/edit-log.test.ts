/**
 * edit-log.test.ts — pins the ashlr__flush drain contract.
 *
 * servers/_edit-log.ts is the process-wide "what did I just write?" log that
 * edit-server appends to and flush-server drains for its batch summary. The
 * drain-must-empty invariant is what keeps repeated ashlr__flush calls from
 * double-counting edits, and nothing executed this module directly.
 */
import { describe, expect, test } from "bun:test";
import { appendEdit, drainEdits } from "../servers/_edit-log.ts";

describe("edit log", () => {
  test("drain returns appended entries in order and empties the log", () => {
    appendEdit({ relPath: "a.ts", hunksApplied: 1 });
    appendEdit({ relPath: "b.ts", hunksApplied: 3 });

    expect(drainEdits()).toEqual([
      { relPath: "a.ts", hunksApplied: 1 },
      { relPath: "b.ts", hunksApplied: 3 },
    ]);
    // The second drain sees nothing — flush never double-reports.
    expect(drainEdits()).toEqual([]);
  });

  test("an empty log drains to an empty array", () => {
    expect(drainEdits()).toEqual([]);
  });
});
