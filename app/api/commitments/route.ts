import { z } from "zod";
import { apiError, json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { listCommitments, runCommitmentsForOwner } from "@/lib/gomez/commitments/store";

export const dynamic = "force-dynamic";

const Status = z.array(z.enum(["open", "done", "dismissed", "overdue"]));

export const GET = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const raw = new URL(req.url).searchParams.get("status");
  const status = raw ? Status.safeParse(raw.split(",")) : null;
  if (status && !status.success) return apiError("invalid_input", 400);
  const commitments = await listCommitments(g.session.userId, { status: status?.data ?? ["open", "overdue"] });
  return json({ commitments });
});

/** POST /api/commitments — re-scan synced conversations now. */
export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  return json(await runCommitmentsForOwner(g.session.userId));
});
