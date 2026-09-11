import { json, apiError, withErrorBoundary } from "@/lib/api";
import { requireOwnerAnyAal } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * Starts TOTP enrollment. Returns the QR (SVG data) and factor id so the
 * owner can scan it. The TOTP secret is only ever handled by Supabase and
 * the owner's authenticator; Jeff does not persist or log it.
 */
export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAnyAal(req);
  if (!g.ok) return g.response;
  const existing = await g.supabase.auth.mfa.listFactors();
  const verified = (existing.data?.totp ?? []).filter((f) => f.status === "verified");
  // Adding a second factor requires an aal2 session (Supabase enforces this too).
  if (verified.length > 0 && g.session.status === "owner" && g.session.aal !== "aal2") {
    return apiError("mfa_required", 403);
  }
  const { data, error } = await g.supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: `Jeff authenticator ${new Date().toISOString().slice(0, 10)}`,
    issuer: "Jeff",
  });
  if (error || !data) return apiError("mfa_enroll_failed", 500);
  const ownerId = g.session.status === "owner" ? g.session.userId : null;
  await audit({ event: "mfa_enrollment_started", ownerId, request: req, metadata: { factorId: data.id } });
  return json({ factorId: data.id, qrCode: data.totp.qr_code, uri: data.totp.uri });
});
