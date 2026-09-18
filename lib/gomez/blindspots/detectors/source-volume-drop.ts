import { daysAgo, median, ts, type BlindSpotCandidate, type BlindSpotContext, type Detector } from "../types";

/** 7-day volume below this fraction of the prior 4-week weekly median is a drop. */
export const DROP_RATIO = 0.4;
/** Baseline weekly median must be at least this many items for the drop to be meaningful. */
export const MIN_BASELINE = 10;
export const BASELINE_WEEKS = 4;

const PROVIDER_LABEL: Record<string, string> = { google: "Google (Gmail/Calendar/Drive)", highlevel: "HighLevel", stripe: "Stripe", plaid: "Financial accounts", slack: "Slack", notion: "Notion", meta: "Meta", portal: "Client portal" };

export const sourceVolumeDrop: Detector = {
  id: "source_volume_drop",
  run(ctx: BlindSpotContext): BlindSpotCandidate[] {
    const out: BlindSpotCandidate[] = [];
    const providers = new Set(ctx.sourceItems.map((r) => r.provider));
    for (const provider of providers) {
      const rows = ctx.sourceItems.filter((r) => r.provider === provider && Number.isFinite(ts(r.source_timestamp)));
      const weekStart = daysAgo(ctx, 7);
      const recent = rows.filter((r) => ts(r.source_timestamp) >= weekStart).length;
      const weekly: number[] = [];
      for (let w = 1; w <= BASELINE_WEEKS; w++) {
        const end = weekStart - (w - 1) * 7 * 86_400_000;
        const start = end - 7 * 86_400_000;
        weekly.push(rows.filter((r) => ts(r.source_timestamp) >= start && ts(r.source_timestamp) < end).length);
      }
      const baseline = median(weekly);
      if (baseline < MIN_BASELINE) continue;
      if (recent >= baseline * DROP_RATIO) continue;
      const conn = ctx.connections.find((c) => c.provider === provider);
      const syncProblem = conn ? conn.status === "error" || conn.status === "reconnect_required" || !!conn.last_error || (conn.age_hours != null && conn.age_hours > 48) : false;
      const label = PROVIDER_LABEL[provider] ?? provider;
      out.push({
        fingerprint: `blindspot:source_volume_drop:${provider}`,
        subtype: "source_volume_drop",
        ref: provider,
        title: syncProblem ? `${label} stopped syncing — the drop is a data problem` : `${label} volume dropped ${Math.round((1 - recent / baseline) * 100)}% this week`,
        observed_facts: [
          `${recent} ${label} records in the last 7 days.`,
          `Weekly median over the previous ${BASELINE_WEEKS} weeks: ${baseline} (weeks: ${weekly.join(", ")}).`,
          ...(syncProblem ? [`Connection status: ${conn?.status ?? "unknown"}${conn?.last_error ? ` (${conn.last_error})` : ""}; last successful sync ${conn?.age_hours != null ? `${Math.round(conn.age_hours)}h ago` : "unknown"}.`] : []),
        ],
        metrics: { recent_7d: recent, baseline_weekly_median: baseline, ratio: Math.round((recent / baseline) * 100) / 100, threshold_ratio: DROP_RATIO, formula: `count(7d) / median(weekly counts, ${BASELINE_WEEKS}w) < ${DROP_RATIO}` },
        interpretation: syncProblem
          ? "The source is not delivering data, so Gomez's picture of this area is stale — findings and briefings built on it are unreliable until the connection is fixed."
          : "A sharp drop in a source's volume usually means something upstream changed: a form stopped posting, an automation broke, a campaign paused, or the inbox filter moved. It is rarely reported as an error anywhere.",
        attention: syncProblem ? "No one is alerted when a connection quietly stops producing data." : "Volume changes don't trigger a normal finding; they only show as an absence.",
        evidence: [],
        range_start: new Date(weekStart - BASELINE_WEEKS * 7 * 86_400_000).toISOString(),
        range_end: ctx.now.toISOString(),
        confidence: syncProblem ? 0.85 : 0.65,
        limitations: "Counts include every record type for the provider; a legitimate seasonal lull looks the same as a broken feed.",
        impact: syncProblem ? "data" : "operational",
      });
    }
    return out;
  },
};
