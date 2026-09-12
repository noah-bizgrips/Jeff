import { z } from "zod";
import { apiError, json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { getRun } from "@/lib/jeff/jobs";
import { PROGRESS_LABEL, type ProgressStep } from "@/lib/jeff/jobs/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { redact } from "@/lib/security/redact";

export const dynamic = "force-dynamic";

const FINDING_COLUMNS = "id, category, severity, title, summary, evidence, status, job_id, job_run_id, goal_id, first_seen_at, last_seen_at";

/**
 * GET /api/jobs/runs/{id} — poll a run. While running: status + progress step
 * and label. When finished: coverage, stats, notes, test results (test mode)
 * or the findings this run created/updated (run mode).
 */
export const GET = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return apiError("invalid_id", 400);
  const run = await getRun(g.session.userId, id!);
  if (!run) return apiError("run_not_found", 404);
  const raw = (run.stats as { progress?: string } | null)?.progress;
  const progress: ProgressStep = raw && raw in PROGRESS_LABEL ? (raw as ProgressStep) : run.status === "running" ? "preparing" : "complete";
  let findings: unknown[] = [];
  if (run.status !== "running" && run.mode !== "test") {
    const admin = createAdminClient();
    const { data } = await admin.from("findings").select(FINDING_COLUMNS).eq("owner_id", g.session.userId).eq("job_run_id", run.id).order("last_seen_at", { ascending: false }).limit(20);
    findings = (redact(data ?? []) as unknown[]) ?? [];
  }
  return json({ run, progress, progress_label: PROGRESS_LABEL[progress], findings });
});
