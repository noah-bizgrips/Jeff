import { json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAnyAal } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

/** Lists enrolled TOTP factors (ids and friendly names only). */
export const GET = withErrorBoundary(async (req) => {
  const g = await requireOwnerAnyAal(req);
  if (!g.ok) return g.response;
  const { data, error } = await g.supabase.auth.mfa.listFactors();
  if (error) return json({ error: "mfa_list_failed" }, { status: 500 });
  const totp = (data?.totp ?? []).map((f) => ({ id: f.id, name: f.friendly_name ?? null, status: f.status }));
  return json({ aal: g.session.status === "owner" ? g.session.aal : null, factors: totp });
});
