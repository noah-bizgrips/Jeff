import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { audit } from "@/lib/audit";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { getRun } from "@/lib/jeff/jobs";
import { PROGRESS_LABEL, type ProgressStep } from "@/lib/jeff/jobs/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { redact } from "@/lib/security/redact";

export const dynamic = "force-dynamic";

const FINDING_COLUMNS = "id, category, severity, title, summary, evidence, status, job_id, job_run_id, goal_id, first_seen_at, last_seen_at, metrics";

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

const FeedbackBody = z.object({ index: z.number().int().min(0).max(49), verdict: z.enum(["useful", "wrong", "too_noisy"]) });

/**
 * PATCH /api/jobs/runs/{id} — feedback on a TEST MODE result. Test results are
 * not findings, so the verdict is stored on the run's result entry (and
 * audited); rules are the way to change behaviour, offered separately.
 */
export const PATCH = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return apiError("invalid_id", 400);
  const body = await parseBody(req, FeedbackBody);
  if (!body.ok) return body.response;
  const run = await getRun(g.session.userId, id!);
  if (!run) return apiError("run_not_found", 404);
  if (run.mode !== "test") return apiError("not_a_test_run", 409);
  const results = [...(run.results as unknown as Record<string, unknown>[])];
  if (!results[body.data.index]) return apiError("result_not_found", 404);
  results[body.data.index] = { ...results[body.data.index], feedback: body.data.verdict, feedback_at: new Date().toISOString() };
  const admin = createAdminClient();
  const { error } = await admin.from("job_runs").update({ results }).eq("id", run.id).eq("owner_id", g.session.userId);
  if (error) return apiError("feedback_failed", 500);
  await audit({ event: "finding_feedback", ownerId: g.session.userId, targetId: run.id, request: req, metadata: { verdict: body.data.verdict, test_run: true, job_id: run.job_id, index: body.data.index } });
  return json({ ok: true });
});
