import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { findConnectionByProvider, getConnection } from "@/lib/integrations/store";
import { hasSyncAdapter, syncConnection } from "@/lib/integrations/sync/runner";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const Body = z
  .object({
    connectionId: z.string().uuid().optional(),
    capabilities: z.array(z.string().min(1).max(40)).max(10).optional(),
  })
  .default({});

/**
 * POST /api/sync/{provider} — owner + aal2 manual sync trigger.
 * Returns per-capability counts only; never tokens or record bodies.
 */
export const POST = withErrorBoundary(async (req, ctx) => {
  const { provider = "" } = await ctx.params;
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  if (!hasSyncAdapter(provider)) return apiError("sync_not_supported", 404);
  const raw = await req.text();
  const body = await parseBody(new Request(req.url, { method: "POST", headers: req.headers, body: raw || "{}" }), Body);
  if (!body.ok) return body.response;
  const conn = body.data.connectionId ? await getConnection(g.session.userId, body.data.connectionId) : await findConnectionByProvider(g.session.userId, provider);
  if (!conn) return apiError("connection_not_found", 404);
  if (conn.provider !== provider) return apiError("provider_mismatch", 400);
  if (!["connected", "limited"].includes(conn.status)) return apiError("connection_not_ready", 409, { status: conn.status });
  const summary = await syncConnection(g.session.userId, conn, { capabilities: body.data.capabilities, trigger: "manual" });
  return json(summary);
});
