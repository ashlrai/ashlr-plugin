/**
 * ONNX offline summarization provider.
 *
 * Model: Xenova/distilbart-cnn-6-6 (seq2seq summarization, ~300MB)
 * Download: bun run install-onnx-model
 * Model dir: ~/.ashlr/models/distilbart/
 *
 * Requires onnxruntime-node (optional dependency):
 *   bun add onnxruntime-node  # or: npm install onnxruntime-node
 *
 * Architecture: encoder-decoder (seq2seq). We run the encoder once, then
 * autoregressively decode with greedy search until EOS or max_new_tokens.
 *
 * Tokenizer: BPE via a minimal implementation that covers the distilbart
 * vocabulary. The full tokenizer.json is loaded from the model directory so
 * we don't bundle vocab files at install time.
 */

import { existsSync, statSync } from "fs";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import type { LlmProvider, LlmSummarizeResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function home(): string {
  return process.env.HOME ?? homedir();
}

export function modelDir(): string {
  return join(home(), ".ashlr", "models", "distilbart");
}

export function modelFiles() {
  const base = modelDir();
  return {
    encoderOnnx: join(base, "onnx", "encoder_model.onnx"),
    decoderOnnx: join(base, "onnx", "decoder_model_merged.onnx"),
    tokenizerJson: join(base, "tokenizer.json"),
    configJson: join(base, "config.json"),
  };
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

function isOnnxRuntimeInstalled(): boolean {
  try {
    require("onnxruntime-node");
    return true;
  } catch {
    return false;
  }
}

export function isModelPresent(): boolean {
  const files = modelFiles();
  return (
    existsSync(files.encoderOnnx) &&
    existsSync(files.decoderOnnx) &&
    existsSync(files.tokenizerJson)
  );
}

/** Returns combined size of ONNX model files in bytes, or null if not present. */
export function modelSizeBytes(): number | null {
  const files = modelFiles();
  const paths = [files.encoderOnnx, files.decoderOnnx, files.tokenizerJson, files.configJson];
  let total = 0;
  for (const p of paths) {
    if (!existsSync(p)) return null;
    try {
      total += statSync(p).size;
    } catch {
      return null;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Minimal BPE tokenizer (loads vocab from tokenizer.json)
// ---------------------------------------------------------------------------

interface TokenizerData {
  model?: {
    vocab?: Record<string, number>;
    merges?: string[];
  };
  added_tokens?: Array<{ id: number; content: string }>;
}

interface Tokenizer {
  encode(text: string): number[];
  decode(ids: number[]): string;
  eosId: number;
  bosId: number;
  padId: number;
}

let _tokenizerCache: Tokenizer | null = null;

async function loadTokenizer(): Promise<Tokenizer> {
  if (_tokenizerCache) return _tokenizerCache;

  const raw = await readFile(modelFiles().tokenizerJson, "utf-8");
  const data = JSON.parse(raw) as TokenizerData;

  const vocab: Record<string, number> = data.model?.vocab ?? {};
  const merges: string[] = data.model?.merges ?? [];
  const idToToken: Record<number, string> = {};
  for (const [tok, id] of Object.entries(vocab)) {
    idToToken[id] = tok;
  }

  // BPE merge rules as a priority map: merge_pair -> rank
  const mergeRanks: Map<string, number> = new Map();
  for (let i = 0; i < merges.length; i++) {
    mergeRanks.set(merges[i], i);
  }

  // Resolve special tokens from added_tokens
  function findSpecialId(content: string): number {
    const entry = data.added_tokens?.find((t) => t.content === content);
    if (entry) return entry.id;
    return vocab[content] ?? -1;
  }

  const eosId = findSpecialId("</s>");
  const bosId = findSpecialId("<s>");
  const padId = vocab["<pad>"] ?? eosId;

  // Byte-level BPE pre-tokenization (GPT-2 style used by distilbart/BART)
  const BYTES_TO_UNICODE: Record<number, string> = (() => {
    const bs: number[] = [];
    const cs: number[] = [];
    for (let i = "!".charCodeAt(0); i <= "~".charCodeAt(0); i++) { bs.push(i); cs.push(i); }
    for (let i = "¡".charCodeAt(0); i <= "¬".charCodeAt(0); i++) { bs.push(i); cs.push(i); }
    for (let i = "®".charCodeAt(0); i <= "ÿ".charCodeAt(0); i++) { bs.push(i); cs.push(i); }
    let n = 0;
    for (let b = 0; b < 256; b++) {
      if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++; }
    }
    const map: Record<number, string> = {};
    for (let i = 0; i < bs.length; i++) map[bs[i]] = String.fromCodePoint(cs[i]);
    return map;
  })();

  function bytesToUnicode(text: string): string {
    const bytes = new TextEncoder().encode(text);
    return Array.from(bytes).map((b) => BYTES_TO_UNICODE[b] ?? String.fromCodePoint(b)).join("");
  }

  function bpeEncode(text: string): number[] {
    // Pre-tokenize: split on whitespace preserving spaces at start of word (GPT-2 style)
    const pattern = /\s?\S+/g;
    const words = text.match(pattern) ?? [];
    const allIds: number[] = [];

    for (const word of words) {
      const mapped = bytesToUnicode(word);
      let chars = Array.from(mapped);

      while (chars.length > 1) {
        let bestRank = Infinity;
        let bestIdx = -1;
        for (let i = 0; i < chars.length - 1; i++) {
          const pair = chars[i] + " " + chars[i + 1];
          const rank = mergeRanks.get(pair) ?? Infinity;
          if (rank < bestRank) { bestRank = rank; bestIdx = i; }
        }
        if (bestIdx === -1) break;
        const merged = chars[bestIdx] + chars[bestIdx + 1];
        chars = [...chars.slice(0, bestIdx), merged, ...chars.slice(bestIdx + 2)];
      }

      for (const tok of chars) {
        const id = vocab[tok];
        if (id !== undefined) allIds.push(id);
      }
    }

    return allIds;
  }

  function decode(ids: number[]): string {
    // Reverse the byte-level encoding
    const unicodeToBytes: Record<string, number> = {};
    for (const [b, u] of Object.entries(BYTES_TO_UNICODE)) {
      unicodeToBytes[u] = Number(b);
    }

    let result = "";
    for (const id of ids) {
      const tok = idToToken[id];
      if (!tok || tok === "</s>" || tok === "<s>" || tok === "<pad>") continue;
      // Decode unicode-escaped bytes back to UTF-8
      const bytes: number[] = [];
      for (const ch of tok) {
        const byte = unicodeToBytes[ch];
        if (byte !== undefined) bytes.push(byte);
        else bytes.push(...new TextEncoder().encode(ch));
      }
      result += new TextDecoder().decode(new Uint8Array(bytes));
    }
    return result;
  }

  _tokenizerCache = {
    encode(text: string): number[] {
      // Add BOS token for BART-style models
      const ids = bpeEncode(text);
      // Prepend BOS, append EOS
      return bosId >= 0 ? [bosId, ...ids, eosId] : [...ids, eosId];
    },
    decode,
    eosId,
    bosId,
    padId,
  };

  return _tokenizerCache;
}

/** Reset tokenizer cache (for testing). */
export function _resetTokenizerCache(): void {
  _tokenizerCache = null;
}

// ---------------------------------------------------------------------------
// ONNX inference
// ---------------------------------------------------------------------------

const MAX_INPUT_TOKENS = 512;
const MAX_NEW_TOKENS = 128;

// ort types as seen at runtime — typed as any since onnxruntime-node is optional
// and not installed during typecheck. The shapes are stable across ort 1.x/2.x.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OrtModule = any;

async function runInference(text: string): Promise<string> {
  // Dynamic require — onnxruntime-node is an optional dependency.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ort: OrtModule = require("onnxruntime-node");
  const tokenizer = await loadTokenizer();
  const files = modelFiles();

  // Encode + truncate input
  let inputIds = tokenizer.encode(text);
  if (inputIds.length > MAX_INPUT_TOKENS) {
    inputIds = inputIds.slice(0, MAX_INPUT_TOKENS - 1);
    inputIds.push(tokenizer.eosId);
  }

  const seqLen = inputIds.length;
  const inputTensor = new ort.Tensor(
    "int64",
    BigInt64Array.from(inputIds.map((x: number) => BigInt(x))),
    [1, seqLen],
  );
  const attentionMask = new ort.Tensor(
    "int64",
    BigInt64Array.from(new Array(seqLen).fill(1n)),
    [1, seqLen],
  );

  // Run encoder
  const encoder = await ort.InferenceSession.create(files.encoderOnnx, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "basic",
  });

  const encoderOut = await encoder.run({
    input_ids: inputTensor,
    attention_mask: attentionMask,
  });

  const encoderHidden = encoderOut["last_hidden_state"];
  await encoder.release();

  // Greedy decode with the decoder_model_merged (handles initial + cached steps)
  const decoder = await ort.InferenceSession.create(files.decoderOnnx, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "basic",
  });

  const decoderIds: number[] = [tokenizer.bosId >= 0 ? tokenizer.bosId : 2]; // 2 = <s> for BART
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pastKeyValues: Record<string, any> = {};

  for (let step = 0; step < MAX_NEW_TOKENS; step++) {
    const lastId = decoderIds[decoderIds.length - 1];
    const decInputIds = new ort.Tensor(
      "int64",
      BigInt64Array.from([BigInt(lastId)]),
      [1, 1],
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const feeds: Record<string, any> = {
      input_ids: decInputIds,
      encoder_hidden_states: encoderHidden,
      encoder_attention_mask: attentionMask,
    };

    // On step 0, use_cache_branch = false; subsequent steps = true
    const useCacheBranch = new ort.Tensor("bool", [step > 0], [1]);
    feeds["use_cache_branch"] = useCacheBranch;

    // Inject past key values on step > 0
    for (const [k, v] of Object.entries(pastKeyValues)) {
      feeds[k] = v;
    }

    const out = await decoder.run(feeds);

    // Logits: [1, 1, vocab_size] → argmax
    const logits = out["logits"];
    const logitData = logits.data as Float32Array;
    const vocabSize = logits.dims[2];
    let bestId = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < vocabSize; i++) {
      if (logitData[i] > bestVal) { bestVal = logitData[i]; bestId = i; }
    }

    // Collect new past key values for next step
    pastKeyValues = {};
    for (const [k, v] of Object.entries(out)) {
      if (k.startsWith("present.")) pastKeyValues[k.replace("present.", "past_key_values.")] = v;
    }

    if (bestId === tokenizer.eosId) break;
    decoderIds.push(bestId);
  }

  await decoder.release();

  // Decode (skip the initial BOS token)
  return tokenizer.decode(decoderIds.slice(1));
}

// ---------------------------------------------------------------------------
// Provider export
// ---------------------------------------------------------------------------

export const onnxProvider: LlmProvider = {
  name: "onnx",

  async isAvailable(): Promise<boolean> {
    if (!isOnnxRuntimeInstalled()) return false;
    return isModelPresent();
  },

  async summarize(
    text: string,
    _prompt: string,
    _opts?: { maxTokens?: number },
  ): Promise<LlmSummarizeResult> {
    if (!isOnnxRuntimeInstalled()) {
      throw new Error(
        "ONNX provider: onnxruntime-node not installed. " +
        "Run: bun add onnxruntime-node (or: npm install onnxruntime-node)",
      );
    }
    if (!isModelPresent()) {
      throw new Error(
        "ONNX provider: model not found at " + modelDir() + ". " +
        "Run: bun run install-onnx-model",
      );
    }

    const t0 = Date.now();

    // Truncate input text to avoid very slow inference on huge inputs.
    // The model accepts up to 1024 tokens; we aim for ~2000 chars as a heuristic.
    const truncated = text.length > 4000 ? text.slice(0, 4000) : text;

    const output = await runInference(truncated);
    const latencyMs = Date.now() - t0;

    // Token count approximation (no exact count without running the tokenizer twice)
    const inTokens = Math.ceil(truncated.length / 4);
    const outTokens = Math.ceil(output.length / 4);

    return { output, inTokens, outTokens, latencyMs };
  },
};
