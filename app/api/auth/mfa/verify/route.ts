import { z } from "zod";
import { json, apiError, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAnyAal } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const Body = z.object({
  factorId: z.string().min(1).max(200),
  challengeId: z.string().min(1).max(200),
  code: z.string().regex(/^\d{6}$/),
  enrolling: z.boolean().optional(),
});

/** Verifies a TOTP code. On success Supabase upgrades the session to aal2. */
export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAnyAal(req);
  if (!g.ok) return g.response;
  const body = await parseBody(req, Body);
  if (!body.ok) return body.response;
  const ownerId = g.session.status === "owner" ? g.session.userId : null;
  const { error } = await g.supabase.auth.mfa.verify({
    factorId: body.data.factorId,
    challengeId: body.data.challengeId,
    code: body.data.code,
  });
  if (error) {
    await audit({ event: "mfa_failed", ownerId, request: req, metadata: { factorId: body.data.factorId } });
    return apiError("mfa_verify_failed", 400);
  }
  await audit({ event: body.data.enrolling ? "mfa_enrolled" : "mfa_verified", ownerId, request: req, metadata: { factorId: body.data.factorId } });
  if (ownerId) await audit({ event: "login", ownerId, request: req, metadata: { aal: "aal2" } });
  return json({ ok: true, aal: "aal2" });
});
