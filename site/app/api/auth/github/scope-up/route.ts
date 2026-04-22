import { NextRequest, NextResponse } from "next/server";

const API = process.env.NEXT_PUBLIC_ASHLR_API_URL ?? "https://api.ashlr.ai";

/**
 * GET /api/auth/github/scope-up/start?sid=<sid>
 *
 * Proxies to GET ${API}/auth/github/scope-up with the Bearer token from the
 * client. The backend returns a 302 redirect to GitHub's OAuth page. We read
 * the Location header and return it as JSON so the client-side page.tsx can
 * do `window.location.href = url` (fetch does not expose Location on 302 from
 * cross-origin servers when redirect:manual is used).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get("Authorization");
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sid = req.nextUrl.searchParams.get("sid") ?? "";
  if (!sid) {
    return NextResponse.json({ error: "sid required" }, { status: 400 });
  }

  const upstream = await fetch(
    `${API}/auth/github/scope-up?sid=${encodeURIComponent(sid)}`,
    {
      headers: { Authorization: auth },
      redirect: "manual",
    },
  );

  if (upstream.status === 401 || upstream.status === 403) {
    const body = await upstream.json().catch(() => ({}));
    return NextResponse.json(body, { status: upstream.status });
  }

  if (upstream.status === 302) {
    const location = upstream.headers.get("location") ?? "";
    return NextResponse.json({ url: location });
  }

  // Unexpected status — surface it
  const text = await upstream.text();
  return NextResponse.json({ error: text || `HTTP ${upstream.status}` }, { status: 502 });
}
