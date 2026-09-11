import "server-only";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveOwnerSession, type OwnerSession } from "@/lib/auth/session";
import { publicEnv } from "@/lib/env";

export type GuardResult =
  | { ok: true; session: Extract<OwnerSession, { status: "owner" }> & { aal: "aal2" }; supabase: Awaited<ReturnType<typeof createClient>> }
  | { ok: false; response: NextResponse };

function deny(status: number, code: string) {
  return NextResponse.json({ error: code }, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Same-origin check for state-changing requests. Browsers send `Origin` on
 * cross-site POST/PUT/PATCH/DELETE; `Sec-Fetch-Site` is a second signal.
 */
export function isTrustedOrigin(req: Request): boolean {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  const site = req.headers.get("sec-fetch-site");
  if (site === "same-origin" || site === "none") return true;
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const allowed = new Set<string>();
  try {
    allowed.add(new URL(publicEnv().appUrl).origin);
  } catch {
    /* ignore malformed */
  }
  try {
    allowed.add(new URL(req.url).origin);
  } catch {
    /* ignore */
  }
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (host) allowed.add(`https://${host}`);
  return allowed.has(origin);
}

/**
 * Route-handler guard: authenticated + configured owner + aal2 + same origin.
 * Returns a JSON error response when any check fails. Callers must return
 * `result.response` immediately in that case.
 */
export async function requireOwnerAal2(req: Request): Promise<GuardResult> {
  if (!isTrustedOrigin(req)) return { ok: false, response: deny(403, "untrusted_origin") };
  const supabase = await createClient();
  const session = await resolveOwnerSession(supabase);
  if (session.status === "anonymous") return { ok: false, response: deny(401, "unauthenticated") };
  if (session.status === "unauthorized") return { ok: false, response: deny(403, "not_owner") };
  if (session.aal !== "aal2") return { ok: false, response: deny(403, "mfa_required") };
  return { ok: true, session: { ...session, aal: "aal2" }, supabase };
}

/** Looser guard for the MFA flow itself: owner at any assurance level. */
export async function requireOwnerAnyAal(req: Request) {
  if (!isTrustedOrigin(req)) return { ok: false as const, response: deny(403, "untrusted_origin") };
  const supabase = await createClient();
  const session = await resolveOwnerSession(supabase);
  if (session.status === "anonymous") return { ok: false as const, response: deny(401, "unauthenticated") };
  if (session.status === "unauthorized") return { ok: false as const, response: deny(403, "not_owner") };
  return { ok: true as const, session, supabase };
}
