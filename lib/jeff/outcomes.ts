/**
 * Outcome measurement (spec §34): pure math. A mission linked to a finding
 * or goal gets a baseline before implementation and a post value after a
 * 14-day window. We report "improved / worsened / unchanged", never causation.
 */

export const OUTCOME_WINDOW_DAYS = 14;
export const UNCHANGED_THRESHOLD_PCT = 5;

export interface OutcomeComputation {
  delta: number | null;
  delta_pct: number | null;
  direction: "improved" | "worsened" | "unchanged" | "unknown";
  limitations: string;
}

export function computeOutcome(baseline: number | null, post: number | null, higherIsBetter: boolean, confounders: string[] = []): OutcomeComputation {
  if (baseline == null || post == null) {
    return { delta: null, delta_pct: null, direction: "unknown", limitations: "Baseline or post-change value is not available yet." };
  }
  const delta = Math.round((post - baseline) * 100) / 100;
  const delta_pct = baseline === 0 ? (post === 0 ? 0 : null) : Math.round(((post - baseline) / Math.abs(baseline)) * 1000) / 10;
  let direction: OutcomeComputation["direction"];
  if (delta_pct != null && Math.abs(delta_pct) < UNCHANGED_THRESHOLD_PCT) direction = "unchanged";
  else if (delta === 0) direction = "unchanged";
  else direction = (delta > 0) === higherIsBetter ? "improved" : "worsened";
  const verb = direction === "improved" ? "improved" : direction === "worsened" ? "worsened" : "did not change materially";
  const limitations = `${verb.charAt(0).toUpperCase() + verb.slice(1)} following the change over a ${OUTCOME_WINDOW_DAYS}-day window; causal attribution is not established.${confounders.length ? ` Other changes in the window: ${confounders.join("; ")}.` : ""}`;
  return { delta, delta_pct, direction, limitations };
}

export interface WindowSpec {
  start: string;
  end: string;
  days: number;
}

export function baselineWindow(implementedAt: Date): WindowSpec {
  const end = implementedAt;
  const start = new Date(end.getTime() - OUTCOME_WINDOW_DAYS * 86_400_000);
  return { start: start.toISOString(), end: end.toISOString(), days: OUTCOME_WINDOW_DAYS };
}

export function postWindow(implementedAt: Date): WindowSpec {
  const start = implementedAt;
  const end = new Date(start.getTime() + OUTCOME_WINDOW_DAYS * 86_400_000);
  return { start: start.toISOString(), end: end.toISOString(), days: OUTCOME_WINDOW_DAYS };
}

export function postWindowElapsed(implementedAt: Date, now: Date): boolean {
  return now.getTime() >= implementedAt.getTime() + OUTCOME_WINDOW_DAYS * 86_400_000;
}

/** Count of findings of a category first seen inside a window — the generic "did the noise go down" metric. */
export function countInWindow(items: { created_at: string }[], w: WindowSpec): number {
  const s = Date.parse(w.start);
  const e = Date.parse(w.end);
  return items.filter((i) => {
    const t = Date.parse(i.created_at);
    return t >= s && t < e;
  }).length;
}

/** Latest numeric snapshot value at or before `at`. */
export function valueAt(points: { taken_at: string; value: number | null }[], at: Date): number | null {
  const t = at.getTime();
  const before = points.filter((p) => Date.parse(p.taken_at) <= t && p.value != null).sort((a, b) => Date.parse(b.taken_at) - Date.parse(a.taken_at));
  return before[0]?.value ?? null;
}
