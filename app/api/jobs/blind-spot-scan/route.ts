import { after } from "next/server";
import { apiError, json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { ensureJobs, runJob } from "@/lib/jeff/jobs";
import { errorMessage, log } from "@/lib/security/log";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/jobs/blind-spot-scan — "✦ Find what I'm missing". Runs the Blind
 * Spot Scanner job in run mode. Responds as soon as the job_runs row exists,
 * with its id as `scanId`; the scan continues via after() and writes progress
 * to job_runs.stats.progress, which GET /api/jobs/runs/{scanId} exposes.
 */
export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const jobs = await ensureJobs(g.session.userId);
  const job = jobs.find((j) => j.slug === "blind-spot-scanner");
  if (!job) return apiError("job_not_found", 404);
  if (job.status === "disabled") return apiError("job_disabled", 409);
  const scanId = await new Promise<string>((resolve, reject) => {
    const run = runJob(g.session.userId, job, { mode: "run", onStart: resolve });
    run.catch(reject);
    after(() => run.catch((err) => log.warn("blind_spot_scan_failed", { message: errorMessage(err) })));
  });
  return json({ scanId, status: "running", progress: "preparing" }, { status: 202 });
});
