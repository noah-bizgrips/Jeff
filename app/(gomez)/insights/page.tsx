import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { loadFindings } from "@/lib/gomez/server-data";
import { DEMO_INSIGHTS } from "@/lib/gomez/demo-data";
import { InsightsView } from "@/components/mission-control/InsightsView";
import { MONITORS } from "@/lib/gomez/monitors";

export const dynamic = "force-dynamic";

export default async function InsightsPage() {
  const supabase = await createClient();
  const findings = await loadFindings(supabase);
  return (
    <Suspense>
      <InsightsView findings={findings} demoInsights={DEMO_INSIGHTS} liveMonitors={MONITORS.length + 1} />
    </Suspense>
  );
}
