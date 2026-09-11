import { apiError, json, withErrorBoundary } from "@/lib/api";
import { isTrustedOrigin } from "@/lib/auth/guard";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ownerIdentity } from "@/lib/env";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/bind-owner
 * One-time bootstrap: writes app_owner from OWNER_USER_ID. Authorized only
 * when the CALLER is signed in as that exact user (id + email match) — the env
 * var is the source of truth, the DB row mirrors it for RLS. Idempotent.
 */
export const POST = withErrorBoundary(async (req) => {
  if (!isTrustedOrigin(req)) return apiError("untrusted_origin", 403);
  const owner = ownerIdentity();
  if (!owner.userId) return apiError("owner_user_id_not_configured", 409);
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) return apiError("unauthenticated", 401);
  const sub = String(data.claims.sub ?? "");
  const email = String(data.claims.email ?? "").toLowerCase();
  if (sub !== owner.userId || email !== owner.email) return apiError("not_owner", 403);

  const admin = createAdminClient();
  const { data: existing } = await admin.from("app_owner").select("user_id").eq("id", 1).maybeSingle();
  if (existing && existing.user_id !== owner.userId) return apiError("owner_already_bound_to_other_user", 409);
  const { error: upsertErr } = await admin.from("app_owner").upsert({ id: 1, user_id: owner.userId, email: owner.email }, { onConflict: "id" });
  if (upsertErr) return apiError("bind_failed", 500);
  await audit({ event: "owner_bound", ownerId: owner.userId, request: req });
  return json({ ok: true, bound: true });
});
