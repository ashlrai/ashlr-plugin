/**
 * Shared HTTP helpers used by both ashlr-http and ashlr-webfetch servers.
 * Extracted here so webfetch-server.ts can import without triggering
 * http-server's top-level `await server.connect(transport)`.
 */

// ---------- safety ----------

import { isIP } from "net";
import { lookup } from "dns/promises";

/**
 * Classify an IPv4 or IPv6 address as private/loopback/link-local/metadata/
 * reserved. Unlike the old hostname-only regex, this runs on an already-
 * resolved IP string and is therefore immune to IPv4 alternate notations
 * (decimal integer, hex, octal, short-form) and IPv6 normalization tricks
 * that the WHATWG URL parser silently accepts.
 */
function isPrivateIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return false;
  if (family === 4) {
    const parts = ip.split(".").map((p) => parseInt(p, 10));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return false;
    const [a, b] = parts as [number, number, number, number];
    if (a === 10) return true;                      // 10.0.0.0/8
    if (a === 127) return true;                     // 127.0.0.0/8 loopback
    if (a === 192 && b === 168) return true;        // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 169 && b === 254) return true;        // 169.254.0.0/16 link-local + cloud metadata
    if (a === 0) return true;                       // 0.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CG-NAT
    if (a >= 224) return true;                      // multicast + reserved
    return false;
  }
  // IPv6. Normalise case + dropped ::ffff: mapping.
  const v6 = ip.toLowerCase();
  if (v6 === "::" || v6 === "::1") return true;
  // IPv4-mapped IPv6: ::ffff:127.0.0.1 — extract and recheck as v4.
  const mapped = v6.match(/^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/);
  if (mapped) return isPrivateIp(mapped[1]!);
  const first = v6.split(":")[0] ?? "";
  const firstNum = parseInt(first, 16);
  if (Number.isFinite(firstNum)) {
    if ((firstNum & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    if ((firstNum & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((firstNum & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  }
  return false;
}

/**
 * Synchronous hostname-only check used for direct-literal URLs. Keep as a
 * narrow pre-filter to reject unambiguously-private *string forms* (localhost
 * aliases, bare IPv4/IPv6 literals) before paying DNS; `safePreflight` below
 * does the real DNS-aware check on every hop.
 *
 * Retains the historical signature so existing callers compile unchanged.
 */
export function isPrivateHost(host: string): boolean {
  if (process.env.ASHLR_HTTP_ALLOW_PRIVATE === "1") return false;
  const h = host.toLowerCase().replace(/\.$/, ""); // strip trailing dot
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  // Bracketed IPv6 literals from URL.hostname come in unbracketed — strip any
  // surviving brackets defensively.
  const bare = h.replace(/^\[|\]$/g, "");
  if (isIP(bare) !== 0) return isPrivateIp(bare);
  return false;
}

/**
 * Resolve a hostname via DNS and refuse if *any* resolved address is private.
 * Pair with hostname-literal prefilter for a complete check.
 */
async function dnsIsPrivate(hostname: string): Promise<boolean> {
  try {
    const results = await lookup(hostname, { all: true, verbatim: true });
    return results.some((r) => isPrivateIp(r.address));
  } catch {
    // Can't resolve — treat as unsafe to be conservative. The caller will
    // surface a network error in the next step anyway.
    return true;
  }
}

// ---------- safe fetch with manual redirect validation ----------

export interface SafeFetchOptions extends RequestInit {
  /** Max redirect hops. Default 5. */
  maxRedirects?: number;
  /** AbortSignal to cancel the whole chain (not just one hop). */
  signal?: AbortSignal;
}

/**
 * fetch() with SSRF-safe manual redirect handling.
 *
 * The native `fetch(url, { redirect: "follow" })` silently follows 3xx
 * redirects without re-checking the target — an attacker can hand us a
 * public URL that redirects to 127.0.0.1 or 169.254.169.254 (cloud
 * metadata) and bypass `isPrivateHost` entirely. This wrapper validates
 * every hop: if any redirect Location points at a private host (and
 * `ASHLR_HTTP_ALLOW_PRIVATE` isn't set), it throws before any bytes are
 * read from the internal target.
 *
 * Callers should use this in place of fetch() anywhere user-supplied URLs
 * are involved.
 */
export async function safeFetch(
  url: string,
  opts: SafeFetchOptions = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 5;
  let currentUrl = url;
  const { maxRedirects: _drop, ...fetchOpts } = opts;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let parsed: URL;
    try { parsed = new URL(currentUrl); } catch { throw new Error(`invalid URL: ${currentUrl}`); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`unsupported scheme: ${parsed.protocol} (http/https only)`);
    }
    // Literal-host prefilter (cheap, catches bare IPs + localhost aliases).
    if (isPrivateHost(parsed.hostname)) {
      throw new Error(
        hop === 0
          ? `refusing private host ${parsed.hostname}; set ASHLR_HTTP_ALLOW_PRIVATE=1 to override`
          : `refusing redirect to private host ${parsed.hostname} (hop ${hop}); set ASHLR_HTTP_ALLOW_PRIVATE=1 to override`,
      );
    }
    // DNS-aware check for named hosts. Catches IPv4 alt-notations (decimal,
    // hex, octal, short-form), IPv4-mapped IPv6, and CNAMEs that resolve
    // into private space. Skipped entirely when the operator has opted into
    // private-host access — matches the historical escape-hatch behavior.
    if (process.env.ASHLR_HTTP_ALLOW_PRIVATE !== "1" && isIP(parsed.hostname) === 0) {
      if (await dnsIsPrivate(parsed.hostname)) {
        throw new Error(
          `refusing ${parsed.hostname}: resolves to a private/internal address; set ASHLR_HTTP_ALLOW_PRIVATE=1 to override`,
        );
      }
    }

    const res = await fetch(currentUrl, { ...fetchOpts, redirect: "manual" });
    // 2xx/4xx/5xx → return directly, caller handles. 3xx → follow if we have budget.
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    if (!location) return res; // malformed 3xx, return as-is
    // Resolve relative redirects against the current URL.
    currentUrl = new URL(location, currentUrl).toString();
  }
  throw new Error(`too many redirects (> ${maxRedirects})`);
}

// ---------- HTML compressor ----------

export function compressHtml(raw: string): string {
  let s = raw;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, "");
  s = s.replace(/<(nav|footer|aside|header|form)[^>]*>[\s\S]*?<\/\1>/gi, "");
  const mainMatch = s.match(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i);
  if (mainMatch) s = mainMatch[2]!;
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, t) => "\n" + "#".repeat(+lvl) + " " + stripTags(t) + "\n");
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => "• " + stripTags(t) + "\n");
  s = s.replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => stripTags(t) + ` (${href})`);
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, t) => "\n```\n" + decodeEntities(stripTags(t)) + "\n```\n");
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, t) => "`" + stripTags(t) + "`");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<p[^>]*>/gi, "\n");
  s = s.replace(/<\/p>/gi, "\n");
  s = stripTags(s);
  s = decodeEntities(s);
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
}

// ---------- JSON compressor ----------

export function compressJson(raw: string): string {
  try {
    const obj = JSON.parse(raw);
    return JSON.stringify(elideLongArrays(obj), null, 2);
  } catch {
    return raw;
  }
}

function elideLongArrays(v: any): any {
  if (Array.isArray(v)) {
    if (v.length > 20) {
      const head = v.slice(0, 10).map(elideLongArrays);
      const tail = v.slice(-5).map(elideLongArrays);
      return [...head, `[... ${v.length - 15} elided ...]`, ...tail];
    }
    return v.map(elideLongArrays);
  }
  if (v && typeof v === "object") {
    const o: any = {};
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === "string" && val.length > 300) {
        o[k] = val.slice(0, 280) + "…";
      } else {
        o[k] = elideLongArrays(val);
      }
    }
    return o;
  }
  return v;
}
