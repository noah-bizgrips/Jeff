/**
 * Route classification shared by proxy.ts and tests. Kept dependency-free so
 * it can run in the proxy runtime and in unit tests.
 */

const PUBLIC_EXACT = new Set(["/login", "/unauthorized", "/privacy", "/api/health", "/api/auth/login", "/auth/callback", "/auth/signout"]);
// /api/cron/ is authenticated by CRON_SECRET inside the handler, not by a session.
const PUBLIC_PREFIXES = ["/api/webhooks/", "/api/cron/", "/_next/", "/favicon", "/icon", "/apple-icon", "/robots.txt"];

// Owner-only but reachable at aal1 (needed to complete MFA).
const AAL1_EXACT = new Set(["/mfa"]);
const AAL1_PREFIXES = ["/api/auth/mfa/"];

export type RouteClass = "public" | "aal1" | "protected";

export function classifyRoute(pathname: string): RouteClass {
  if (PUBLIC_EXACT.has(pathname)) return "public";
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return "public";
  if (AAL1_EXACT.has(pathname)) return "aal1";
  if (AAL1_PREFIXES.some((p) => pathname.startsWith(p))) return "aal1";
  return "protected";
}

export function isApiPath(pathname: string) {
  return pathname.startsWith("/api/");
}

/**
 * Decides what to do for a request given the session state.
 * Returns `null` to allow, or a redirect target / API error code.
 */
export function decideAccess(
  pathname: string,
  session: { status: "anonymous" } | { status: "unauthorized" } | { status: "owner"; aal: "aal1" | "aal2" },
): { allow: true } | { allow: false; redirect: string; apiStatus: number; apiCode: string } {
  const cls = classifyRoute(pathname);
  if (cls === "public") return { allow: true };
  if (session.status === "anonymous") {
    return { allow: false, redirect: "/login", apiStatus: 401, apiCode: "unauthenticated" };
  }
  if (session.status === "unauthorized") {
    return { allow: false, redirect: "/unauthorized", apiStatus: 403, apiCode: "not_owner" };
  }
  if (cls === "aal1") return { allow: true };
  if (session.aal !== "aal2") {
    return { allow: false, redirect: "/mfa", apiStatus: 403, apiCode: "mfa_required" };
  }
  return { allow: true };
}
