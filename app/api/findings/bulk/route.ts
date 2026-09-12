import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const Body = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  status: z.enum(["dismissed", "resolved", "acknowledged", "open"]),
});

/** POST /api/findings/bulk — owner-driven bulk status change (never deletes). */
export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const body = await parseBody(req, Body);
  if (!body.ok) return body.response;
  const { data, error } = await g.supabase.from("findings").update({ status: body.data.status }).in("id", body.data.ids).select("id");
  if (error) return apiError("findings_bulk_failed", 500);
  const changed = (data ?? []).length;
  await audit({ event: "finding_feedback", ownerId: g.session.userId, request: req, metadata: { bulk: true, status: body.data.status, count: changed } });
  return json({ ok: true, changed });
});
