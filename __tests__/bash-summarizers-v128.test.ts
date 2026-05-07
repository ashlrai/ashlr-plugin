import { describe, expect, test } from "bun:test";
import {
  summarizeCargoTest,
  summarizeCargoCheck,
  summarizeGoTest,
  summarizeTerraformPlan,
  summarizeKubectlLogs,
  summarizeKubectlDescribe,
  findSummarizer,
} from "../servers/_bash-summarizers-registry";

describe("v1.28 bash summarizers — cargo test", () => {
  test("summarizes ok run with passed/failed/ignored counts", () => {
    const stdout =
      "running 12 tests\n" +
      "test foo::bar ... ok\n" +
      "test foo::baz ... ok\n" +
      "test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n";
    const out = summarizeCargoTest(stdout);
    expect(out).toContain("cargo test");
    expect(out).toContain("12 passed");
    expect(out).toContain("0 failed");
    expect(out!.length).toBeLessThan(stdout.length);
  });

  test("captures up to 5 failure paths", () => {
    const stdout =
      "running 6 tests\n" +
      "test a::t1 ... FAILED\n" +
      "test a::t2 ... FAILED\n" +
      "test result: FAILED. 4 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out\n";
    const out = summarizeCargoTest(stdout);
    expect(out).toContain("a::t1");
    expect(out).toContain("a::t2");
    expect(out).toContain("FAILED");
  });

  test("returns null on non-cargo output", () => {
    expect(summarizeCargoTest("")).toBe(null);
    expect(summarizeCargoTest("hello world this is short")).toBe(null);
  });

  test("findSummarizer routes 'cargo test' correctly", () => {
    expect(findSummarizer("cargo test")).toBe(summarizeCargoTest);
  });
});

describe("v1.28 bash summarizers — cargo check / build / clippy", () => {
  test("summarizes errors and warnings", () => {
    const stdout =
      "  Compiling foo v0.1.0\n" +
      "warning: unused variable: `x`\n" +
      "warning: unused import: `bar`\n" +
      "error[E0308]: mismatched types\n" +
      "error: cannot find function `qux`\n" +
      "    Finished dev [unoptimized + debuginfo] target(s) in 1.23s\n";
    const out = summarizeCargoCheck(stdout);
    expect(out).toContain("cargo: 2 errors, 2 warnings");
    expect(out).toContain("mismatched types");
    expect(out).toContain("unused variable");
  });

  test("findSummarizer routes 'cargo check' / 'cargo build' / 'cargo clippy'", () => {
    expect(findSummarizer("cargo check")).toBe(summarizeCargoCheck);
    expect(findSummarizer("cargo build")).toBe(summarizeCargoCheck);
    expect(findSummarizer("cargo clippy")).toBe(summarizeCargoCheck);
  });
});

describe("v1.28 bash summarizers — go test", () => {
  test("pivots PASS/FAIL/SKIP across packages", () => {
    const stdout =
      "=== RUN   TestFoo\n" +
      "--- PASS: TestFoo (0.00s)\n" +
      "=== RUN   TestBar\n" +
      "--- FAIL: TestBar (0.01s)\n" +
      "    foo_test.go:42: expected 1, got 0\n" +
      "=== RUN   TestBaz\n" +
      "--- SKIP: TestBaz (0.00s)\n" +
      "FAIL\n" +
      "exit status 1\n" +
      "FAIL example.com/pkg 0.123s\n";
    const out = summarizeGoTest(stdout);
    expect(out).toContain("go test:");
    expect(out).toContain("FAIL");
    expect(out).toContain("PASS");
    expect(out).toContain("TestBar");
  });

  test("findSummarizer routes 'go test'", () => {
    expect(findSummarizer("go test ./...")).toBe(summarizeGoTest);
  });
});

describe("v1.28 bash summarizers — terraform plan", () => {
  test("extracts the Plan: line and resource actions", () => {
    const stdout =
      "Refreshing Terraform state in-memory prior to plan...\n" +
      "  # aws_s3_bucket.logs will be created\n" +
      "  # aws_cloudfront_distribution.cdn will be updated\n" +
      "  # aws_iam_role.legacy will be destroyed\n" +
      "Plan: 1 to add, 1 to change, 1 to destroy.\n";
    const out = summarizeTerraformPlan(stdout);
    expect(out).toContain("Plan: 1 to add");
    expect(out).toContain("aws_s3_bucket.logs");
    expect(out).toContain("created");
    expect(out).toContain("destroyed");
  });

  test("findSummarizer routes 'terraform plan' and 'tofu plan'", () => {
    expect(findSummarizer("terraform plan")).toBe(summarizeTerraformPlan);
    expect(findSummarizer("tofu plan")).toBe(summarizeTerraformPlan);
  });
});

describe("v1.28 bash summarizers — kubectl logs", () => {
  test("returns head + tail when over 80 lines", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    lines[120] = "ERROR: connection refused";
    const stdout = lines.join("\n");
    const out = summarizeKubectlLogs(stdout);
    expect(out).toContain("line 1");
    expect(out).toContain("line 200");
    expect(out).toContain("connection refused");
    expect(out).toContain("200 log lines total");
    expect(out!.length).toBeLessThan(stdout.length);
  });

  test("returns null for short output", () => {
    expect(summarizeKubectlLogs("ten\nlines\nonly")).toBe(null);
  });

  test("findSummarizer routes 'kubectl logs' and 'k logs'", () => {
    expect(findSummarizer("kubectl logs my-pod")).toBe(summarizeKubectlLogs);
    expect(findSummarizer("k logs my-pod")).toBe(summarizeKubectlLogs);
  });
});

describe("v1.28 bash summarizers — kubectl describe", () => {
  test("extracts header + Events section", () => {
    const lines: string[] = [];
    lines.push("Name:         my-pod");
    lines.push("Namespace:    default");
    lines.push("Priority:     0");
    for (let i = 0; i < 50; i++) lines.push(`Spec line ${i}`);
    lines.push("Events:");
    lines.push("  Type    Reason     Age   From     Message");
    lines.push("  ----    ------     ----  ----     -------");
    lines.push("  Normal  Scheduled  3m    default-scheduler  Successfully assigned");
    const stdout = lines.join("\n");
    const out = summarizeKubectlDescribe(stdout);
    expect(out).toContain("my-pod");
    expect(out).toContain("Events:");
    expect(out).toContain("Successfully assigned");
    expect(out!.length).toBeLessThan(stdout.length);
  });

  test("findSummarizer routes 'kubectl describe' and 'k describe'", () => {
    expect(findSummarizer("kubectl describe pod foo")).toBe(summarizeKubectlDescribe);
    expect(findSummarizer("k describe pod foo")).toBe(summarizeKubectlDescribe);
  });
});
