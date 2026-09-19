import { z } from "zod";
import { json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { generateBriefing } from "@/lib/jeff/briefings";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** POST /api/briefings/generate {kind, force?} — on-demand briefing (idempotent per period unless force). */
export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const body = await parseBody(req, z.object({ kind: z.enum(["daily", "weekly", "monthly"]).default("daily"), force: z.boolean().default(false) }));
  if (!body.ok) return body.response;
  return json(await generateBriefing(g.session.userId, body.data.kind, new Date(), { force: body.data.force }));
});
