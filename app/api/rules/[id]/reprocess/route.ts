import { z } from "zod";
import { apiError, json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { reprocessFindingsForRule } from "@/lib/jeff/rules/apply";

export const dynamic = "force-dynamic";

/** POST re-applies a rule to existing active findings (suppresses matches, reversible). */
export const POST = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return apiError("invalid_id", 400);
  const res = await reprocessFindingsForRule(g.session.userId, id!);
  await audit({ event: "findings_reprocessed", ownerId: g.session.userId, targetId: id, request: req, metadata: { suppressed: res.suppressed } });
  return json(res);
});
