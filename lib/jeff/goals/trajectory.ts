import type { GoalDriver, GoalMetric, MetricResult, Trajectory } from "./schema";
import { meetsTarget } from "./metrics";

/**
 * Trajectory math. Pure and deliberately simple: linear pace with a coarse
 * confidence band. Labels, not fake precision.
 */

export interface SnapshotPoint {
  taken_at: string;
  value: number | null;
}

export interface TrajectoryInput {
  now: Date;
  start: string; // ISO date
  end: string; // ISO date
  primary: GoalMetric;
  /** All metric definitions (constraints are evaluated from these). */
  definitions: GoalMetric[];
  metrics: Record<string, MetricResult>;
  /** Historical primary-metric values, oldest → newest (excluding the current one). */
  history: SnapshotPoint[];
  drivers?: { driver: GoalDriver; value: number | null }[];
}

export interface Forecast {
  value: number | null;
  low: number | null;
  high: number | null;
  at: string;
  basis: string;
}

export interface ConstraintViolation {
  key: string;
  name: string;
  strength: "soft" | "hard";
  value: number | null;
  target: number | null;
  comparator: GoalMetric["comparator"];
  /** How far past the threshold, as a fraction of the threshold (0.3 = 30% worse). */
  overshoot: number;
}

export interface TrajectoryResult {
  elapsed_days: number;
  remaining_days: number;
  total_days: number;
  elapsed_pct: number;
  completion_pct: number | null;
  observed_pace: number | null; // units per day
  required_pace: number | null; // units per day
  forecast: Forecast;
  trajectory: Trajectory;
  reasons: string[];
  violations: ConstraintViolation[];
  constraint_key: string | null;
  constraint_reason: string | null;
}

const DAY = 86_400_000;

function round(v: number, places = 1): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

export function constraintViolations(metrics: GoalMetric[], results: Record<string, MetricResult>): ConstraintViolation[] {
  const out: ConstraintViolation[] = [];
  for (const m of metrics) {
    if (!m.is_constraint || m.target == null) continue;
    const r = results[m.key];
    if (!r || r.value == null) continue;
    if (meetsTarget(r.value, m) !== false) continue;
    const denom = Math.abs(m.target) || 1;
    const overshoot = m.comparator === "lte" ? (r.value - m.target) / denom : m.comparator === "gte" ? (m.target - r.value) / denom : Math.abs(r.value - m.target) / denom;
    out.push({ key: m.key, name: m.name, strength: m.constraint_strength, value: r.value, target: m.target, comparator: m.comparator, overshoot: round(overshoot, 3) });
  }
  return out;
}

export function computeTrajectory(input: TrajectoryInput): TrajectoryResult {
  const startMs = Date.parse(input.start);
  const endMs = Date.parse(input.end);
  const nowMs = input.now.getTime();
  const totalDays = Math.max(1, (endMs - startMs) / DAY);
  const elapsedDays = Math.min(totalDays, Math.max(0, (nowMs - startMs) / DAY));
  const remainingDays = Math.max(0, totalDays - elapsedDays);
  const elapsedPct = round((elapsedDays / totalDays) * 100, 0);

  const primary = input.metrics[input.primary.key];
  const value = primary?.value ?? null;
  const target = input.primary.target;
  const reasons: string[] = [];
  const violations = constraintViolations(input.definitions, input.metrics);

  // Constraint / driver identification
  let constraintKey: string | null = null;
  let constraintReason: string | null = null;
  if (input.drivers?.length) {
    let worst: { key: string; name: string; shortfall: number; value: number; target: number } | null = null;
    for (const d of input.drivers) {
      if (d.driver.implied_target == null || d.value == null || d.driver.implied_target <= 0) continue;
      const expectedByNow = d.driver.implied_target * (elapsedDays / totalDays);
      if (expectedByNow <= 0) continue;
      const shortfall = (expectedByNow - d.value) / expectedByNow;
      if (!worst || shortfall > worst.shortfall) worst = { key: d.driver.key, name: d.driver.name, shortfall, value: d.value, target: Math.round(expectedByNow) };
    }
    if (worst && worst.shortfall > 0.15) {
      constraintKey = worst.key;
      constraintReason = `${worst.name}: ${worst.value} so far vs ~${worst.target} expected by now (${Math.round(worst.shortfall * 100)}% behind).`;
    }
  }
  if (!constraintKey && violations.length) {
    const v = [...violations].sort((a, b) => b.overshoot - a.overshoot)[0]!;
    constraintKey = v.key;
    constraintReason = `${v.name} is ${Math.round(v.overshoot * 100)}% past its limit.`;
  }

  // Unknown when the primary value or target is missing.
  if (value == null || target == null) {
    reasons.push(value == null ? "Primary metric has no data yet." : "Primary metric has no target.");
    return {
      elapsed_days: round(elapsedDays),
      remaining_days: round(remainingDays),
      total_days: round(totalDays),
      elapsed_pct: elapsedPct,
      completion_pct: null,
      observed_pace: null,
      required_pace: null,
      forecast: { value: null, low: null, high: null, at: input.end, basis: "insufficient data" },
      trajectory: "unknown",
      reasons,
      violations,
      constraint_key: constraintKey,
      constraint_reason: constraintReason,
    };
  }

  const isLower = input.primary.comparator === "lte";
  const completionPct = isLower ? (value <= target ? 100 : round((target / Math.max(value, 1e-9)) * 100, 0)) : target === 0 ? 100 : round(Math.min(150, (value / target) * 100), 0);

  // Pace: prefer history deltas, else average since start.
  const points = [...input.history.filter((h) => h.value != null), { taken_at: input.now.toISOString(), value }];
  const paces: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const dt = (Date.parse(points[i]!.taken_at) - Date.parse(points[i - 1]!.taken_at)) / DAY;
    if (dt >= 0.5) paces.push((points[i]!.value! - points[i - 1]!.value!) / dt);
  }
  const observedPace = elapsedDays >= 1 ? (paces.length >= 2 ? paces.reduce((a, b) => a + b, 0) / paces.length : value / elapsedDays) : null;
  const requiredPace = remainingDays > 0 ? (isLower ? null : Math.max(0, target - value) / remainingDays) : null;

  // Forecast (linear) with a coarse band.
  let forecast: Forecast;
  if (isLower) {
    forecast = { value, low: value, high: value, at: input.end, basis: "current value (lower-is-better metric)" };
  } else if (observedPace == null) {
    forecast = { value: null, low: null, high: null, at: input.end, basis: "too early to project (under one day elapsed)" };
  } else {
    const f = value + observedPace * remainingDays;
    const spread = paces.length >= 3 ? stddev(paces) * remainingDays : Math.abs(observedPace * remainingDays) * 0.2;
    forecast = { value: round(f, 1), low: round(Math.max(0, f - spread), 1), high: round(f + spread, 1), at: input.end, basis: paces.length >= 3 ? `linear projection from ${paces.length} snapshots` : "linear projection from average pace since start" };
  }

  // Label.
  let trajectory: Trajectory;
  const hardBad = violations.some((v) => v.strength === "hard" && v.overshoot > 0.3);
  const softFailing = violations.filter((v) => v.strength === "soft").length;
  if (isLower) {
    const ok = value <= target;
    const over = (value - target) / (Math.abs(target) || 1);
    trajectory = ok ? "on_track" : over <= 0.1 ? "slightly_at_risk" : over <= 0.3 ? "at_risk" : "severely_at_risk";
    reasons.push(ok ? `Current ${round(value)} is within the target ${round(target)}.` : `Current ${round(value)} exceeds the target ${round(target)} by ${Math.round(over * 100)}%.`);
  } else if (value >= target) {
    trajectory = "on_track";
    reasons.push("Target already reached.");
  } else if (forecast.value == null) {
    trajectory = "unknown";
    reasons.push("Not enough elapsed time to project.");
  } else {
    const gap = (target - forecast.value) / (Math.abs(target) || 1);
    if (gap <= 0) {
      trajectory = "on_track";
      reasons.push(`Projected ${forecast.value} by ${input.end} meets the target ${target}.`);
    } else if (gap <= 0.1) {
      trajectory = "slightly_at_risk";
      reasons.push(`Projected ${forecast.value} is within 10% of the target ${target}.`);
    } else if (gap <= 0.3) {
      trajectory = "at_risk";
      reasons.push(`Projected ${forecast.value} is ${Math.round(gap * 100)}% short of the target ${target}.`);
    } else {
      trajectory = "severely_at_risk";
      reasons.push(`Projected ${forecast.value} is ${Math.round(gap * 100)}% short of the target ${target}.`);
    }
  }
  if (hardBad) {
    trajectory = "severely_at_risk";
    reasons.push("A hard constraint is badly violated.");
  } else if (softFailing && trajectory === "on_track") {
    trajectory = "slightly_at_risk";
    reasons.push(`${softFailing} constraint${softFailing === 1 ? "" : "s"} currently failing.`);
  } else if (softFailing >= 2 && trajectory === "slightly_at_risk") {
    trajectory = "at_risk";
    reasons.push("Multiple constraints failing.");
  }
  if (requiredPace != null && observedPace != null && requiredPace > observedPace * 1.5 && trajectory === "on_track") {
    trajectory = "slightly_at_risk";
    reasons.push(`Required pace ${round(requiredPace, 2)}/day is well above observed ${round(observedPace, 2)}/day.`);
  }

  return {
    elapsed_days: round(elapsedDays),
    remaining_days: round(remainingDays),
    total_days: round(totalDays),
    elapsed_pct: elapsedPct,
    completion_pct: completionPct,
    observed_pace: observedPace == null ? null : round(observedPace, 3),
    required_pace: requiredPace == null ? null : round(requiredPace, 3),
    forecast,
    trajectory,
    reasons,
    violations,
    constraint_key: constraintKey,
    constraint_reason: constraintReason,
  };
}
