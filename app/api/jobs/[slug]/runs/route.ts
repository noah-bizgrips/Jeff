import { apiError, json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { getJob, listRuns } from "@/lib/jeff/jobs";

export const dynamic = "force-dynamic";

/** GET /api/jobs/{slug}/runs?limit=20 — run history (newest first). */
export const GET = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { slug } = await ctx.params;
  const job = slug ? await getJob(g.session.userId, slug) : null;
  if (!job) return apiError("job_not_found", 404);
  const limit = Math.min(100, Math.max(1, Number(new URL(req.url).searchParams.get("limit") ?? 20) || 20));
  const runs = await listRuns(g.session.userId, job.id, limit);
  return json({ runs });
});
