import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

const Patch = z.object({ status: z.enum(["open", "acknowledged", "in_progress", "resolved", "dismissed"]) });

export const PATCH = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return apiError("invalid_id", 400);
  const body = await parseBody(req, Patch);
  if (!body.ok) return body.response;
  const { data, error } = await g.supabase.from("findings").update({ status: body.data.status }).eq("id", id!).select("id, status").maybeSingle();
  if (error) return apiError("finding_update_failed", 500);
  if (!data) return apiError("finding_not_found", 404);
  return json({ finding: data });
});
