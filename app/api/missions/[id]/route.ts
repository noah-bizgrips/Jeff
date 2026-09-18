import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { recordBaseline } from "@/lib/gomez/outcomes-store";

export const dynamic = "force-dynamic";

const Patch = z.object({ status: z.enum(["draft", "queued", "cancelled", "review", "completed"]) });

/** Owner-driven status transitions. Running/approving happen through dedicated flows. */
export const PATCH = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return apiError("invalid_id", 400);
  const body = await parseBody(req, Patch);
  if (!body.ok) return body.response;
  const completing = body.data.status === "completed";
  const patch: Record<string, unknown> = { status: body.data.status };
  if (completing) patch.completed_at = new Date().toISOString();
  const { data, error } = await g.supabase.from("missions").update(patch).eq("id", id!).select("*").maybeSingle();
  if (error) return apiError("mission_update_failed", 500);
  if (!data) return apiError("mission_not_found", 404);
  await audit({ event: completing ? "mission_completed" : "mission_updated", ownerId: g.session.userId, targetId: id, request: req, metadata: { status: body.data.status } });
  let outcome = null;
  if (completing && (data.finding_id || data.goal_id)) {
    // Outcome measurement (spec §34): baseline now, post value after the window elapses (cron).
    outcome = await recordBaseline(g.session.userId, { id: data.id, title: data.title, finding_id: data.finding_id ?? null, goal_id: data.goal_id ?? null, completed_at: data.completed_at ?? null });
    if (outcome) await audit({ event: "outcome_recorded", ownerId: g.session.userId, targetId: id, request: req, metadata: { metric: outcome.metric_key, baseline: outcome.baseline_value } });
  }
  return json({ mission: data, outcome });
});
