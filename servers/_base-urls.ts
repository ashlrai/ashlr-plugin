/**
 * Base URLs for the provider hosts the plugin's scripts and servers call.
 *
 * Each helper reads the same environment variable the provider's own tooling
 * uses and falls back to the host the plugin always used, so nothing changes
 * unless a variable is set. A gateway (for example LiteLLM) or a local proxy
 * can then sit in front by setting the variable.
 *
 *   ANTHROPIC_BASE_URL  root without /v1 (default https://api.anthropic.com)
 *   OPENAI_BASE_URL     includes /v1 (default https://api.openai.com/v1)
 *   OLLAMA_HOST         host, host:port, :port or a full URL (default http://localhost:11434)
 *
 * Empty or whitespace-only values count as unset. Trailing slashes are trimmed.
 */

export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

type Env = Record<string, string | undefined>;

function trimmed(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

/** Anthropic API root, no trailing slash. Append `/v1/...`. */
export function anthropicBaseUrl(env: Env = process.env): string {
  return trimmed(env["ANTHROPIC_BASE_URL"]) || DEFAULT_ANTHROPIC_BASE_URL;
}

/** OpenAI API root including `/v1`, no trailing slash. Append `/models` etc. */
export function openaiBaseUrl(env: Env = process.env): string {
  return trimmed(env["OPENAI_BASE_URL"]) || DEFAULT_OPENAI_BASE_URL;
}

/**
 * Ollama root, no trailing slash. OLLAMA_HOST may omit the scheme (`host:port`,
 * `host`, `:port`); `http://` is assumed and port 11434 when none is given.
 */
export function ollamaBaseUrl(env: Env = process.env): string {
  const raw = trimmed(env["OLLAMA_HOST"]);
  if (!raw) return DEFAULT_OLLAMA_BASE_URL;
  if (/^https?:\/\//i.test(raw)) return raw;
  let hostPort = raw;
  if (hostPort.startsWith(":")) hostPort = `localhost${hostPort}`;
  if (!/:\d+$/.test(hostPort)) hostPort = `${hostPort}:11434`;
  return `http://${hostPort}`;
}
