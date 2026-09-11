import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ownerIdentity } from "@/lib/env";

export type AssuranceLevel = "aal1" | "aal2";

export type OwnerSession =
  | { status: "anonymous" }
  | { status: "unauthorized"; userId: string; email: string | null }
  | { status: "owner"; userId: string; email: string; aal: AssuranceLevel };

/**
 * Establishes who is calling, using the verified JWT claims (signature-checked
 * by `getClaims`, not the raw cookie contents) and the configured owner
 * identity. Both the email AND the immutable user id must match.
 *
 * `aal` comes from the verified JWT claim, which Supabase only upgrades to
 * aal2 after a successful TOTP challenge.
 */
export async function resolveOwnerSession(supabase: SupabaseClient): Promise<OwnerSession> {
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) return { status: "anonymous" };
  const claims = data.claims;
  const userId = typeof claims.sub === "string" ? claims.sub : "";
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : null;
  if (!userId) return { status: "anonymous" };

  const owner = ownerIdentity();
  const emailMatches = !!email && email === owner.email;
  const idMatches = !!owner.userId && userId === owner.userId;
  if (!emailMatches || !idMatches) return { status: "unauthorized", userId, email };

  const aal: AssuranceLevel = claims.aal === "aal2" ? "aal2" : "aal1";
  return { status: "owner", userId, email: email!, aal };
}

export function isVerifiedOwner(s: OwnerSession): s is Extract<OwnerSession, { status: "owner" }> & { aal: "aal2" } {
  return s.status === "owner" && s.aal === "aal2";
}
