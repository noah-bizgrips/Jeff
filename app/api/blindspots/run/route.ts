import { json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { runBlindSpotsForOwner } from "@/lib/gomez/blindspots";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** POST /api/blindspots/run — owner + aal2. Forces today's blind-spot detection now. Counts only. */
export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const summary = await runBlindSpotsForOwner(g.session.userId, new Date(), { force: true });
  return json(summary);
});
