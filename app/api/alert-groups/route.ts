import { z } from "zod";
import { apiError, json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { listAlertGroups, syncAlertGroups } from "@/lib/jeff/grouping/store";

export const dynamic = "force-dynamic";

const Query = z.object({
  status: z.array(z.enum(["open", "acknowledged", "snoozed", "dismissed", "resolved"])).optional(),
});

/** GET /api/alert-groups?status=open,acknowledged — grouped situations with their live members. */
export const GET = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const url = new URL(req.url);
  const raw: Record<string, string[]> = {};
  const status = url.searchParams.get("status");
  if (status) raw.status = status.split(",").map((s) => s.trim()).filter(Boolean);
  const q = Query.safeParse(raw);
  if (!q.success) return apiError("invalid_input", 400);
  const groups = await listAlertGroups(g.session.userId, { status: q.data.status, limit: 100 });
  return json({ groups });
});

/** POST /api/alert-groups — re-run grouping over the current alerts / follow-through items. */
export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  return json(await syncAlertGroups(g.session.userId));
});
