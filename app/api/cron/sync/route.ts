import { apiError, json, withErrorBoundary } from "@/lib/api";
import { safeEqual } from "@/lib/crypto/secrets";
import { hasEnv, requireEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncAllForOwner } from "@/lib/integrations/sync/runner";
import { errorMessage, log } from "@/lib/security/log";
import { runMonitorsForOwner } from "@/lib/jeff/monitors";
import { refreshGoals } from "@/lib/jeff/goals/refresh";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET /api/cron/sync — invoked by Vercel Cron (see vercel.json).
 * Authenticated by `Authorization: Bearer <CRON_SECRET>`; there is no user
 * session. Syncs every healthy connection of the bound owner.
 */
export const GET = withErrorBoundary(async (req) => {
  if (!hasEnv("CRON_SECRET")) return apiError("cron_not_configured", 503);
  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${requireEnv("CRON_SECRET")}`;
  if (!safeEqual(header, expected)) return apiError("unauthorized", 401);

  const admin = createAdminClient();
  const { data: owner } = await admin.from("app_owner").select("user_id").eq("id", 1).maybeSingle();
  if (!owner?.user_id) return apiError("owner_not_bound", 409);

  const summaries = await syncAllForOwner(owner.user_id, "schedule");
  log.info("cron_sync", { connections: summaries.length });
  // Re-evaluate findings once the data is fresh. Monitor failures never fail the sync response.
  let monitors: Awaited<ReturnType<typeof runMonitorsForOwner>> | { error: string } = { error: "skipped" };
  if (summaries.length) {
    try {
      monitors = await runMonitorsForOwner(owner.user_id);
    } catch (err) {
      monitors = { error: errorMessage(err) };
      log.warn("cron_monitors_failed", { message: errorMessage(err) });
    }
  }
  // Goals are refreshed from the same fresh data; failures never fail the cron.
  let goals: { refreshed: number; changed: number } | { error: string } = { error: "skipped" };
  try {
    const results = await refreshGoals(owner.user_id);
    goals = { refreshed: results.length, changed: results.filter((r) => r.changed).length };
  } catch (err) {
    goals = { error: errorMessage(err) };
    log.warn("cron_goals_failed", { message: errorMessage(err) });
  }
  return json({
    ok: true,
    goals,
    synced: summaries.map((s) => ({ provider: s.provider, results: s.results.map((r) => ({ capability: r.capability, seen: r.seen, upserted: r.upserted, error: r.error ?? null })) })),
    monitors,
  });
});
