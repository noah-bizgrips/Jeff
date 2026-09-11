import { z } from "zod";
import { apiError, json, parseBody } from "@/lib/api";
import { isTrustedOrigin } from "@/lib/auth/guard";
import { createClient } from "@/lib/supabase/server";
import { ownerIdentity } from "@/lib/env";
import { audit } from "@/lib/audit";
import { log } from "@/lib/security/log";

export const dynamic = "force-dynamic";

const Body = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(512),
});

/**
 * POST /api/auth/login
 * Server-side password sign-in so failures can be audited and non-owner
 * emails are rejected before any credential reaches Supabase. Sets the
 * HttpOnly session cookies via the SSR client. The password is never logged.
 */
export async function POST(req: Request) {
  if (!isTrustedOrigin(req)) return apiError("untrusted_origin", 403);
  const body = await parseBody(req, Body);
  if (!body.ok) return apiError("invalid_input", 400);
  const owner = ownerIdentity();
  if (body.data.email !== owner.email) {
    await audit({ event: "login_failed", request: req, metadata: { reason: "not_owner_email" } });
    // Same response as a bad password: do not reveal which accounts exist.
    return apiError("invalid_credentials", 401);
  }
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email: body.data.email, password: body.data.password });
  if (error || !data.user) {
    await audit({ event: "login_failed", request: req, metadata: { reason: "bad_credentials" } });
    log.warn("login_failed");
    return apiError("invalid_credentials", 401);
  }
  if (owner.userId && data.user.id !== owner.userId) {
    await supabase.auth.signOut();
    await audit({ event: "login_failed", ownerId: null, request: req, metadata: { reason: "user_id_mismatch" } });
    return apiError("not_owner", 403);
  }
  const aal = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  const next = aal.data?.currentLevel === "aal2" ? "/" : "/mfa";
  await audit({ event: "login", ownerId: data.user.id, request: req, metadata: { aal: aal.data?.currentLevel ?? "aal1" } });
  return json({ ok: true, next });
}
