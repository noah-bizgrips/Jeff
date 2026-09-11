import { json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { listConnections } from "@/lib/integrations/store";
import { PROVIDERS } from "@/lib/integrations/registry";
import { hasEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

/** GET /api/connections — catalog + owner connections. Never includes secrets. */
export const GET = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const connections = await listConnections(g.session.userId);
  const catalog = PROVIDERS.map((p) => ({
    ...p,
    configured: p.requiredEnv.every(hasEnv),
    missingEnv: p.requiredEnv.filter((n) => !hasEnv(n)),
  }));
  return json({ catalog, connections });
});
