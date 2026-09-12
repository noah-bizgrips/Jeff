import { apiError, json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { getJob } from "@/lib/jeff/jobs";
import { createAdminClient } from "@/lib/supabase/admin";
import { redact } from "@/lib/security/redact";

export const dynamic = "force-dynamic";

const COLUMNS = "id, category, severity, title, summary, evidence, status, fingerprint, first_seen_at, last_seen_at, resolved_at, job_id, job_run_id, goal_id, created_at";
const OPEN_STATUSES = ["open", "new", "reviewing", "acknowledged", "accepted", "in_progress", "action_planned", "action_in_progress", "monitoring"];

/** GET /api/jobs/{slug}/findings?status=open|all&limit=50 — findings this job produced, newest first. */
export const GET = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { slug } = await ctx.params;
  const job = slug ? await getJob(g.session.userId, slug) : null;
  if (!job) return apiError("job_not_found", 404);
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? "open";
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
  const admin = createAdminClient();
  let q = admin.from("findings").select(COLUMNS).eq("owner_id", g.session.userId).eq("job_id", job.id);
  if (status === "open") q = q.in("status", OPEN_STATUSES);
  const { data, error } = await q.order("last_seen_at", { ascending: false }).limit(limit);
  if (error) return apiError("findings_failed", 500);
  return json({ findings: redact(data ?? []) });
});
