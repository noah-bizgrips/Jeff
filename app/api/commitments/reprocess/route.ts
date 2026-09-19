import { json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { reclassifyCommitments } from "@/lib/jeff/commitments/reclassify";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/commitments/reprocess — re-run the current commitment classifier
 * over open commitments and retire marketing/vendor/system noise (dismissed,
 * never deleted). Owner + MFA only; idempotent.
 */
export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const summary = await reclassifyCommitments(g.session.userId);
  await audit({ event: "commitments_reprocessed", ownerId: g.session.userId, request: req, metadata: { version: summary.version, scanned: summary.scanned, dismissed: summary.dismissed } });
  return json({ ok: true, ...summary });
});
