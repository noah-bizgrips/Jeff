import { json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { connectedProviders, listTemplates } from "@/lib/jeff/jobs";

export const dynamic = "force-dynamic";

/** GET /api/jobs/templates — catalog grouped by category, with which sources are still missing for each. */
export const GET = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const connected = await connectedProviders(g.session.userId);
  const templates = listTemplates().map((t) => ({ ...t, missing_sources: (t.scaffold?.sources ?? []).filter((s: string) => !connected.includes(s)) }));
  return json({ templates, connected });
});
