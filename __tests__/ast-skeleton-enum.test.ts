/**
 * ast-skeleton-enum.test.ts — enums are emitted by the chunker and rendered
 * WHOLE (members visible) in the AST skeleton, since an enum's members are its
 * signal. Other declarations stay signature-only with bodies elided.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { renderAstSkeleton } from "../servers/_ast-skeleton";
import { splitFileIntoChunks } from "../servers/_ast-chunker";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ast-enum-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SAMPLE = `import { z } from "zod";

export enum Color {
  Red = "red",
  Green = "green",
  Blue = "blue",
}

enum Status {
  Active,
  Inactive,
}

export function doThing(x: number): string {
  const doubled = x * 2;
  return String(doubled);
}
`;

describe("AST skeleton — enum coverage", () => {
  test("chunker emits enum chunks (bare + exported)", async () => {
    const file = join(dir, "sample.ts");
    await writeFile(file, SAMPLE);
    const chunks = await splitFileIntoChunks(file);
    expect(chunks).not.toBeNull();
    const enums = chunks!.filter((c) => c.kind === "enum");
    const names = enums.map((c) => c.symbol).sort();
    expect(names).toEqual(["Color", "Status"]);
  });

  test("skeleton renders enum members in full but elides function bodies", async () => {
    const file = join(dir, "sample.ts");
    await writeFile(file, SAMPLE);
    const skel = await renderAstSkeleton(file, SAMPLE);
    expect(skel).not.toBeNull();

    // Enums rendered whole — members are visible.
    expect(skel).toContain("enum Color");
    expect(skel).toContain("Red");
    expect(skel).toContain("Green");
    expect(skel).toContain("Blue");
    expect(skel).toContain("enum Status");
    expect(skel).toContain("Active");

    // Imports kept verbatim.
    expect(skel).toContain('import { z } from "zod"');

    // Function signature kept, body elided.
    expect(skel).toContain("doThing");
    expect(skel).toContain("body elided");
    expect(skel).not.toContain("x * 2");

    // Smaller than the source it summarizes is not guaranteed for tiny files,
    // but the function body must be gone — that's the contract under test.
    expect(skel).not.toContain("return String(doubled)");
  });
});
