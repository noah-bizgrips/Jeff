import { createClient } from "@/lib/supabase/server";
import { resolveOwnerSession } from "@/lib/auth/session";
import { ensureJobs, presentJobs } from "@/lib/gomez/jobs";
import { JobsView } from "@/components/jobs/JobsView";
import type { JobItem } from "@/components/jobs/types";

export const dynamic = "force-dynamic";

export default async function JobsPage() {
  const supabase = await createClient();
  const session = await resolveOwnerSession(supabase);
  if (session.status !== "owner") return null;
  const jobs = await ensureJobs(session.userId).catch(() => []);
  const items = (await presentJobs(session.userId, jobs).catch(() => [])) as JobItem[];
  return <JobsView initial={items} />;
}
