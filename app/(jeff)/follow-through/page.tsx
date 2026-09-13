import { createClient } from "@/lib/supabase/server";
import { resolveOwnerSession } from "@/lib/auth/session";
import { countBuckets, listObligations } from "@/lib/jeff/obligations/store";
import { bucketOf } from "@/lib/jeff/obligations/types";
import { FollowThroughView, type ObligationView } from "@/components/follow-through/FollowThroughView";

export const dynamic = "force-dynamic";

export default async function FollowThroughPage() {
  const supabase = await createClient();
  const session = await resolveOwnerSession(supabase);
  if (session.status !== "owner") return null;
  const now = new Date();
  const rows = await listObligations(session.userId, { live: true, limit: 300 }).catch(() => []);
  const initial: ObligationView[] = rows.map((o) => ({ ...o, bucket: bucketOf(o, now) }));
  return <FollowThroughView initial={initial} counts={countBuckets(rows, now)} />;
}
