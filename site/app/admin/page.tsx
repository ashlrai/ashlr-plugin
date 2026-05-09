import { redirect } from "next/navigation";

/**
 * /admin — root index.
 *
 * Redirects to /admin/dashboard (unified ops dashboard, Stage 1).
 * Previously redirected to /admin/overview; that sub-page still exists for
 * deep-linking but the dashboard is now the primary entry point.
 */
export default function AdminRoot() {
  redirect("/admin/dashboard");
}
