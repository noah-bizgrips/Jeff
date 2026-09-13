import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { applyAction, getObligation, listEvents, listSources } from "@/lib/jeff/obligations/store";
import { ObligationActionSchema, bucketOf } from "@/lib/jeff/obligations/types";
import { explainCompletion } from "@/lib/jeff/obligations/completion";

export const dynamic = "force-dynamic";

const Id = z.string().uuid();

/** GET /api/obligations/[id] — detail with sources, timeline and explanation. */
export const GET = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  if (!Id.safeParse(id).success) return apiError("invalid_id", 400);
  const o = await getObligation(g.session.userId, id!);
  if (!o) return apiError("obligation_not_found", 404);
  const [events, sources] = await Promise.all([listEvents(g.session.userId, o.id, 60), listSources(g.session.userId, o.id)]);
  return json({ obligation: { ...o, bucket: bucketOf(o, new Date()) }, events, sources, explanation: explainCompletion(o) });
});

/** PATCH /api/obligations/[id] — complete / confirm / not-complete / snooze / dismiss / cancel / reopen / stop tracking / cadence / strategy / tracking mode. */
export const PATCH = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  if (!Id.safeParse(id).success) return apiError("invalid_id", 400);
  const body = await parseBody(req, ObligationActionSchema);
  if (!body.ok) return body.response;
  const row = await applyAction(g.session.userId, id!, body.data, { actor: "owner", request: req });
  if (!row) return apiError("obligation_not_found", 404);
  return json({ obligation: { ...row, bucket: bucketOf(row, new Date()) } });
});
