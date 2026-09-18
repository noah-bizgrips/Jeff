import { json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { refreshGoals } from "@/lib/gomez/goals/refresh";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** POST /api/goals/refresh — recompute every active goal (deterministic, no AI). */
export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const results = await refreshGoals(g.session.userId);
  return json({
    refreshed: results.length,
    changed: results.filter((r) => r.changed).length,
    results: results.map((r) => ({ goalId: r.goalId, name: r.name, trajectory: r.trajectory, changed: r.changed, error: r.error ?? null })),
  });
});
