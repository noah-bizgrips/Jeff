import { createClient } from "@/lib/supabase/server";
import { effectiveMode } from "@/lib/mode";
import { loadMissions } from "@/lib/jeff/server-data";
import { DEMO_MISSIONS } from "@/lib/jeff/demo-data";
import { MissionsView, type MissionItem } from "@/components/mission-control/MissionsView";

export const dynamic = "force-dynamic";

export function demoMissionItems(): MissionItem[] {
  return DEMO_MISSIONS.map((m) => ({
    id: m.id,
    code: m.id,
    title: m.title,
    goal: m.goal,
    status: m.status,
    worker: m.tool.includes("n8n") ? "n8n" : "claude",
    environment: "sandbox",
    budgetUsd: m.budget,
    timeLimitMin: m.minutes,
    maxRetries: 2,
    createdAt: new Date().toISOString(),
    isSample: true,
  }));
}

export default async function MissionsPage() {
  const supabase = await createClient();
  const mode = await effectiveMode();
  const real = await loadMissions(supabase);
  const missions = mode === "demo" ? [...real, ...demoMissionItems()] : real;
  return <MissionsView initial={missions} />;
}
