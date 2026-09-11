import { z } from "zod";
import { json, apiError, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const Body = z.object({ factorId: z.string().min(1).max(200) });

/** Removes an UNVERIFIED (abandoned) factor. Verified factors cannot be removed from the UI. */
export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const body = await parseBody(req, Body);
  if (!body.ok) return body.response;
  const factors = await g.supabase.auth.mfa.listFactors();
  const target = (factors.data?.totp ?? []).find((f) => f.id === body.data.factorId);
  if (!target) return apiError("factor_not_found", 404);
  if (target.status === "verified") return apiError("verified_factor_locked", 403);
  const { error } = await g.supabase.auth.mfa.unenroll({ factorId: body.data.factorId });
  if (error) return apiError("mfa_unenroll_failed", 400);
  await audit({ event: "mfa_enrollment_started", ownerId: g.session.userId, request: req, metadata: { removedUnverified: body.data.factorId } });
  return json({ ok: true });
});
