/**
 * Shared types for the LLM provider abstraction layer.
 *
 * Provider hierarchy (auto mode): anthropic → onnx → local → none
 * Callers should never import concrete providers directly — use
 * `selectProvider()` from `./index.ts` instead.
 */

export interface LlmSummarizeResult {
  output: string;
  inTokens: number;
  outTokens: number;
  latencyMs: number;
}

export interface LlmProvider {
  name: "anthropic" | "onnx" | "local" | "none";
  isAvailable(): Promise<boolean>;
  summarize(
    text: string,
    prompt: string,
    opts?: { maxTokens?: number },
  ): Promise<LlmSummarizeResult>;
}

/** Env var that controls which provider is selected. Default: "auto". */
export type ProviderName = "auto" | "anthropic" | "onnx" | "local" | "off";
