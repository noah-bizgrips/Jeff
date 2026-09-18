import { json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { getBrainState } from "@/lib/gomez/brain/load";

export const dynamic = "force-dynamic";

/** GET /api/brain/state — read-only aggregate of what Gomez currently sees (spec §6). json() is no-store. */
export const GET = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const brain = await getBrainState(g.session.userId);
  return json({ brain });
});
