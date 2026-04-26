#!/usr/bin/env bun
/**
 * Install the ONNX summarization model for ashlr's offline provider.
 *
 * Target model: Xenova/distilbart-cnn-6-6 (seq2seq text summarization, ~300MB)
 * Source:        https://huggingface.co/Xenova/distilbart-cnn-6-6
 * Model dir:     ~/.ashlr/models/distilbart/
 *
 * After running this script:
 *   - The ONNX provider activates automatically when ANTHROPIC_API_KEY is absent.
 *   - Or force it: ASHLR_LLM_PROVIDER=onnx
 *
 * Note: onnxruntime-node must be installed first (optional dependency):
 *   bun add onnxruntime-node   # or: npm install onnxruntime-node
 *
 * Disk space: ~300MB total (encoder ~200MB + decoder ~100MB + tokenizer files).
 * This is why the model is NOT bundled by default — run this script only if you
 * want offline summarization without an Anthropic API key.
 */

import { mkdir, writeFile } from "fs/promises";
import { existsSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

function home(): string {
  return process.env.HOME ?? homedir();
}

const MODEL_DIR = join(home(), ".ashlr", "models", "distilbart");

// Hugging Face ONNX-exported files from the Xenova/transformers.js project.
const HF_BASE = "https://huggingface.co/Xenova/distilbart-cnn-6-6/resolve/main";
const MODEL_FILES = [
  { name: "config.json",                        path: "config.json",                          sizeMB: "<1" },
  { name: "tokenizer.json",                     path: "tokenizer.json",                       sizeMB: "1"  },
  { name: "tokenizer_config.json",              path: "tokenizer_config.json",                sizeMB: "<1" },
  { name: "onnx/encoder_model.onnx",            path: "onnx/encoder_model.onnx",              sizeMB: "195" },
  { name: "onnx/decoder_model_merged.onnx",     path: "onnx/decoder_model_merged.onnx",       sizeMB: "107" },
];

function fmtBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const dir = join(dest, "..");
  await mkdir(dir, { recursive: true });
  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), 10 * 60 * 1000); // 10min per file
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    const buf = await res.arrayBuffer();
    await writeFile(dest, new Uint8Array(buf));
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  console.log("ashlr ONNX model installer");
  console.log("Model: Xenova/distilbart-cnn-6-6 (seq2seq summarization)");
  console.log(`Model directory: ${MODEL_DIR}`);
  console.log("");

  // Check onnxruntime-node
  let onnxInstalled = false;
  try {
    require("onnxruntime-node");
    console.log("✓ onnxruntime-node: installed");
    onnxInstalled = true;
  } catch {
    console.log("⚠ onnxruntime-node: NOT installed");
    console.log("");
    console.log("The ONNX provider requires onnxruntime-node. Install it with:");
    console.log("  bun add onnxruntime-node");
    console.log("  # or: npm install onnxruntime-node");
    console.log("");
    console.log("Continuing to download the model files — you can install onnxruntime-node after.");
    console.log("");
  }

  await mkdir(join(MODEL_DIR, "onnx"), { recursive: true });

  console.log(`Downloading ${MODEL_FILES.length} files from Hugging Face (~300MB total)...`);
  console.log("This will take several minutes on a typical connection.");
  console.log("");

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of MODEL_FILES) {
    const dest = join(MODEL_DIR, file.name);
    if (existsSync(dest)) {
      const size = statSync(dest).size;
      console.log(`  SKIP  ${file.name}  (${fmtBytes(size)}, already exists)`);
      skipped++;
      continue;
    }
    const url = `${HF_BASE}/${file.path}`;
    process.stdout.write(`  DL    ${file.name} (~${file.sizeMB} MB) ... `);
    try {
      await downloadFile(url, dest);
      const size = statSync(dest).size;
      console.log(`done (${fmtBytes(size)})`);
      downloaded++;
    } catch (e) {
      console.log(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
      failed++;
    }
  }

  console.log("");

  if (failed > 0) {
    console.log(`✗ ${failed} file(s) failed to download. Check your connection and retry.`);
    process.exit(1);
  }

  // Total size
  let totalBytes = 0;
  for (const file of MODEL_FILES) {
    const dest = join(MODEL_DIR, file.name);
    if (existsSync(dest)) totalBytes += statSync(dest).size;
  }

  console.log(`✓ Model installed: ${fmtBytes(totalBytes)} in ${MODEL_DIR}`);
  if (downloaded > 0) console.log(`  ${downloaded} file(s) downloaded, ${skipped} skipped`);
  console.log("");

  if (!onnxInstalled) {
    console.log("Next step: install onnxruntime-node to activate the ONNX provider:");
    console.log("  bun add onnxruntime-node");
    console.log("  # or: npm install onnxruntime-node");
    console.log("");
  } else {
    console.log("ONNX provider is ready. It activates automatically when:");
    console.log("  - ANTHROPIC_API_KEY is not set");
    console.log("  - ASHLR_LLM_URL is not set");
    console.log("");
    console.log("Or force it: ASHLR_LLM_PROVIDER=onnx");
  }

  console.log("Verify the install: bun run /ashlr-doctor");
}

main().catch((e) => {
  console.error("Fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
