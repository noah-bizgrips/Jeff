import { json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { runMonitorsForOwner } from "@/lib/jeff/monitors";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/monitors/run — owner + aal2. Re-evaluates every findings monitor
 * against synced (non-sample) data. Returns counts only.
 */
export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const summary = await runMonitorsForOwner(g.session.userId);
  await audit({ event: "sync_completed", ownerId: g.session.userId, provider: "monitors", request: req, metadata: { ...summary, errors: summary.errors.length } });
  return json(summary);
});
