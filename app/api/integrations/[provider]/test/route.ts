import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { getProvider } from "@/lib/integrations/registry";
import { findConnectionByProvider, getConnection, upsertConnection } from "@/lib/integrations/store";
import { runConnectionTest } from "@/lib/integrations/test";
import { audit } from "@/lib/audit";
import { hasEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

const Body = z.object({ connectionId: z.string().uuid().optional() }).default({});

/**
 * POST /api/integrations/{provider}/test
 * Runs the provider's harmless verification for an existing connection.
 * For env-configured tools (n8n, github, portal) a connection row is created on the fly.
 * Response never includes credentials.
 */
export const POST = withErrorBoundary(async (req, ctx) => {
  const { provider = "" } = await ctx.params;
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const def = getProvider(provider);
  if (!def) return apiError("unknown_provider", 404);
  const body = await parseBody(req, Body);
  if (!body.ok) return body.response;

  let conn = body.data.connectionId
    ? await getConnection(g.session.userId, body.data.connectionId)
    : await findConnectionByProvider(g.session.userId, provider);

  if (!conn && (provider === "n8n" || provider === "github" || provider === "portal")) {
    const missing = def.requiredEnv.filter((n) => !hasEnv(n));
    if (missing.length) return apiError("provider_not_configured", 409, { missingEnv: missing });
    conn = await upsertConnection({
      ownerId: g.session.userId,
      provider,
      displayName: def.name,
      status: "testing",
      accessMode: def.access,
      capabilities: def.capabilities.map((c) => c.id),
    });
    await audit({ event: "connection_created", ownerId: g.session.userId, provider, targetId: conn.id, request: req });
  }
  if (!conn) return apiError("connection_not_found", 404);
  if (conn.provider !== provider) return apiError("provider_mismatch", 400);

  const result = await runConnectionTest(conn);
  await audit({ event: "connection_tested", ownerId: g.session.userId, provider, targetId: conn.id, request: req, metadata: { ok: result.ok, limited: !!result.limited } });
  const updated = await getConnection(g.session.userId, conn.id);
  return json({ ok: result.ok, limited: !!result.limited, error: result.error ?? null, details: result.details ?? null, connection: updated });
});
