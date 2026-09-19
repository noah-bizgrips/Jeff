import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { updateCommitment } from "@/lib/jeff/commitments/store";

export const dynamic = "force-dynamic";

export const PATCH = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return apiError("invalid_id", 400);
  const body = await parseBody(req, z.object({ status: z.enum(["done", "dismissed", "open"]) }));
  if (!body.ok) return body.response;
  const commitment = await updateCommitment(g.session.userId, id!, body.data.status);
  if (!commitment) return apiError("commitment_not_found", 404);
  await audit({ event: "commitment_updated", ownerId: g.session.userId, targetId: id, request: req, metadata: { status: body.data.status } });
  return json({ commitment });
});
