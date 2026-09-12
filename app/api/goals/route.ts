import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { looksSensitive } from "@/lib/security/redact";
import { interpretGoal } from "@/lib/jeff/goals/interpret";
import { createDraftGoal, latestSnapshot, listGoalMetrics, listGoals } from "@/lib/jeff/goals/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Create = z.object({ prompt: z.string().trim().min(8).max(2000) });

/** GET /api/goals — goals with their latest snapshot and metric rows. */
export const GET = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const goals = await listGoals(g.session.userId);
  const items = await Promise.all(
    goals.map(async (goal) => {
      const [snapshot, metrics] = await Promise.all([latestSnapshot(goal.id), listGoalMetrics(goal.id)]);
      return { goal, snapshot, metrics };
    }),
  );
  return json({ goals: items });
});

/** POST /api/goals — natural-language prompt → validated DRAFT goal (nothing authoritative until approved). */
export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const body = await parseBody(req, Create);
  if (!body.ok) return body.response;
  if (looksSensitive(body.data.prompt)) return apiError("sensitive_content_rejected", 400);
  const { interpretation, usedModel, notes } = await interpretGoal(g.session.userId, body.data.prompt);
  const goal = await createDraftGoal(g.session.userId, body.data.prompt, interpretation, { usedModel, notes });
  await audit({ event: "goal_created", ownerId: g.session.userId, targetId: goal.id, request: req, metadata: { metrics: interpretation.metrics.map((m) => m.key), ambiguities: interpretation.ambiguities.length, usedModel } });
  return json({ goal, notes }, { status: 201 });
});
