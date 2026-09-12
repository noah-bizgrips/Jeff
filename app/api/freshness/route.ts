import { json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { loadFreshness } from "@/lib/jeff/freshness-store";
import { freshnessSummary } from "@/lib/jeff/freshness";

export const dynamic = "force-dynamic";

export const GET = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const items = await loadFreshness(g.session.userId);
  return json({ freshness: items, summary: freshnessSummary(items) });
});
