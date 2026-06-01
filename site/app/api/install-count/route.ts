import { NextResponse } from "next/server";

/**
 * GET /api/install-count
 *
 * Returns the current GitHub stargazers + total release download count for
 * ashlrai/ashlr-plugin. Cached for 1 hour at the edge + 1 hour in-memory so
 * a burst of landing-page loads never burns through the unauthenticated
 * GitHub rate limit (60 req/hr/IP). Falls back to the last-known value on
 * any fetch error so the badge never breaks the page.
 */

type Payload = { stars: number; downloads: number };

let cache: { at: number; value: Payload } | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Hard-coded floor values used only when (a) this is a cold Vercel instance
 * with no in-memory cache AND (b) GitHub is unreachable or rate-limiting us.
 * Hand-updated at release time so a degraded GitHub never displays a 0-star
 * badge, which would be a more embarrassing failure mode than a slightly
 * stale number. Bump these with each release that notably grows either
 * counter.
 */
/**
 * Hand-maintained install/adoption floor. There is NO reliable LIVE source:
 * GitHub release-ASSET downloads sit near 0 (the plugin installs via `/plugin
 * marketplace add` / git, not by downloading a release asset), and telemetry is
 * opt-in so it undercounts. Bump INSTALLS as adoption grows.
 */
const INSTALLS = 12;

const LAST_KNOWN_FALLBACK: Payload = { stars: 24, downloads: INSTALLS };

export const dynamic = "force-dynamic";
export const revalidate = 3600;

export async function GET() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return respond(cache.value);
  }

  try {
    const value = await fetchFromGitHub();
    cache = { at: Date.now(), value };
    return respond(value);
  } catch {
    // GitHub rate-limited us or is down. Return the last-known good value
    // if we have one, otherwise the zero-fallback.
    return respond(cache?.value ?? LAST_KNOWN_FALLBACK);
  }
}

function respond(value: Payload): NextResponse {
  return NextResponse.json(value, {
    headers: {
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}

async function fetchFromGitHub(): Promise<Payload> {
  const repo = "ashlrai/ashlr-plugin";
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "plugin.ashlr.ai",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const repoRes = await fetch(`https://api.github.com/repos/${repo}`, {
    headers,
    next: { revalidate: 3600 },
  });
  if (!repoRes.ok) throw new Error(`repo ${repoRes.status}`);

  const repoData = (await repoRes.json()) as { stargazers_count?: number };
  const stars = typeof repoData.stargazers_count === "number" ? repoData.stargazers_count : 0;

  // Release-ASSET download_count is a meaningless adoption proxy here (install
  // is via `/plugin marketplace add` / git, not asset downloads → ~0), so show
  // the hand-maintained INSTALLS floor instead of summing assets.
  return { stars, downloads: INSTALLS };
}
