// Admin-side fetch wrapper.
// Reads the admin token from localStorage (key: ashlrAdminToken) — separate
// from the user token (ashlrToken) so the two auth flows never collide.
//
// Usage (in a "use client" component or effect):
//   import { adminFetch } from "@/lib/admin-fetcher";
//   const data = await adminFetch<OverviewData>("/admin/overview");

const BASE = process.env.NEXT_PUBLIC_ASHLR_API_URL ?? "https://api.ashlr.ai";
const TOKEN_KEY = "ashlrAdminToken";

export class AdminAuthError extends Error {
  constructor() {
    super("No admin token found — redirect to admin sign-in");
    this.name = "AdminAuthError";
  }
}

export class AdminApiError extends Error {
  status: number;
  constructor(status: number, statusText: string) {
    super(`Admin API ${status}: ${statusText}`);
    this.name = "AdminApiError";
    this.status = status;
  }
}

/**
 * Fetch a path from the ashlr admin API using the token stored in localStorage.
 * Throws AdminAuthError if the token is missing.
 * Throws AdminApiError on non-2xx responses.
 *
 * Must be called from a client context (localStorage is not available on the server).
 */
export async function adminFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const token =
    typeof localStorage !== "undefined"
      ? localStorage.getItem(TOKEN_KEY)
      : null;

  if (!token) throw new AdminAuthError();

  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  if (res.status === 204) return null as T;

  if (!res.ok) {
    throw new AdminApiError(res.status, res.statusText);
  }

  return res.json() as Promise<T>;
}
