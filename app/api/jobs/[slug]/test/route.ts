import { apiError, json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { getJob, runJob } from "@/lib/gomez/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/jobs/{slug}/test — TEST MODE. Analyses current data and returns
 * what the job WOULD find. Creates no findings, alerts, notifications or
 * missions; the only write is the job_runs row (mode = test).
 */
export const POST = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { slug } = await ctx.params;
  const job = slug ? await getJob(g.session.userId, slug) : null;
  if (!job) return apiError("job_not_found", 404);
  const out = await runJob(g.session.userId, job, { mode: "test" });
  await audit({ event: "job_test", ownerId: g.session.userId, targetId: job.id, request: req, metadata: { slug: job.slug, status: out.status, candidates: out.stats.candidates } });
  return json(out);
});
