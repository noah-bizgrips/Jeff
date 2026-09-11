import { createClient } from "@/lib/supabase/server";
import { effectiveMode } from "@/lib/mode";
import { loadFindings } from "@/lib/jeff/server-data";
import { DEMO_INSIGHTS } from "@/lib/jeff/demo-data";
import { MissionControl } from "@/components/brain/MissionControl";

export const dynamic = "force-dynamic";

export default async function Home() {
  const mode = await effectiveMode();
  let top = mode === "demo" ? (DEMO_INSIGHTS[0] ?? null) : null;
  if (mode === "live") {
    const supabase = await createClient();
    const findings = await loadFindings(supabase);
    const f = findings.find((x) => x.status === "open");
    if (f) top = { id: f.id, label: f.category.toUpperCase(), title: f.title, body: f.interpretation ?? "", evidence: `${f.evidence.length} evidence items`, goal: f.proposedMission?.goal ?? "", source: "" };
  }
  return <MissionControl topInsight={top} />;
}
