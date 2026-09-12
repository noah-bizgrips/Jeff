import { z } from "zod";
import { apiError, json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { prepareRecommendation } from "@/lib/jeff/goals/store";

export const dynamic = "force-dynamic";

/** POST — turns a recommendation into a sandbox-only mission draft linked to the goal. */
export const POST = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { id, recId } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success || !z.string().uuid().safeParse(recId).success) return apiError("invalid_id", 400);
  try {
    const mission = await prepareRecommendation(g.session.userId, id!, recId!);
    await audit({ event: "goal_recommendation_prepared", ownerId: g.session.userId, targetId: recId, request: req, metadata: { goalId: id, mission: mission.code } });
    return json({ mission }, { status: 201 });
  } catch (err) {
    if (err instanceof Error && err.message === "recommendation_not_found") return apiError("recommendation_not_found", 404);
    throw err;
  }
});
