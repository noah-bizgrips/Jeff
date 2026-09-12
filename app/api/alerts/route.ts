import { z } from "zod";
import { apiError, json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { listAlerts, runAlertsForOwner } from "@/lib/jeff/alerts/store";
import { IMPORTANCE_LEVELS } from "@/lib/jeff/settings";

export const dynamic = "force-dynamic";

const Query = z.object({
  importance: z.array(z.enum(IMPORTANCE_LEVELS)).optional(),
  status: z.array(z.enum(["open", "acknowledged", "snoozed", "dismissed", "resolved"])).optional(),
  scope: z.array(z.enum(["business", "personal", "financial", "all"])).optional(),
  kind: z.array(z.enum(["finding", "goal", "commitment", "system"])).optional(),
  category: z.array(z.string().max(60)).optional(),
});

/** GET /api/alerts?importance=urgent,important&status=open — Alert center listing. */
export const GET = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const url = new URL(req.url);
  const raw: Record<string, string[]> = {};
  for (const k of ["importance", "status", "scope", "kind", "category"]) {
    const v = url.searchParams.get(k);
    if (v) raw[k] = v.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const q = Query.safeParse(raw);
  if (!q.success) return apiError("invalid_input", 400);
  const alerts = await listAlerts(g.session.userId, { ...q.data, limit: 200 });
  return json({ alerts });
});

/** POST /api/alerts — re-evaluate alerts from current findings/goals/commitments. */
export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  return json(await runAlertsForOwner(g.session.userId));
});
