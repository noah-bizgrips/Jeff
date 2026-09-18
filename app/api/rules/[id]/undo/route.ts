import { z } from "zod";
import { apiError, json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { undoRuleSuppression } from "@/lib/gomez/rules/apply";

export const dynamic = "force-dynamic";

/** POST restores every finding this rule suppressed to its previous status. */
export const POST = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return apiError("invalid_id", 400);
  const res = await undoRuleSuppression(g.session.userId, id!);
  await audit({ event: "rule_updated", ownerId: g.session.userId, targetId: id, request: req, metadata: { undo_suppression: true, restored: res.restored } });
  return json(res);
});
