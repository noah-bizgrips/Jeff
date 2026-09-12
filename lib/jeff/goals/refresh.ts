import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { errorMessage, log } from "@/lib/security/log";
import { computeAllMetrics, computeInput, type ConnectionFreshness, type MetricRow } from "./metrics";
import { computeTrajectory, type TrajectoryResult } from "./trajectory";
import { recommendForGoal } from "./recommend";
import { getGoal, latestSnapshot, listGoalMetrics, listGoals, listSnapshots, logGoalEvent, rowToMetric, updateMetricValues, upsertRecommendations, writeSnapshot, type GoalRow } from "./store";
import type { GoalInterpretation, MetricResult } from "./schema";

/**
 * Goal refresh: deterministic metric computation + trajectory + snapshot +
 * rule-based recommendations. No AI calls. Runs after each cron sync and on
 * demand from the UI.
 */

export interface GoalRefreshResult {
  goalId: string;
  name: string;
  trajectory: TrajectoryResult["trajectory"];
  changed: boolean;
  metrics: Record<string, MetricResult>;
  recommendationsCreated: number;
  error?: string;
}

async function loadRows(ownerId: string, since: string): Promise<MetricRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("source_items")
    .select("id, provider, capability, resource_type, external_id, title, source_timestamp, synced_at, tags, metadata")
    .eq("owner_id", ownerId)
    .eq("is_sample", false)
    .or(`source_timestamp.gte.${since},source_timestamp.is.null`)
    .limit(5000);
  if (error) throw new Error(`goal_rows_failed:${error.code ?? ""}`);
  return (data ?? []) as unknown as MetricRow[];
}

async function loadConnections(ownerId: string): Promise<ConnectionFreshness[]> {
  const admin = createAdminClient();
  const { data } = await admin.from("connections").select("provider, status, last_sync_at").eq("owner_id", ownerId);
  return (data ?? []) as ConnectionFreshness[];
}

export function goalWindowOf(goal: GoalRow, now: Date): { start: string; end: string } {
  const start = goal.start_date ? new Date(goal.start_date).toISOString() : (goal.approved_at ?? goal.created_at);
  const days = goal.interpretation.timeframe.days;
  const end = goal.end_date ? new Date(new Date(goal.end_date).getTime() + 86_399_000).toISOString() : days ? new Date(Date.parse(start) + days * 86_400_000).toISOString() : new Date(now.getTime() + 365 * 86_400_000).toISOString();
  return { start, end };
}

export async function refreshGoal(ownerId: string, goal: GoalRow, now = new Date(), preloaded?: { rows: MetricRow[]; connections: ConnectionFreshness[] }): Promise<GoalRefreshResult> {
  const metricRows = await listGoalMetrics(goal.id);
  const interpretation: GoalInterpretation = goal.interpretation;
  const definitions = metricRows.map((r) => rowToMetric(r, interpretation));
  const primary = definitions.find((m) => m.is_primary) ?? definitions[0];
  if (!primary) return { goalId: goal.id, name: goal.name, trajectory: "unknown", changed: false, metrics: {}, recommendationsCreated: 0, error: "no_metrics" };

  const window = goalWindowOf(goal, now);
  const since = new Date(Date.parse(window.start) - 120 * 86_400_000).toISOString();
  const rows = preloaded?.rows ?? (await loadRows(ownerId, since));
  const connections = preloaded?.connections ?? (await loadConnections(ownerId));

  const metrics = computeAllMetrics(definitions, rows, connections, window, now);
  const history = (await listSnapshots(goal.id, 60)).map((s) => ({ taken_at: s.taken_at, value: s.metrics?.[primary.key]?.value ?? null }));
  const drivers = interpretation.drivers.map((d) => ({ driver: d, value: computeInput(d.input, rows, window).value }));
  const trajectory = computeTrajectory({ now, start: window.start, end: window.end, primary, definitions, metrics, history, drivers });

  const previous = await latestSnapshot(goal.id);
  const changed = !previous || previous.trajectory !== trajectory.trajectory;
  await updateMetricValues(goal.id, metrics, now);
  await writeSnapshot(
    ownerId,
    goal.id,
    {
      metrics,
      elapsed_pct: trajectory.elapsed_pct,
      completion_pct: trajectory.completion_pct,
      observed_pace: trajectory.observed_pace,
      required_pace: trajectory.required_pace,
      forecast: trajectory.forecast,
      trajectory: trajectory.trajectory,
      constraint_key: trajectory.constraint_key,
      data_freshness: Object.fromEntries(Object.entries(metrics).map(([k, m]) => [k, { freshness: m.freshness, last_updated: m.last_updated }])),
    },
    now,
  );
  await logGoalEvent(ownerId, goal.id, "metric_updated", { values: Object.fromEntries(Object.entries(metrics).map(([k, m]) => [k, m.value])) });
  if (changed) {
    await logGoalEvent(ownerId, goal.id, "trajectory_changed", { from: previous?.trajectory ?? null, to: trajectory.trajectory, reasons: trajectory.reasons, constraint: trajectory.constraint_reason });
  }

  const recs = recommendForGoal({
    goalId: goal.id,
    goalName: goal.name,
    primary,
    definitions,
    metrics,
    trajectory,
    drivers: drivers.map((d) => ({ key: d.driver.key, name: d.driver.name, value: d.value, implied_target: d.driver.implied_target })),
  });
  const recommendationsCreated = await upsertRecommendations(
    ownerId,
    goal.id,
    recs.map((r) => ({ fingerprint: r.fingerprint, title: r.title, why: r.why, evidence: r.evidence, mechanism: r.mechanism, downside: r.downside, jeff_can_prepare: r.jeff_can_prepare, requires_approval: r.requires_approval })),
  );

  // Auto-mark achieved when the window has ended.
  if (trajectory.remaining_days <= 0 && goal.status === "active") {
    const admin = createAdminClient();
    const met = metrics[primary.key]?.meets_target;
    if (met != null) {
      await admin.from("goals").update({ status: met ? "achieved" : "missed" }).eq("id", goal.id);
      await logGoalEvent(ownerId, goal.id, "edited", { status: met ? "achieved" : "missed", auto: true });
    }
  }

  return { goalId: goal.id, name: goal.name, trajectory: trajectory.trajectory, changed, metrics, recommendationsCreated };
}

export async function refreshGoals(ownerId: string, now = new Date()): Promise<GoalRefreshResult[]> {
  const goals = await listGoals(ownerId, ["active"]);
  if (!goals.length) return [];
  const earliest = goals.reduce((acc, g) => {
    const s = goalWindowOf(g, now).start;
    return s < acc ? s : acc;
  }, now.toISOString());
  const rows = await loadRows(ownerId, new Date(Date.parse(earliest) - 120 * 86_400_000).toISOString());
  const connections = await loadConnections(ownerId);
  const out: GoalRefreshResult[] = [];
  for (const g of goals) {
    try {
      out.push(await refreshGoal(ownerId, g, now, { rows, connections }));
    } catch (err) {
      log.warn("goal_refresh_failed", { goalId: g.id, message: errorMessage(err) });
      out.push({ goalId: g.id, name: g.name, trajectory: "unknown", changed: false, metrics: {}, recommendationsCreated: 0, error: errorMessage(err) });
    }
  }
  const changed = out.filter((o) => o.changed);
  if (changed.length) await audit({ event: "goal_updated", ownerId, actor: "system", metadata: { changed: changed.map((c) => ({ id: c.goalId, trajectory: c.trajectory })) } });
  return out;
}

export async function refreshGoalById(ownerId: string, id: string, now = new Date()): Promise<GoalRefreshResult | null> {
  const goal = await getGoal(ownerId, id);
  if (!goal) return null;
  return refreshGoal(ownerId, goal, now);
}
