import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { GoalMetricSchema } from "@/lib/gomez/goals/schema";
import { approveGoal, deleteDraftGoal, getGoal, listGoalEvents, listGoalMetrics, listGoalMissions, listRecommendations, listSnapshots, updateGoal } from "@/lib/gomez/goals/store";
import { refreshGoal } from "@/lib/gomez/goals/refresh";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Id = z.string().uuid();
const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const Patch = z.object({
  approve: z
    .object({
      resolutions: z.record(z.string().max(80), z.string().trim().min(1).max(400)).default({}),
      name: z.string().trim().min(1).max(140).optional(),
      start_date: DateStr.optional(),
      end_date: DateStr.optional(),
    })
    .optional(),
  action: z.enum(["pause", "resume", "archive", "achieved", "missed"]).optional(),
  name: z.string().trim().min(1).max(140).optional(),
  description: z.string().trim().max(600).optional(),
  start_date: DateStr.optional(),
  end_date: DateStr.optional(),
  metrics: z.array(GoalMetricSchema).min(1).max(12).optional(),
  note: z.string().trim().max(2000).optional(),
});

export const GET = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  if (!Id.safeParse(id).success) return apiError("invalid_id", 400);
  const goal = await getGoal(g.session.userId, id!);
  if (!goal) return apiError("goal_not_found", 404);
  const [metrics, snapshots, events, recommendations, missions] = await Promise.all([listGoalMetrics(goal.id), listSnapshots(goal.id, 60), listGoalEvents(goal.id), listRecommendations(goal.id), listGoalMissions(goal.id)]);
  return json({ goal, metrics, snapshots, latest: snapshots[snapshots.length - 1] ?? null, events, recommendations, missions });
});

export const PATCH = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  if (!Id.safeParse(id).success) return apiError("invalid_id", 400);
  const body = await parseBody(req, Patch);
  if (!body.ok) return body.response;
  try {
    if (body.data.approve) {
      const goal = await approveGoal(g.session.userId, id!, body.data.approve);
      await audit({ event: "goal_approved", ownerId: g.session.userId, targetId: id, request: req, metadata: { start: goal.start_date, end: goal.end_date } });
      const refresh = await refreshGoal(g.session.userId, goal).catch(() => null);
      return json({ goal, refresh: refresh ? { trajectory: refresh.trajectory, error: refresh.error ?? null } : null });
    }
    const { approve: _approve, ...patch } = body.data;
    void _approve;
    const goal = await updateGoal(g.session.userId, id!, patch);
    await audit({ event: "goal_updated", ownerId: g.session.userId, targetId: id, request: req, metadata: { action: patch.action ?? "edit", fields: Object.keys(patch) } });
    return json({ goal });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "goal_update_failed";
    if (msg.startsWith("goal_ambiguities_unresolved")) return apiError("ambiguities_unresolved", 400, { fields: msg.split(":")[1]?.split(",") ?? [] });
    if (msg === "goal_not_found") return apiError("goal_not_found", 404);
    if (msg === "goal_not_draft") return apiError("goal_not_draft", 409);
    throw err;
  }
});

export const DELETE = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  if (!Id.safeParse(id).success) return apiError("invalid_id", 400);
  const removed = await deleteDraftGoal(g.session.userId, id!);
  if (!removed) return apiError("only_drafts_can_be_deleted", 409);
  await audit({ event: "goal_deleted", ownerId: g.session.userId, targetId: id, request: req });
  return json({ ok: true });
});
