import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const Patch = z.object({ status: z.enum(["draft", "queued", "cancelled", "review"]) });

/** Owner-driven status transitions. Running/approving happen through dedicated flows. */
export const PATCH = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return apiError("invalid_id", 400);
  const body = await parseBody(req, Patch);
  if (!body.ok) return body.response;
  const { data, error } = await g.supabase.from("missions").update({ status: body.data.status }).eq("id", id!).select("*").maybeSingle();
  if (error) return apiError("mission_update_failed", 500);
  if (!data) return apiError("mission_not_found", 404);
  await audit({ event: "mission_updated", ownerId: g.session.userId, targetId: id, request: req, metadata: { status: body.data.status } });
  return json({ mission: data });
});
