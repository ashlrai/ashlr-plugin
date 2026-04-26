#!/usr/bin/env bun
/**
 * Install the ONNX summarization model for ashlr's offline provider.
 *
 * Target model: Xenova/distilbart-cnn-6-6 (text summarization, ~300MB)
 * Source: https://huggingface.co/Xenova/distilbart-cnn-6-6
 *
 * What this script does:
 *   1. Creates ~/.ashlr/models/distilbart/
 *   2. Downloads the ONNX model file from Hugging Face
 *   3. Downloads the tokenizer files needed for inference
 *
 * Prerequisites:
 *   - onnxruntime-node installed: bun add onnxruntime-node
 *     (or: npm install onnxruntime-node)
 *
 * After running this script, set:
 *   ASHLR_LLM_PROVIDER=onnx
 * or leave it at "auto" — the ONNX provider will be selected automatically
 * when onnxruntime-node is installed and the model directory exists.
 *
 * NOTE: The ONNX provider is currently stubbed in servers/_llm-providers/onnx.ts.
 * This script downloads the model in preparation for a future sprint that will
 * implement the inference pipeline. Setting ASHLR_LLM_PROVIDER=onnx today
 * will fall back to the next available provider.
 */

import { mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

function home(): string {
  return process.env.HOME ?? homedir();
}

const MODEL_DIR = join(home(), ".ashlr", "models", "distilbart");

// Hugging Face model files for Xenova/distilbart-cnn-6-6
// These are the ONNX-exported versions from the Xenova/transformers.js project.
const HF_BASE = "https://huggingface.co/Xenova/distilbart-cnn-6-6/resolve/main";
const MODEL_FILES = [
  { name: "config.json",          path: "config.json" },
  { name: "tokenizer.json",       path: "tokenizer.json" },
  { name: "tokenizer_config.json",path: "tokenizer_config.json" },
  { name: "onnx/encoder_model.onnx",       path: "onnx/encoder_model.onnx" },
  { name: "onnx/decoder_model_merged.onnx",path: "onnx/decoder_model_merged.onnx" },
];

async function downloadFile(url: string, dest: string): Promise<void> {
  await mkdir(join(dest, ".."), { recursive: true }).catch(() => {});
  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), 5 * 60 * 1000); // 5min per file
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const buf = await res.arrayBuffer();
    await writeFile(dest, new Uint8Array(buf));
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  console.log("ashlr ONNX model installer");
  console.log(`Model directory: ${MODEL_DIR}`);
  console.log("");

  // Check onnxruntime-node
  try {
    require("onnxruntime-node");
    console.log("onnxruntime-node: installed");
  } catch {
    console.log("onnxruntime-node: NOT installed");
    console.log("");
    console.log("Install it first:");
    console.log("  bun add onnxruntime-node");
    console.log("  # or: npm install onnxruntime-node");
    console.log("");
    console.log("Then re-run this script.");
    process.exit(1);
  }

  await mkdir(join(MODEL_DIR, "onnx"), { recursive: true });

  console.log(`Downloading ${MODEL_FILES.length} files from Hugging Face...`);
  console.log("(encoder_model.onnx ~200MB, decoder_model_merged.onnx ~100MB)");
  console.log("");

  let failed = 0;
  for (const file of MODEL_FILES) {
    const dest = join(MODEL_DIR, file.name);
    if (existsSync(dest)) {
      console.log(`  SKIP  ${file.name}  (already exists)`);
      continue;
    }
    const url = `${HF_BASE}/${file.path}`;
    process.stdout.write(`  DL    ${file.name} ... `);
    try {
      await downloadFile(url, dest);
      console.log("done");
    } catch (e) {
      console.log(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
      failed++;
    }
  }

  console.log("");
  if (failed > 0) {
    console.log(`${failed} file(s) failed to download. Check your internet connection and retry.`);
    process.exit(1);
  }

  console.log("Model installed successfully.");
  console.log("");
  console.log("NOTE: The ONNX inference pipeline is not yet implemented in this release.");
  console.log("The model files are in place for the upcoming ONNX sprint.");
  console.log("Today, ashlr will use Anthropic or local LLM providers instead.");
  console.log("");
  console.log("To verify the model directory:");
  console.log(`  ls ${MODEL_DIR}/onnx/`);
}

main().catch((e) => {
  console.error("Fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
