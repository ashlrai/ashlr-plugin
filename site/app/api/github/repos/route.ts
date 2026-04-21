import { NextRequest, NextResponse } from "next/server";

const API = process.env.NEXT_PUBLIC_ASHLR_API_URL ?? "https://api.ashlr.ai";

/**
 * GET /api/github/repos
 *
 * Proxies to GET ${API}/user/repos — the backend decrypts the user's GitHub
 * access token server-side (it holds ASHLR_MASTER_KEY). This route never
 * touches the raw GitHub token.
 *
 * BACKEND STUB NOTE: POST /genome/build, GET /genome/:id/status, and
 * GET /user/repos are consumed here but must be shipped by Phase 7B.4.
 * If those endpoints are missing at integration time, the frontend will
 * show an error state — no static fallback is provided so the gap is visible.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get("Authorization");
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const upstream = await fetch(`${API}/user/repos`, {
    headers: { Authorization: auth },
    cache: "no-store",
  });

  if (!upstream.ok) {
    const text = await upstream.text();
    return NextResponse.json(
      { error: text || "Failed to fetch repos" },
      { status: upstream.status }
    );
  }

  const data = await upstream.json();
  return NextResponse.json(data);
}
