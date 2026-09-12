import { lastViewedAt, ts, type BlindSpotCandidate, type BlindSpotContext, type Detector } from "../types";

/** An at-risk goal not opened for this long is being neglected. */
export const NEGLECT_DAYS = 14;
const AT_RISK = new Set(["at_risk", "severely_at_risk"]);
const LABEL: Record<string, string> = { at_risk: "At risk", severely_at_risk: "Severely at risk" };

export const neglectedGoal: Detector = {
  id: "neglected_goal",
  run(ctx: BlindSpotContext): BlindSpotCandidate[] {
    const out: BlindSpotCandidate[] = [];
    const cutoff = ctx.now.getTime() - NEGLECT_DAYS * 86_400_000;
    for (const g of ctx.goals) {
      if (g.status !== "active" || !g.trajectory || !AT_RISK.has(g.trajectory)) continue;
      const viewed = lastViewedAt(ctx, "goal_viewed", g.id) ?? lastViewedAt(ctx, "page_viewed", null, `/goals/${g.id}`);
      if (viewed != null && viewed >= cutoff) continue;
      const daysRemaining = g.end_date ? Math.max(0, Math.round((ts(g.end_date) - ctx.now.getTime()) / 86_400_000)) : null;
      out.push({
        fingerprint: `blindspot:neglected_goal:${g.id}`,
        subtype: "neglected_goal",
        ref: g.id,
        title: `"${g.name}" is ${LABEL[g.trajectory]?.toLowerCase() ?? g.trajectory} and you haven't opened it in ${NEGLECT_DAYS}+ days`,
        observed_facts: [`Trajectory: ${LABEL[g.trajectory] ?? g.trajectory}.`, viewed ? `Last opened ${Math.floor((ctx.now.getTime() - viewed) / 86_400_000)} days ago.` : "Not opened in the last 30 days.", ...(daysRemaining != null ? [`${daysRemaining} days remaining.`] : [])],
        metrics: { trajectory: g.trajectory, days_since_viewed: viewed ? Math.floor((ctx.now.getTime() - viewed) / 86_400_000) : null, days_remaining: daysRemaining, threshold_days: NEGLECT_DAYS, formula: `active goal AND trajectory ∈ {at_risk, severely_at_risk} AND days since goal_viewed > ${NEGLECT_DAYS}` },
        interpretation: "Goals drift when the metrics stop being looked at. The recommendations attached to this goal have been waiting.",
        attention: viewed ? `You last opened this goal ${Math.floor((ctx.now.getTime() - viewed) / 86_400_000)} days ago.` : "You have not opened this goal recently.",
        evidence: [],
        range_start: null,
        range_end: ctx.now.toISOString(),
        confidence: 0.8,
        limitations: "Goal status may have been reviewed in a briefing without opening the goal page.",
        impact: "operational",
      });
    }
    return out;
  },
};
