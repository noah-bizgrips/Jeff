import { apiError, json, withErrorBoundary } from "@/lib/api";
import { safeEqual } from "@/lib/crypto/secrets";
import { hasEnv, requireEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateDueBriefings } from "@/lib/jeff/briefings";
import { measureOutcomes } from "@/lib/jeff/outcomes-store";
import { errorMessage, log } from "@/lib/security/log";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * GET /api/cron/briefings — every 15 minutes (vercel.json). Generates any
 * briefing that is due in the owner's timezone and not yet generated, and
 * measures mission outcomes whose window has elapsed. Bearer CRON_SECRET.
 */
export const GET = withErrorBoundary(async (req) => {
  if (!hasEnv("CRON_SECRET")) return apiError("cron_not_configured", 503);
  const header = req.headers.get("authorization") ?? "";
  if (!safeEqual(header, `Bearer ${requireEnv("CRON_SECRET")}`)) return apiError("unauthorized", 401);
  const admin = createAdminClient();
  const { data: owner } = await admin.from("app_owner").select("user_id").eq("id", 1).maybeSingle();
  if (!owner?.user_id) return apiError("owner_not_bound", 409);
  const now = new Date();
  const briefings = await generateDueBriefings(owner.user_id, now);
  let outcomes: { measured: number; pending: number } | { error: string } = { error: "skipped" };
  try {
    outcomes = await measureOutcomes(owner.user_id, now);
  } catch (err) {
    outcomes = { error: errorMessage(err) };
    log.warn("cron_outcomes_failed", { message: errorMessage(err) });
  }
  return json({ ok: true, briefings, outcomes });
});
