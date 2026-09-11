import { createClient } from "@/lib/supabase/server";
import { loadFindings } from "@/lib/jeff/server-data";
import { DEMO_INSIGHTS } from "@/lib/jeff/demo-data";
import { InsightsView } from "@/components/mission-control/InsightsView";

export const dynamic = "force-dynamic";

export default async function InsightsPage() {
  const supabase = await createClient();
  const findings = await loadFindings(supabase);
  return <InsightsView findings={findings} demoInsights={DEMO_INSIGHTS} liveMonitors={0} />;
}
