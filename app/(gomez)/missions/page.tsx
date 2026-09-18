import { createClient } from "@/lib/supabase/server";
import { effectiveMode } from "@/lib/mode";
import { loadMissions } from "@/lib/gomez/server-data";
import { DEMO_MISSIONS } from "@/lib/gomez/demo-data";
import { MissionsView, type MissionItem } from "@/components/mission-control/MissionsView";
import { resolveOwnerSession } from "@/lib/auth/session";
import { listOutcomesForMissions } from "@/lib/gomez/outcomes-store";

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
  // Attach outcome measurements (spec §34) to missions that have them.
  const session = await resolveOwnerSession(supabase);
  if (session.status === "owner" && real.length) {
    const outcomes = await listOutcomesForMissions(session.userId, real.map((m) => m.id)).catch(() => []);
    for (const m of real) {
      const o = outcomes.find((x) => x.mission_id === m.id);
      if (o) m.outcome = { metric_label: o.metric_label, metric_key: o.metric_key, baseline_value: o.baseline_value == null ? null : Number(o.baseline_value), post_value: o.post_value == null ? null : Number(o.post_value), delta: o.delta == null ? null : Number(o.delta), delta_pct: o.delta_pct == null ? null : Number(o.delta_pct), direction: o.direction, limitations: o.limitations, implemented_at: o.implemented_at, measured_at: o.measured_at, confounders: o.confounders ?? [] };
    }
  }
  const missions = mode === "demo" ? [...real, ...demoMissionItems()] : real;
  return <MissionsView initial={missions} />;
}
