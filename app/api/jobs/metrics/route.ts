import { json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { loadJobsMetrics, METRICS_WINDOW_DAYS } from "@/lib/gomez/jobs/metrics";

export const dynamic = "force-dynamic";

/**
 * GET /api/jobs/metrics?days=30 — owner + aal2. Jobs health (spec §55):
 * runs/day and outcomes per job, AI calls and cost by job (ai_usage feature
 * `job:<slug>`), findings created/suppressed, feedback counts and
 * false-positive rate, and Follow-Through metrics.
 */
export const GET = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const raw = Number(new URL(req.url).searchParams.get("days") ?? METRICS_WINDOW_DAYS);
  const days = Number.isFinite(raw) ? Math.min(90, Math.max(1, Math.round(raw))) : METRICS_WINDOW_DAYS;
  const metrics = await loadJobsMetrics(g.session.userId, new Date(), days);
  return json({ metrics });
});
