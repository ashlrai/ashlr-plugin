/**
 * ONNX offline summarization provider (stub).
 *
 * Intended model: Xenova/distilbart-cnn-6-6 (text summarization, ~300MB).
 * Requires:
 *   1. `onnxruntime-node` installed (optional dependency)
 *   2. Model placed at ~/.ashlr/models/distilbart/ via scripts/install-onnx-model.ts
 *
 * Current state: STUBBED — isAvailable() always returns false because no
 * bundled model is included in the v1.22 release. This provides a clean
 * integration point for a future "bundle ONNX" sprint without affecting the
 * provider dispatch loop.
 *
 * To enable:
 *   1. Run: bun run scripts/install-onnx-model.ts
 *   2. Install the optional dep: bun add onnxruntime-node
 *   3. Remove the STUB_ONNX guard below and implement inference.
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { LlmProvider, LlmSummarizeResult } from "./types.ts";

// Flip to false when a real model + onnxruntime-node are wired up.
const STUB_ONNX = true;

function home(): string {
  return process.env.HOME ?? homedir();
}

function modelDir(): string {
  return join(home(), ".ashlr", "models", "distilbart");
}

function isOnnxRuntimeInstalled(): boolean {
  try {
    // Dynamic require — not a hard dependency. Bun will throw if not installed.
    require("onnxruntime-node");
    return true;
  } catch {
    return false;
  }
}

export const onnxProvider: LlmProvider = {
  name: "onnx",

  async isAvailable(): Promise<boolean> {
    if (STUB_ONNX) return false; // stub: not yet bundled
    if (!isOnnxRuntimeInstalled()) return false;
    return existsSync(modelDir());
  },

  async summarize(
    _text: string,
    _prompt: string,
    _opts?: { maxTokens?: number },
  ): Promise<LlmSummarizeResult> {
    if (STUB_ONNX) {
      throw new Error("ONNX provider is not yet available (stub). Run scripts/install-onnx-model.ts to enable.");
    }

    // --- Inference stub (implement when onnxruntime-node is wired) ---
    // const ort = require("onnxruntime-node");
    // const session = await ort.InferenceSession.create(join(modelDir(), "model.onnx"));
    // ... tokenize, run, decode ...
    throw new Error("ONNX inference not yet implemented");
  },
};
