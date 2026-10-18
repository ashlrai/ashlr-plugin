/**
 * Optional Phantom integration for credential env vars.
 *
 * A value of the form `phm:NAME` (for example `ANTHROPIC_API_KEY=phm:ANTHROPIC_API_KEY`)
 * is a reference, not a key. When the `phantom` CLI is on PATH it is resolved
 * with `phantom reveal --yes NAME`, the same call Locus makes. When phantom is
 * absent, times out, fails, or returns nothing, the reference resolves to
 * `undefined` so callers treat the credential as unset. The plugin never
 * sends a literal `phm:` string to a provider, never logs a resolved value,
 * and a plain (non-`phm:`) value is returned untouched with no process spawned.
 *
 * Base URLs (ANTHROPIC_BASE_URL, OPENAI_BASE_URL, OLLAMA_HOST) live in
 * `_base-urls.ts`; a Phantom proxy or LiteLLM gateway is just a value there.
 */

import { spawnSync } from "node:child_process";

type Env = Record<string, string | undefined>;

export const PHM_PREFIX = "phm:";
export const PHANTOM_TIMEOUT_MS = 5_000;

/** Secret names Phantom accepts: letters, digits, underscore, dash, dot. */
const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

export type PhantomRunner = (name: string) => string | undefined;

/** True when the value is a `phm:NAME` reference with a well-formed name. */
export function isPhmRef(value: string | undefined): boolean {
  const v = (value ?? "").trim();
  return v.startsWith(PHM_PREFIX) && NAME_RE.test(v.slice(PHM_PREFIX.length));
}

/** Default runner: `phantom reveal --yes NAME`, stdout trimmed, value never logged. */
export const runPhantomReveal: PhantomRunner = (name) => {
  try {
    const r = spawnSync("phantom", ["reveal", "--yes", name], {
      encoding: "utf8",
      timeout: PHANTOM_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    if (r.error || r.status !== 0) return undefined;
    const out = (r.stdout ?? "").trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
};

const cache = new Map<string, string | undefined>();

/** Test hook: forget resolved references. */
export function _resetPhantomRefCache(): void {
  cache.clear();
}

/**
 * Resolve a credential value. Plain values pass through (trimmed, empty is
 * undefined). `phm:NAME` goes through phantom once per process and is cached;
 * any failure yields undefined.
 */
export function resolveCredential(
  value: string | undefined,
  run: PhantomRunner = runPhantomReveal,
): string | undefined {
  const v = (value ?? "").trim();
  if (!v) return undefined;
  if (!v.startsWith(PHM_PREFIX)) return v;
  if (!isPhmRef(v)) return undefined;
  const name = v.slice(PHM_PREFIX.length);
  if (cache.has(name)) return cache.get(name);
  const resolved = run(name);
  cache.set(name, resolved);
  return resolved;
}

/** Read env var `key` and resolve it (see resolveCredential). */
export function envCredential(
  key: string,
  env: Env = process.env,
  run: PhantomRunner = runPhantomReveal,
): string | undefined {
  return resolveCredential(env[key], run);
}
