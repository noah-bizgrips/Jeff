import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorMessage, log } from "@/lib/security/log";
import { listGoalMetrics, listSnapshots } from "@/lib/gomez/goals/store";
import { baselineWindow, computeOutcome, countInWindow, postWindow, postWindowElapsed, valueAt } from "./outcomes";

export interface OutcomeRow {
  id: string;
  mission_id: string;
  finding_id: string | null;
  goal_id: string | null;
  metric_key: string;
  metric_label: string | null;
  higher_is_better: boolean;
  baseline_value: number | null;
  baseline_window: Record<string, unknown>;
  implemented_at: string;
  post_value: number | null;
  post_window: Record<string, unknown>;
  delta: number | null;
  delta_pct: number | null;
  direction: "improved" | "worsened" | "unchanged" | "unknown";
  limitations: string | null;
  confounders: string[];
  measured_at: string | null;
}

const COLUMNS = "id, mission_id, finding_id, goal_id, metric_key, metric_label, higher_is_better, baseline_value, baseline_window, implemented_at, post_value, post_window, delta, delta_pct, direction, limitations, confounders, measured_at";

interface MissionLite {
  id: string;
  title: string;
  finding_id: string | null;
  goal_id: string | null;
  completed_at: string | null;
}

/**
 * Called when a mission is marked completed: records the baseline for the
 * metric implied by its finding (category count) or goal (primary metric).
 * Idempotent per (mission, metric).
 */
export async function recordBaseline(ownerId: string, mission: MissionLite, now = new Date()): Promise<OutcomeRow | null> {
  const admin = createAdminClient();
  const implementedAt = mission.completed_at ? new Date(mission.completed_at) : now;
  const bw = baselineWindow(implementedAt);
  let metric: { key: string; label: string; higherIsBetter: boolean; baseline: number | null } | null = null;
  if (mission.goal_id) {
    const metrics = await listGoalMetrics(mission.goal_id).catch(() => []);
    const primary = metrics.find((m) => m.is_primary) ?? metrics[0];
    if (primary) {
      const snaps = await listSnapshots(mission.goal_id, 200).catch(() => []);
      const points = snaps.map((s) => ({ taken_at: s.taken_at, value: (s.metrics?.[primary.key]?.value as number | null | undefined) ?? null }));
      metric = { key: `goal:${primary.key}`, label: primary.name, higherIsBetter: primary.comparator !== "lte", baseline: valueAt(points, implementedAt) };
    }
  }
  if (!metric && mission.finding_id) {
    const { data: finding } = await admin.from("findings").select("category").eq("id", mission.finding_id).maybeSingle();
    if (finding?.category) {
      const { data: rows } = await admin.from("findings").select("created_at").eq("owner_id", ownerId).eq("category", finding.category).eq("is_sample", false).gte("created_at", bw.start).lt("created_at", bw.end);
      metric = { key: `findings:${finding.category}`, label: `${String(finding.category).replace(/_/g, " ")} findings`, higherIsBetter: false, baseline: countInWindow(rows ?? [], bw) };
    }
  }
  if (!metric) return null;
  const { data, error } = await admin
    .from("mission_outcomes")
    .upsert(
      {
        owner_id: ownerId,
        mission_id: mission.id,
        finding_id: mission.finding_id,
        goal_id: mission.goal_id,
        metric_key: metric.key,
        metric_label: metric.label,
        higher_is_better: metric.higherIsBetter,
        baseline_value: metric.baseline,
        baseline_window: bw,
        implemented_at: implementedAt.toISOString(),
        post_window: postWindow(implementedAt),
        direction: "unknown",
        limitations: "Post-change window has not elapsed yet.",
      },
      { onConflict: "mission_id,metric_key" },
    )
    .select(COLUMNS)
    .single();
  if (error) {
    log.warn("outcome_baseline_failed", { missionId: mission.id, message: error.message });
    return null;
  }
  return data as unknown as OutcomeRow;
}

/** Cron: measures every outcome whose post window has elapsed and is not measured yet. */
export async function measureOutcomes(ownerId: string, now = new Date()): Promise<{ measured: number; pending: number }> {
  const admin = createAdminClient();
  const { data: rows } = await admin.from("mission_outcomes").select(COLUMNS).eq("owner_id", ownerId).is("measured_at", null).limit(50);
  let measured = 0;
  let pending = 0;
  for (const o of (rows ?? []) as unknown as OutcomeRow[]) {
    const implementedAt = new Date(o.implemented_at);
    if (!postWindowElapsed(implementedAt, now)) {
      pending++;
      continue;
    }
    try {
      const pw = postWindow(implementedAt);
      let post: number | null = null;
      if (o.metric_key.startsWith("goal:") && o.goal_id) {
        const key = o.metric_key.slice(5);
        const snaps = await listSnapshots(o.goal_id, 200).catch(() => []);
        post = valueAt(snaps.map((s) => ({ taken_at: s.taken_at, value: (s.metrics?.[key]?.value as number | null | undefined) ?? null })), new Date(pw.end));
      } else if (o.metric_key.startsWith("findings:")) {
        const category = o.metric_key.slice(9);
        const { data: f } = await admin.from("findings").select("created_at").eq("owner_id", ownerId).eq("category", category).eq("is_sample", false).gte("created_at", pw.start).lt("created_at", pw.end);
        post = countInWindow(f ?? [], pw);
      }
      // Confounders: other missions completed inside the post window.
      const { data: others } = await admin.from("missions").select("title").eq("owner_id", ownerId).eq("status", "completed").neq("id", o.mission_id).gte("completed_at", pw.start).lt("completed_at", pw.end);
      const confounders = (others ?? []).map((m) => m.title).slice(0, 5);
      const result = computeOutcome(o.baseline_value == null ? null : Number(o.baseline_value), post, o.higher_is_better, confounders);
      const { error } = await admin.from("mission_outcomes").update({ post_value: post, delta: result.delta, delta_pct: result.delta_pct, direction: result.direction, limitations: result.limitations, confounders, measured_at: now.toISOString() }).eq("id", o.id);
      if (!error) measured++;
    } catch (err) {
      log.warn("outcome_measure_failed", { id: o.id, message: errorMessage(err) });
    }
  }
  return { measured, pending };
}

export async function listOutcomesForMissions(ownerId: string, missionIds: string[]): Promise<OutcomeRow[]> {
  if (!missionIds.length) return [];
  const admin = createAdminClient();
  const { data } = await admin.from("mission_outcomes").select(COLUMNS).eq("owner_id", ownerId).in("mission_id", missionIds);
  return (data ?? []) as unknown as OutcomeRow[];
}
