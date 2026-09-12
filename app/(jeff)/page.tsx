import { createClient } from "@/lib/supabase/server";
import { effectiveMode } from "@/lib/mode";
import { loadFindings } from "@/lib/jeff/server-data";
import { DEMO_INSIGHTS } from "@/lib/jeff/demo-data";
import { MissionControl, type FocusData, type GoalRiskItem } from "@/components/brain/MissionControl";
import { surfacedAlerts } from "@/lib/jeff/alerts/store";
import { listCommitments } from "@/lib/jeff/commitments/store";
import { loadFreshness } from "@/lib/jeff/freshness-store";
import { getSettings } from "@/lib/jeff/settings-store";
import { localTime } from "@/lib/jeff/settings";
import { periodInstants } from "@/lib/jeff/briefings/schedule";
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
  let focus: FocusData | null = null;
  if (mode === "live") {
    const supabase = await createClient();
    const session = await resolveOwnerSession(supabase);
    if (session.status === "owner") {
      const now = new Date();
      const settings = await getSettings(session.userId).catch(() => null);
      const tz = settings?.timezone ?? "America/Denver";
      const today = localTime(now, tz).date;
      const { start, end } = periodInstants(today, today, tz);
      const [alerts, commitments, freshness, findings, missions, events] = await Promise.all([
        surfacedAlerts(session.userId, now, 8),
        listCommitments(session.userId, { status: ["open", "overdue"], limit: 20 }).catch(() => []),
        loadFreshness(session.userId, now).catch(() => []),
        loadFindings(supabase).catch(() => []),
        supabase.from("missions").select("id, code, title, status").in("status", ["queued", "running", "review", "approved", "action_in_progress"]).order("updated_at", { ascending: false }).limit(6),
        supabase.from("source_items").select("id, title, source_timestamp, metadata").eq("resource_type", "event").eq("is_sample", false).gte("source_timestamp", start.toISOString()).lte("source_timestamp", end.toISOString()).order("source_timestamp", { ascending: true }).limit(8),
      ]);
      const fmt = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(iso)) : "");
      focus = {
        attention: alerts.map((a) => ({ id: a.id, kind: a.kind, importance: a.importance, title: a.title, summary: a.summary, occurrences: a.occurrences })),
        opportunities: findings.filter((f) => ["open", "new", "accepted"].includes(f.status)).slice(0, 6).map((f) => ({ id: f.id, category: f.category, title: f.title, severity: f.severity })),
        today: [
          ...(events.data ?? []).map((e) => ({ kind: "event" as const, id: e.id, title: e.title ?? "Event", detail: fmt(e.source_timestamp), when: e.source_timestamp })),
          ...commitments.filter((c) => c.status === "overdue" || (c.due_at && c.due_at.slice(0, 10) <= today)).slice(0, 6).map((c) => ({ kind: "commitment" as const, id: c.id, title: c.action_text, detail: c.context_text ?? "", when: c.due_at, overdue: c.status === "overdue" })),
        ],
        missions: (missions.data ?? []).map((m) => ({ id: m.id, code: m.code, title: m.title, status: m.status })),
        freshness: freshness.filter((f) => f.level !== "fresh").map((f) => f.text),
      };
    }
  }
  return <MissionControl topInsight={top} goalsAtRisk={goalsAtRisk} focus={focus} />;
}
