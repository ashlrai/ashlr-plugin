/**
 * Value-free detection of a `phantom exec -- <cmd>` session.
 *
 * `phantom exec` hands its child fresh `phm_` session tokens in place of real
 * keys, points the provider SDK base URLs at a local proxy
 * (`http://127.0.0.1:<port>/<route>/_phantom/<token>/`) and sets
 * PHANTOM_PROXY_PORT, PHANTOM_PROXY_TOKEN and PHANTOM_SESSION_KEYS. The proxy
 * swaps the token for the real key on the way out.
 *
 * This module only looks at variable NAMES, the `phm_` / `phm:` prefixes and
 * the base URL host and port. It never resolves a reference, never runs
 * `phantom reveal`, never returns a key value, and redacts the per-session
 * proxy token from any URL it reports.
 */

type Env = Record<string, string | undefined>;

/** Keys the plugin's scripts may send to a provider. */
export const PROVIDER_KEY_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;
/** Base URL variables `phantom exec` may set for those providers. */
export const PROVIDER_BASE_URL_VARS = ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"] as const;

export type KeyKind = "unset" | "placeholder" | "ref" | "plain";

export interface PhantomExecReport {
  /** True when PHANTOM_PROXY_PORT is a valid port and PHANTOM_PROXY_TOKEN is present. */
  inSession: boolean;
  proxyPort: number | null;
  /** Per provider key: what kind of value it holds (never the value). */
  keys: Record<string, KeyKind>;
  /** Base URLs that point at this session's local proxy, token redacted. */
  proxiedBaseUrls: Record<string, string>;
  /** Plain-language warnings, value-free. */
  warnings: string[];
}

/** Kind of value held by a key variable, without exposing it. */
export function keyKind(value: string | undefined): KeyKind {
  const v = (value ?? "").trim();
  if (!v) return "unset";
  if (v.startsWith("phm_")) return "placeholder";
  if (v.startsWith("phm:")) return "ref";
  return "plain";
}

/** Replace the `/_phantom/<token>/` segment so a printed URL carries no token. */
export function redactProxyUrl(url: string): string {
  return url.replace(/\/_phantom\/[^/]+/g, "/_phantom/<redacted>");
}

function validPort(raw: string | undefined): number | null {
  if (!raw || !/^\d{1,5}$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n >= 1 && n <= 65535 ? n : null;
}

/** True when `url` is a loopback http URL on `port`. */
function pointsAtProxy(url: string, port: number): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    return (
      u.protocol === "http:" &&
      (host === "127.0.0.1" || host === "localhost" || host === "::1") &&
      Number(u.port) === port
    );
  } catch {
    return false;
  }
}

export function detectPhantomExec(env: Env = process.env): PhantomExecReport {
  const proxyPort = validPort(env["PHANTOM_PROXY_PORT"]);
  const inSession = proxyPort !== null && !!(env["PHANTOM_PROXY_TOKEN"] ?? "").trim();
  const keys: Record<string, KeyKind> = {};
  for (const name of PROVIDER_KEY_VARS) keys[name] = keyKind(env[name]);
  const proxiedBaseUrls: Record<string, string> = {};
  if (inSession && proxyPort !== null) {
    for (const name of PROVIDER_BASE_URL_VARS) {
      const v = (env[name] ?? "").trim();
      if (v && pointsAtProxy(v, proxyPort)) proxiedBaseUrls[name] = redactProxyUrl(v);
    }
  }

  const warnings: string[] = [];
  const baseFor: Record<string, string> = {
    ANTHROPIC_API_KEY: "ANTHROPIC_BASE_URL",
    OPENAI_API_KEY: "OPENAI_BASE_URL",
  };
  for (const name of PROVIDER_KEY_VARS) {
    const kind = keys[name];
    if (kind === "ref") {
      warnings.push(
        `${name} is a phm: reference. The plugin does not resolve references; run under \`phantom exec -- <cmd>\` so the variable holds a session placeholder routed by the proxy.`,
      );
    } else if (kind === "placeholder" && !inSession) {
      warnings.push(
        `${name} is a phm_ placeholder but this is not a phantom exec session, so a provider would reject it. Run under \`phantom exec -- <cmd>\`.`,
      );
    } else if (kind === "placeholder" && !proxiedBaseUrls[baseFor[name]!]) {
      warnings.push(
        `${name} is a phm_ placeholder but ${baseFor[name]} does not point at this session's proxy, so the placeholder would go to the provider directly. Check \`phantom why ${name}\`.`,
      );
    }
  }
  return { inSession, proxyPort, keys, proxiedBaseUrls, warnings };
}

/** One-line, value-free summary for doctor and the bench scripts. */
export function describePhantomExec(r: PhantomExecReport): string {
  const placeholders = Object.entries(r.keys)
    .filter(([, k]) => k === "placeholder")
    .map(([n]) => n);
  if (!r.inSession) {
    return placeholders.length || Object.values(r.keys).includes("ref")
      ? "not a phantom exec session (provider keys hold phm values; see warnings)"
      : "not a phantom exec session";
  }
  const routed = Object.keys(r.proxiedBaseUrls);
  return `phantom exec session on 127.0.0.1:${r.proxyPort}; placeholders: ${placeholders.join(", ") || "none"}; proxied: ${routed.join(", ") || "none"}`;
}

/**
 * Whether a provider key is usable for a live call from this process: a plain
 * key, or a placeholder inside a phantom exec session whose base URL routes
 * through the proxy. Unset keys and phm: refs are not usable.
 */
export function providerKeyUsable(name: (typeof PROVIDER_KEY_VARS)[number], env: Env = process.env): boolean {
  const r = detectPhantomExec(env);
  const kind = r.keys[name];
  if (kind === "plain") return true;
  if (kind !== "placeholder") return false;
  const base = name === "ANTHROPIC_API_KEY" ? "ANTHROPIC_BASE_URL" : "OPENAI_BASE_URL";
  return r.inSession && !!r.proxiedBaseUrls[base];
}
