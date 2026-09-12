import { createClient } from "@/lib/supabase/server";
import { effectiveMode } from "@/lib/mode";
import { loadFindings } from "@/lib/jeff/server-data";
import { DEMO_INSIGHTS } from "@/lib/jeff/demo-data";
import { MissionControl, type GoalRiskItem } from "@/components/brain/MissionControl";
import { resolveOwnerSession } from "@/lib/auth/session";
import { latestSnapshot, listGoalMetrics, listGoals } from "@/lib/jeff/goals/store";
import { TRAJECTORY_LABEL } from "@/lib/jeff/goals/schema";
import { formatMetricValue, formatTarget } from "@/lib/jeff/goals/metrics";

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
  const goalsAtRisk: GoalRiskItem[] = [];
  const nowMs = new Date().getTime();
  if (mode === "live") {
    const supabase = await createClient();
    const session = await resolveOwnerSession(supabase);
    if (session.status === "owner") {
      const goals = await listGoals(session.userId, ["active"]).catch(() => []);
      for (const goal of goals) {
        const snap = await latestSnapshot(goal.id).catch(() => null);
        if (!snap || !["slightly_at_risk", "at_risk", "severely_at_risk"].includes(snap.trajectory)) continue;
        const metrics = await listGoalMetrics(goal.id).catch(() => []);
        const primary = metrics.find((m) => m.is_primary) ?? metrics[0];
        const p = primary ? snap.metrics?.[primary.key] : null;
        goalsAtRisk.push({
          id: goal.id,
          name: goal.name,
          trajectory: snap.trajectory,
          label: TRAJECTORY_LABEL[snap.trajectory],
          primary: p ? `${formatMetricValue(p)} of ${formatTarget(p)}` : null,
          constraint: snap.constraint_key,
          daysRemaining: goal.end_date ? Math.max(0, Math.round((Date.parse(goal.end_date) - nowMs) / 86_400_000)) : null,
        });
      }
    }
  }
  return <MissionControl topInsight={top} goalsAtRisk={goalsAtRisk} />;
}
