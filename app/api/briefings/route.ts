import { json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { listBriefings } from "@/lib/gomez/briefings";

export const dynamic = "force-dynamic";

export const GET = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  return json({ briefings: await listBriefings(g.session.userId, 30) });
});
