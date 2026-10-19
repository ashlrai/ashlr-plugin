/**
 * Opt-in strict targets for model calls that carry a key.
 *
 * Off by default: with ASHLR_GATEWAY_STRICT unset, keyedFetch() is plain
 * fetch() and nothing changes. With ASHLR_GATEWAY_STRICT=1, a request that
 * carries a key (Authorization or x-api-key) is sent only when its target is:
 *
 *   - a loopback IP literal, 127.0.0.1 or [::1] (http or https, any port), or
 *   - https to an exact host:port listed in ASHLR_GATEWAY_HOSTS
 *     (comma-separated, for example "litellm.internal:4000,gw.example.com:443"), or
 *   - https to one of the plugin's built-in provider hosts on 443
 *     (api.anthropic.com, api.openai.com, api.ashlr.ai).
 *
 * `localhost` by name is not loopback here, credentials in the URL are
 * refused, and redirects are never followed (a 3xx is a refusal), because
 * fetch forwards a custom header such as x-api-key to the redirect target.
 * Refusal messages name scheme, host and port only, never the key, path or
 * query.
 */

type Env = Record<string, string | undefined>;

export const GATEWAY_STRICT_ENV = "ASHLR_GATEWAY_STRICT";
export const GATEWAY_HOSTS_ENV = "ASHLR_GATEWAY_HOSTS";

export const BUILTIN_PROVIDER_HOSTS: readonly string[] = [
  "api.anthropic.com:443",
  "api.openai.com:443",
  "api.ashlr.ai:443",
];

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);

export class GatewayRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayRefusal";
  }
}

/** True when ASHLR_GATEWAY_STRICT is 1, true, yes or on (any case). */
export function gatewayStrict(env: Env = process.env): boolean {
  const v = (env[GATEWAY_STRICT_ENV] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Parse ASHLR_GATEWAY_HOSTS. Each entry must be an exact host:port. Returns
 * the invalid entries separately so a typo refuses every listed target
 * instead of silently allowing less (or more) than intended.
 */
export function parseGatewayHosts(env: Env = process.env): { hosts: Set<string>; invalid: string[] } {
  const hosts = new Set<string>();
  const invalid: string[] = [];
  for (const raw of (env[GATEWAY_HOSTS_ENV] ?? "").split(",")) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    const m = /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*):(\d{1,5})$/.exec(entry);
    const port = m ? Number(m[5]) : 0;
    if (!m || port < 1 || port > 65535) {
      invalid.push(raw.trim().slice(0, 80));
      continue;
    }
    hosts.add(`${m[1]}:${port}`);
  }
  return { hosts, invalid };
}

/** scheme://host:port of a URL, nothing else; "(invalid URL)" when it does not parse. */
export function safeTargetLabel(url: string): string {
  try {
    const u = new URL(url);
    const port = u.port || (u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : "");
    return `${u.protocol}//${u.hostname}${port ? `:${port}` : ""}`;
  } catch {
    return "(invalid URL)";
  }
}

export type TargetCheck = { ok: true } | { ok: false; reason: string };

/** Decide whether a keyed request may go to `url` under the strict rules. */
export function checkKeyedTarget(url: string, env: Env = process.env): TargetCheck {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: "target is not a valid URL" };
  }
  const label = safeTargetLabel(url);
  if (u.username || u.password) return { ok: false, reason: `${label}: credentials in the URL are refused` };
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: `${label}: only http and https are allowed` };
  }
  const host = u.hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return { ok: true };
  if (u.protocol === "http:") {
    return { ok: false, reason: `${label}: plain http is allowed only for 127.0.0.1 and [::1]` };
  }
  const hostPort = `${host}:${u.port || "443"}`;
  if (BUILTIN_PROVIDER_HOSTS.includes(hostPort)) return { ok: true };
  const { hosts, invalid } = parseGatewayHosts(env);
  if (invalid.length > 0) {
    return { ok: false, reason: `${GATEWAY_HOSTS_ENV} has entries that are not host:port (${invalid.join(", ")}); fix them first` };
  }
  if (hosts.has(hostPort)) return { ok: true };
  return { ok: false, reason: `${label}: ${hostPort} is not listed in ${GATEWAY_HOSTS_ENV}` };
}

/**
 * fetch() for a request that carries a key. Unchanged when strict mode is
 * off. In strict mode it refuses a target that fails checkKeyedTarget() and
 * any redirect, throwing GatewayRefusal before or instead of following it.
 */
export async function keyedFetch(
  url: string,
  init: RequestInit = {},
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (!gatewayStrict(env)) return fetchImpl(url, init);
  const check = checkKeyedTarget(url, env);
  if (!check.ok) throw new GatewayRefusal(`[ashlr] gateway strict mode refused ${check.reason}`);
  const res = await fetchImpl(url, { ...init, redirect: "manual" });
  if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") {
    try { await res.body?.cancel(); } catch { /* nothing to drain */ }
    throw new GatewayRefusal(`[ashlr] gateway strict mode refused a redirect from ${safeTargetLabel(url)}`);
  }
  return res;
}
