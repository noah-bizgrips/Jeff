import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { draftGroupMission, getAlertGroup, updateAlertGroup } from "@/lib/gomez/grouping/store";

export const dynamic = "force-dynamic";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("acknowledge") }),
  z.object({ action: z.literal("snooze"), until: z.string().datetime().optional(), hours: z.number().int().min(1).max(24 * 14).optional() }),
  z.object({ action: z.literal("dismiss") }),
  z.object({ action: z.literal("reopen") }),
  /** Draft-only: a sandbox mission that drafts a reminder listing what is waiting on the client. Nothing is sent. */
  z.object({ action: z.literal("remind_client") }),
  /** Draft-only: a sandbox mission to prepare the most useful next action for the situation. */
  z.object({ action: z.literal("prepare_action") }),
]);

/** GET /api/alert-groups/[id] — one group with members (task, due, days overdue, owner, priority, status, notes). */
export const GET = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return apiError("invalid_id", 400);
  const group = await getAlertGroup(g.session.userId, id!);
  if (!group) return apiError("group_not_found", 404);
  return json({ group });
});

export const PATCH = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return apiError("invalid_id", 400);
  const body = await parseBody(req, Body);
  if (!body.ok) return body.response;
  const group = await getAlertGroup(g.session.userId, id!);
  if (!group) return apiError("group_not_found", 404);
  const now = new Date();

  if (body.data.action === "remind_client" || body.data.action === "prepare_action") {
    const mission = await draftGroupMission(g.session.userId, group, body.data.action);
    if (!mission) return apiError("mission_create_failed", 500);
    await audit({ event: "alert_group_updated", ownerId: g.session.userId, targetId: id, request: req, metadata: { action: body.data.action, mission: mission.code } });
    return json({ group, mission });
  }

  const action = body.data.action === "snooze" ? { action: "snooze" as const, until: body.data.until ?? new Date(now.getTime() + (body.data.hours ?? 24) * 3_600_000).toISOString() } : { action: body.data.action };
  const updated = await updateAlertGroup(g.session.userId, id!, action, now);
  await audit({ event: "alert_group_updated", ownerId: g.session.userId, targetId: id, request: req, metadata: { action: body.data.action } });
  return json({ group: updated });
});
