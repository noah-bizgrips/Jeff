import { createClient } from "@/lib/supabase/server";
import { effectiveMode } from "@/lib/mode";
import { loadApprovals, loadMissions } from "@/lib/jeff/server-data";
import { ApprovalsView } from "@/components/mission-control/MissionsView";
import { demoMissionItems } from "../missions/page";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const supabase = await createClient();
  const mode = await effectiveMode();
  const [approvals, missions] = await Promise.all([loadApprovals(supabase), loadMissions(supabase)]);
  const review = [...missions, ...(mode === "demo" ? demoMissionItems() : [])].filter((m) => m.status === "review");
  return <ApprovalsView initial={approvals} reviewMissions={review} />;
}
