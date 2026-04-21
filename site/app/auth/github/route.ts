import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";

const API = process.env.NEXT_PUBLIC_ASHLR_API_URL ?? "https://api.ashlr.ai";

function isValidSid(sid: string | null): sid is string {
  return typeof sid === "string" && /^[0-9a-f]{32}$/.test(sid);
}

export function GET(req: NextRequest): NextResponse {
  const rawSid = req.nextUrl.searchParams.get("sid");
  const sid = isValidSid(rawSid) ? rawSid : randomBytes(16).toString("hex");

  const plan = req.nextUrl.searchParams.get("plan");
  const planParam = plan ? `&plan=${encodeURIComponent(plan)}` : "";
  return NextResponse.redirect(`${API}/auth/github/start?sid=${sid}${planParam}`, 302);
}
