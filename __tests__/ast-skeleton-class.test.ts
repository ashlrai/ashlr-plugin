/**
 * ast-skeleton-class.test.ts — class chunks expose their MEMBER signatures
 * (method headers + fields) in the AST skeleton, with method bodies elided.
 * A class skeleton should show its shape, not `class Foo { …elided }`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { renderAstSkeleton } from "../servers/_ast-skeleton";
import { splitFileIntoChunks } from "../servers/_ast-chunker";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ast-class-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SAMPLE = `export class PaymentService {
  private apiKey: string;
  count = 0;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async charge(amount: number): Promise<boolean> {
    const ok = await this.validate(amount);
    return ok;
  }

  get total(): number {
    return this.count * 100;
  }

  static create(): PaymentService {
    return new PaymentService("x");
  }
}
`;

describe("AST skeleton — class member signatures", () => {
  test("chunker attaches member signatures to the class chunk", async () => {
    const file = join(dir, "svc.ts");
    await writeFile(file, SAMPLE);
    const chunks = await splitFileIntoChunks(file);
    const cls = chunks!.find((c) => c.kind === "class" && c.symbol === "PaymentService");
    expect(cls).toBeTruthy();
    expect(cls!.members).toBeDefined();
    const joined = cls!.members!.join("\n");
    expect(joined).toContain("constructor(apiKey: string)");
    expect(joined).toContain("charge(amount: number): Promise<boolean>");
    expect(joined).toContain("get total(): number");
    expect(joined).toContain("static create(): PaymentService");
    // method bodies are elided
    expect(joined).toContain("{ … }");
    expect(joined).not.toContain("this.apiKey = apiKey");
  });

  test("skeleton renders class shape: member signatures kept, bodies elided", async () => {
    const file = join(dir, "svc.ts");
    await writeFile(file, SAMPLE);
    const skel = await renderAstSkeleton(file, SAMPLE);
    expect(skel).not.toBeNull();

    expect(skel).toContain("class PaymentService");
    expect(skel).toContain("charge(amount: number): Promise<boolean>");
    expect(skel).toContain("get total(): number");
    expect(skel).toContain("static create(): PaymentService");
    // field signatures present
    expect(skel).toContain("apiKey: string");

    // method bodies must NOT appear
    expect(skel).not.toContain("await this.validate(amount)");
    expect(skel).not.toContain("this.count * 100");
    expect(skel).not.toContain('new PaymentService("x")');
  });
});
