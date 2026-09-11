import { z } from "zod";
import { apiError, json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { deleteConnection, getConnection, setConnectionStatus } from "@/lib/integrations/store";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const Id = z.string().uuid();

export const GET = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  if (!Id.safeParse(id).success) return apiError("invalid_id", 400);
  const conn = await getConnection(g.session.userId, id!);
  if (!conn) return apiError("connection_not_found", 404);
  return json({ connection: conn });
});

/** DELETE removes the connection AND its encrypted secret (cascade). */
export const DELETE = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  if (!Id.safeParse(id).success) return apiError("invalid_id", 400);
  const conn = await getConnection(g.session.userId, id!);
  if (!conn) return apiError("connection_not_found", 404);
  await deleteConnection(g.session.userId, id!);
  await audit({ event: "connection_removed", ownerId: g.session.userId, provider: conn.provider, targetId: id, request: req });
  return json({ ok: true });
});

/** PATCH pauses/resumes a connection. */
export const PATCH = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  if (!Id.safeParse(id).success) return apiError("invalid_id", 400);
  const body = z.object({ action: z.enum(["pause", "resume"]) }).safeParse(await req.json().catch(() => null));
  if (!body.success) return apiError("invalid_input", 400);
  const conn = await getConnection(g.session.userId, id!);
  if (!conn) return apiError("connection_not_found", 404);
  await setConnectionStatus(id!, { status: body.data.action === "pause" ? "paused" : "reconnect_required" });
  await audit({ event: "connection_updated", ownerId: g.session.userId, provider: conn.provider, targetId: id, request: req, metadata: { action: body.data.action } });
  return json({ ok: true });
});
