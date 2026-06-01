/**
 * ast-skeleton-class-edge.test.ts — class member extraction handles the harder
 * TS shapes: abstract classes (which were previously not chunked at all),
 * abstract methods, getters/setters, generic/async methods, static + readonly
 * fields, and private (#) methods. Value initializers are dropped; method
 * bodies elided.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { renderAstSkeleton } from "../servers/_ast-skeleton";
import { splitFileIntoChunks } from "../servers/_ast-chunker";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ast-class-edge-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SAMPLE = `export abstract class Base<T> {
  abstract handle(input: T): Promise<void>;
  protected readonly id: string = "x";
  static VERSION = 2;

  get label(): string {
    return this.id;
  }

  set label(v: string) {
    (this as unknown as { _l: string })._l = v;
  }

  async process<R>(x: T, cb: (r: R) => void): Promise<R | null> {
    return null;
  }

  #secret(): number {
    return 42;
  }
}
`;

describe("AST skeleton — class edge cases", () => {
  test("abstract class is chunked with full member coverage", async () => {
    const file = join(dir, "base.ts");
    await writeFile(file, SAMPLE);
    const chunks = await splitFileIntoChunks(file);
    const cls = chunks!.find((c) => c.kind === "class" && c.symbol === "Base");
    expect(cls).toBeTruthy();
    const m = cls!.members!;
    expect(m).toContain("abstract handle(input: T): Promise<void>;");
    expect(m).toContain("get label(): string { … }");
    expect(m).toContain("set label(v: string) { … }");
    expect(m).toContain("async process<R>(x: T, cb: (r: R) => void): Promise<R | null> { … }");
    expect(m).toContain("#secret(): number { … }");
    // value initializers dropped from fields
    expect(m).toContain("protected readonly id: string;");
    expect(m).toContain("static VERSION;");
    expect(m.join("\n")).not.toContain("= 2");
    expect(m.join("\n")).not.toContain('= "x"');
  });

  test("skeleton renders abstract class shape, method bodies elided", async () => {
    const file = join(dir, "base.ts");
    await writeFile(file, SAMPLE);
    const skel = await renderAstSkeleton(file, SAMPLE);
    expect(skel).not.toBeNull();
    expect(skel).toContain("abstract class Base");
    expect(skel).toContain("async process<R>");
    expect(skel).toContain("abstract handle(input: T): Promise<void>");
    // bodies must not leak
    expect(skel).not.toContain("return this.id");
    expect(skel).not.toContain("return 42");
    expect(skel).not.toContain("return null");
  });
});
