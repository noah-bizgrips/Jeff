import { z } from "zod";
import { apiError, json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { refreshGoalById } from "@/lib/gomez/goals/refresh";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** POST /api/goals/{id}/refresh — recompute one goal now. */
export const POST = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return apiError("invalid_id", 400);
  const result = await refreshGoalById(g.session.userId, id!);
  if (!result) return apiError("goal_not_found", 404);
  return json({ result: { goalId: result.goalId, trajectory: result.trajectory, changed: result.changed, error: result.error ?? null } });
});
