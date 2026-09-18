import { createClient } from "@/lib/supabase/server";
import { resolveOwnerSession } from "@/lib/auth/session";
import { listBriefings } from "@/lib/gomez/briefings";
import { BriefingsView, type BriefingListItem } from "@/components/briefings/BriefingsView";

export const dynamic = "force-dynamic";

export default async function BriefingsPage() {
  const supabase = await createClient();
  const session = await resolveOwnerSession(supabase);
  if (session.status !== "owner") return null;
  const briefings = await listBriefings(session.userId, 30).catch(() => []);
  return <BriefingsView initial={briefings as unknown as BriefingListItem[]} />;
}
