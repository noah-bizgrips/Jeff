import { lastViewedAt, ts, type BlindSpotCandidate, type BlindSpotContext, type Detector } from "../types";

/** A connection without a successful sync for this long is stale. */
export const STALE_HOURS = 48;

export const staleConnection: Detector = {
  id: "stale_connection",
  run(ctx: BlindSpotContext): BlindSpotCandidate[] {
    const out: BlindSpotCandidate[] = [];
    const connectionsViewed = lastViewedAt(ctx, "page_viewed", null, "/connections");
    for (const c of ctx.connections) {
      const broken = c.status === "reconnect_required" || c.status === "error";
      const stale = c.age_hours != null && c.age_hours > STALE_HOURS;
      if (!broken && !stale) continue;
      // If the owner visited Connections after the problem started, they know.
      const problemSince = c.last_success_at ? ts(c.last_success_at) : null;
      if (connectionsViewed != null && (problemSince == null || connectionsViewed > problemSince)) continue;
      out.push({
        fingerprint: `blindspot:stale_connection:${c.id}`,
        subtype: "stale_connection",
        ref: c.provider,
        title: broken ? `${c.display_name} needs attention (${c.status.replace(/_/g, " ")})` : `${c.display_name} hasn't synced in ${Math.round(c.age_hours ?? 0)} hours`,
        observed_facts: [
          `Connection status: ${c.status}.`,
          c.last_success_at ? `Last successful sync: ${c.last_success_at}.` : "No successful sync recorded.",
          ...(c.last_error ? [`Last error: ${c.last_error}`] : []),
        ],
        metrics: { age_hours: c.age_hours, stale_threshold_hours: STALE_HOURS, status: c.status, formula: `hours since last successful sync > ${STALE_HOURS} OR status in (error, reconnect_required)` },
        interpretation: "Everything downstream of this source — findings, goals, briefings — is silently running on old data.",
        attention: connectionsViewed == null ? "You have not opened Connections in the last 30 days." : "You have not opened Connections since this connection stopped syncing.",
        evidence: [],
        range_start: c.last_success_at,
        range_end: ctx.now.toISOString(),
        confidence: 0.9,
        limitations: "Some providers are synced less often by design; the threshold is generic.",
        impact: "data",
      });
    }
    return out;
  },
};
