import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { resolveOwnerSessionFromClaims } from "@/lib/auth/claims";
import { decideAccess, isApiPath } from "@/lib/auth/routes";
import { buildCsp } from "@/lib/security/headers";

/**
 * Next.js 16 Proxy (successor to middleware.ts).
 *
 * 1. Refreshes the Supabase session cookies on every request (SSR pattern).
 * 2. Enforces owner-only + MFA (aal2) access on every non-public route,
 *    using signature-verified JWT claims — never the raw cookie.
 * 3. Attaches a per-request CSP nonce.
 *
 * Route handlers re-check authorization themselves (defense in depth); this
 * layer exists so unauthenticated visitors never receive workspace HTML.
 */
export default async function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const csp = buildCsp({
    nonce,
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    dev: process.env.NODE_ENV === "development",
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  let response = NextResponse.next({ request: { headers: requestHeaders } });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";

  let session: Parameters<typeof decideAccess>[1] = { status: "anonymous" };

  if (supabaseUrl && publishableKey) {
    const supabase = createServerClient(supabaseUrl, publishableKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request: { headers: requestHeaders } });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    });
    // getClaims verifies the JWT signature; it does not trust the cookie blindly.
    const { data } = await supabase.auth.getClaims();
    session = resolveOwnerSessionFromClaims(data?.claims ?? null, {
      email: (process.env.OWNER_EMAIL ?? "noah@bizgrips.com").trim().toLowerCase(),
      userId: (process.env.OWNER_USER_ID ?? "").trim(),
    });
  }

  const { pathname } = request.nextUrl;
  const decision = decideAccess(pathname, session);

  if (!decision.allow) {
    if (isApiPath(pathname)) {
      const denied = NextResponse.json({ error: decision.apiCode }, { status: decision.apiStatus });
      denied.headers.set("Cache-Control", "no-store");
      response.cookies.getAll().forEach((c) => denied.cookies.set(c));
      return denied;
    }
    const url = request.nextUrl.clone();
    url.pathname = decision.redirect;
    url.search = "";
    const redirect = NextResponse.redirect(url);
    response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    redirect.headers.set("Cache-Control", "no-store");
    return redirect;
  }

  // Signed-in owner visiting /login: send them onward.
  if (pathname === "/login" && session.status === "owner") {
    const url = request.nextUrl.clone();
    url.pathname = session.aal === "aal2" ? "/" : "/mfa";
    url.search = "";
    const redirect = NextResponse.redirect(url);
    response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    return redirect;
  }

  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const config = {
  matcher: [
    // Everything except Next internals and static assets.
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|sw.js|manifest.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)",
  ],
};
