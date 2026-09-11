import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const Body = z.object({
  decision: z.enum(["granted", "denied"]),
  artifactRef: z.string().max(200).optional(),
  reason: z.string().max(1000).optional(),
});

/**
 * POST /api/approvals/{id}/decide
 * Binds the decision to the exact artifact version and records the AAL of the
 * deciding session (always aal2 here). Granting never executes anything by
 * itself; workers must re-check the approval is unexpired and unconsumed.
 */
export const POST = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return apiError("invalid_id", 400);
  const body = await parseBody(req, Body);
  if (!body.ok) return body.response;
  const admin = createAdminClient();
  const { data: approval } = await admin.from("approvals").select("*").eq("id", id!).eq("owner_id", g.session.userId).maybeSingle();
  if (!approval) return apiError("approval_not_found", 404);
  if (approval.status !== "pending") return apiError("approval_not_pending", 409);
  if (body.data.decision === "granted" && approval.artifact_ref && body.data.artifactRef !== approval.artifact_ref) {
    return apiError("artifact_mismatch", 409);
  }
  const { error } = await admin
    .from("approvals")
    .update({
      status: body.data.decision,
      decided_at: new Date().toISOString(),
      decided_aal: "aal2",
      reason: body.data.reason ?? null,
      expires_at: body.data.decision === "granted" ? new Date(Date.now() + 60 * 60 * 1000).toISOString() : null,
    })
    .eq("id", id!);
  if (error) return apiError("approval_update_failed", 500);
  await audit({
    event: body.data.decision === "granted" ? "approval_granted" : "approval_denied",
    ownerId: g.session.userId,
    targetId: id,
    request: req,
    metadata: { action: approval.action, environment: approval.environment, artifactRef: approval.artifact_ref },
  });
  return json({ ok: true });
});
