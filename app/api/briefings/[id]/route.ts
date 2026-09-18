import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { recordAttention } from "@/lib/gomez/attention/store";
import { audit } from "@/lib/audit";
import { getBriefing, updateBriefing } from "@/lib/gomez/briefings";

export const dynamic = "force-dynamic";

export const GET = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return apiError("invalid_id", 400);
  const briefing = await getBriefing(g.session.userId, id!);
  if (!briefing) return apiError("briefing_not_found", 404);
  return json({ briefing });
});

export const PATCH = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return apiError("invalid_id", 400);
  const body = await parseBody(req, z.object({ action: z.enum(["read", "save", "unsave"]) }));
  if (!body.ok) return body.response;
  const briefing = await updateBriefing(g.session.userId, id!, body.data.action);
  if (!briefing) return apiError("briefing_not_found", 404);
  await audit({ event: "briefing_updated", ownerId: g.session.userId, targetId: id, request: req, metadata: { action: body.data.action } });
  if (body.data.action === "read") void recordAttention(g.session.userId, [{ kind: "briefing_read", ref_id: id }]);
  return json({ briefing });
});
