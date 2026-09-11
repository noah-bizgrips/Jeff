import { z } from "zod";
import { json, apiError, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAnyAal } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

const Body = z.object({ factorId: z.string().min(1).max(200) });

export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAnyAal(req);
  if (!g.ok) return g.response;
  const body = await parseBody(req, Body);
  if (!body.ok) return body.response;
  const { data, error } = await g.supabase.auth.mfa.challenge({ factorId: body.data.factorId });
  if (error || !data) return apiError("mfa_challenge_failed", 400);
  return json({ challengeId: data.id });
});
