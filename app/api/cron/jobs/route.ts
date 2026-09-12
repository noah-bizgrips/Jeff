import { apiError, json, withErrorBoundary } from "@/lib/api";
import { safeEqual } from "@/lib/crypto/secrets";
import { hasEnv, requireEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensureJobs, runDueJobs } from "@/lib/jeff/jobs";
import { log } from "@/lib/security/log";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET /api/cron/jobs — every 15 minutes (vercel.json). Seeds the system
 * roster idempotently and runs every job whose schedule is due, inside a
 * time budget. Bearer CRON_SECRET; no user session.
 */
export const GET = withErrorBoundary(async (req) => {
  if (!hasEnv("CRON_SECRET")) return apiError("cron_not_configured", 503);
  const header = req.headers.get("authorization") ?? "";
  if (!safeEqual(header, `Bearer ${requireEnv("CRON_SECRET")}`)) return apiError("unauthorized", 401);
  const admin = createAdminClient();
  const { data: owner } = await admin.from("app_owner").select("user_id").eq("id", 1).maybeSingle();
  if (!owner?.user_id) return apiError("owner_not_bound", 409);
  const now = new Date();
  const jobs = await ensureJobs(owner.user_id, now);
  const result = await runDueJobs(owner.user_id, jobs, now, 240_000);
  log.info("cron_jobs", { ran: result.ran.length, skipped: result.skipped.length });
  return json({ ok: true, ...result });
});
