import { z } from "zod";
import { json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { connectedProviders } from "@/lib/gomez/jobs";
import { interpretJob } from "@/lib/gomez/jobs/interpret";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({ description: z.string().trim().min(8).max(1000) });

/**
 * POST /api/jobs/interpret — NL → JobDefinitionInterpretation proposal.
 * Creates nothing; the Add Job modal shows the proposal (sources it will use,
 * what it would still need, limitations, ambiguities) before the owner confirms.
 */
export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const body = await parseBody(req, Body);
  if (!body.ok) return body.response;
  const connected = await connectedProviders(g.session.userId);
  const res = await interpretJob(g.session.userId, body.data.description, connected);
  return json({ interpretation: res.interpretation, used_model: res.usedModel, connected });
});
