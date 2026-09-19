/**
 * Data freshness (spec §44): per-connection last success / last attempt /
 * last error / staleness. Pure computation; the loader lives in
 * freshness-store.ts.
 */

export interface FreshnessConnection {
  id: string;
  provider: string;
  display_name: string;
  status: string;
  last_sync_at: string | null;
  last_error: string | null;
}

export interface FreshnessRun {
  connection_id: string | null;
  provider: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  error: string | null;
}

export type FreshnessLevel = "fresh" | "aging" | "stale" | "never" | "error";

export interface ProviderFreshness {
  connection_id: string;
  provider: string;
  display_name: string;
  status: string;
  last_success_at: string | null;
  last_attempt_at: string | null;
  last_error: string | null;
  age_hours: number | null;
  level: FreshnessLevel;
  /** Human sentence, e.g. "Stripe data is 3h old". */
  text: string;
}

export const FRESH_HOURS = 2;
export const STALE_HOURS = 36;

export function ageHours(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (now.getTime() - t) / 3_600_000);
}

export function describeAge(hours: number | null): string {
  if (hours == null) return "never synced";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m old`;
  if (hours < 48) return `${Math.round(hours)}h old`;
  return `${Math.round(hours / 24)}d old`;
}

export function computeFreshness(connections: FreshnessConnection[], runs: FreshnessRun[], now = new Date()): ProviderFreshness[] {
  return connections.map((c) => {
    const mine = runs.filter((r) => r.connection_id === c.id || (!r.connection_id && r.provider === c.provider));
    const attempts = mine.map((r) => r.started_at ?? r.created_at).filter(Boolean).sort();
    const failures = mine.filter((r) => r.status === "failed").sort((a, b) => (b.finished_at ?? b.created_at).localeCompare(a.finished_at ?? a.created_at));
    const lastAttempt = attempts.length ? attempts[attempts.length - 1]! : null;
    const lastSuccess = c.last_sync_at;
    const hours = ageHours(lastSuccess, now);
    const lastFailure = failures[0];
    const failedSinceSuccess = !!lastFailure && (!lastSuccess || (lastFailure.finished_at ?? lastFailure.created_at) > lastSuccess);
    let level: FreshnessLevel;
    if (!lastSuccess) level = failedSinceSuccess ? "error" : "never";
    else if (failedSinceSuccess) level = "error";
    else if (hours! <= FRESH_HOURS) level = "fresh";
    else if (hours! <= STALE_HOURS) level = "aging";
    else level = "stale";
    const label = c.display_name.split(" · ")[0] ?? c.provider;
    const text =
      level === "never"
        ? `${label} has not synced yet`
        : level === "error"
          ? `${label} sync failed${lastSuccess ? ` (last good data ${describeAge(hours)})` : ""}`
          : `${label} data is ${describeAge(hours)}${level === "stale" ? " (stale)" : ""}`;
    return {
      connection_id: c.id,
      provider: c.provider,
      display_name: c.display_name,
      status: c.status,
      last_success_at: lastSuccess,
      last_attempt_at: lastAttempt,
      last_error: failedSinceSuccess ? (lastFailure?.error ?? c.last_error) : null,
      age_hours: hours == null ? null : Math.round(hours * 10) / 10,
      level,
      text,
    };
  });
}

export function freshnessSummary(items: ProviderFreshness[]): string {
  if (!items.length) return "No connected sources.";
  const bad = items.filter((f) => f.level === "stale" || f.level === "error" || f.level === "never");
  if (!bad.length) return `All ${items.length} sources fresh (newest ${describeAge(Math.min(...items.map((f) => f.age_hours ?? 0)))}).`;
  return bad.map((f) => f.text).join("; ") + ".";
}
