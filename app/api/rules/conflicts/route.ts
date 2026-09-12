import { json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { listRules } from "@/lib/jeff/rules/store";
import { detectConflicts } from "@/lib/jeff/rules/conflicts";

export const dynamic = "force-dynamic";

export const GET = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const rules = await listRules(g.session.userId);
  return json({ conflicts: detectConflicts(rules) });
});
