import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveOwnerSession } from "@/lib/auth/session";
import { ensureJobs, listRuns, presentJobs } from "@/lib/jeff/jobs";
import { JobDetailView } from "@/components/jobs/JobDetailView";
import type { JobItem } from "@/components/jobs/types";

export const dynamic = "force-dynamic";

export default async function JobDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createClient();
  const session = await resolveOwnerSession(supabase);
  if (session.status !== "owner") return null;
  const jobs = await ensureJobs(session.userId).catch(() => []);
  const job = jobs.find((j) => j.slug === slug || j.id === slug);
  if (!job) notFound();
  const [pres] = (await presentJobs(session.userId, [job])) as JobItem[];
  const runs = await listRuns(session.userId, job.id, 20).catch(() => []);
  return <JobDetailView initialJob={pres!} initialRuns={runs} />;
}
