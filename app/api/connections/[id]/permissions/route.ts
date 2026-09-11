import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { getConnection, readSecret, setConnectionStatus } from "@/lib/integrations/store";
import { listMetaAssets, type MetaSecret } from "@/lib/integrations/providers/meta";
import { listInstallations, listInstallationRepos, githubConfigured } from "@/lib/integrations/providers/github";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const Id = z.string().uuid();
const Body = z.object({
  selected_ad_accounts: z.array(z.string().max(100)).max(50).optional(),
  selected_pages: z.array(z.string().max(100)).max(50).optional(),
  selected_instagram_accounts: z.array(z.string().max(100)).max(50).optional(),
  selected_repositories: z.array(z.string().max(200)).max(100).optional(),
  installation_id: z.number().int().positive().optional(),
  selected_locations: z.array(z.string().max(100)).max(50).optional(),
});

/** GET lists selectable assets (non-secret ids/names) for a connection. */
export const GET = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  if (!Id.safeParse(id).success) return apiError("invalid_id", 400);
  const conn = await getConnection(g.session.userId, id!);
  if (!conn) return apiError("connection_not_found", 404);
  if (conn.provider === "meta") {
    const secret = await readSecret<MetaSecret>(conn.id);
    if (!secret) return apiError("secret_missing", 409);
    const assets = await listMetaAssets(secret);
    return json({ provider: "meta", assets, selected: conn.metadata });
  }
  if (conn.provider === "github") {
    if (!githubConfigured()) return apiError("provider_not_configured", 409);
    const installs = await listInstallations();
    const repos = await Promise.all(installs.map(async (i) => ({ installation: i, repositories: await listInstallationRepos(i.id) })));
    return json({ provider: "github", assets: repos, selected: conn.metadata });
  }
  return json({ provider: conn.provider, assets: null, selected: conn.metadata });
});

/** PATCH stores the owner's selection. This is a permission change and is audited. */
export const PATCH = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  if (!Id.safeParse(id).success) return apiError("invalid_id", 400);
  const body = await parseBody(req, Body);
  if (!body.ok) return body.response;
  const conn = await getConnection(g.session.userId, id!);
  if (!conn) return apiError("connection_not_found", 404);
  const metadata = { ...conn.metadata, ...body.data };
  await setConnectionStatus(conn.id, { metadata });
  await audit({ event: "connection_permission_changed", ownerId: g.session.userId, provider: conn.provider, targetId: conn.id, request: req, metadata: body.data });
  return json({ ok: true, metadata });
});
