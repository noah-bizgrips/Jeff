import { apiError, json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { getJob, runJob } from "@/lib/gomez/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** POST /api/jobs/{slug}/run — runs the job now for real (findings, alerts under its notification policy). Audited by the runner as job_run. */
export const POST = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { slug } = await ctx.params;
  const job = slug ? await getJob(g.session.userId, slug) : null;
  if (!job) return apiError("job_not_found", 404);
  if (!job.detectors.length) return apiError("job_has_no_detectors", 409);
  if (job.status === "disabled") return apiError("job_disabled", 409);
  const out = await runJob(g.session.userId, job, { mode: "run" });
  return json(out);
});
