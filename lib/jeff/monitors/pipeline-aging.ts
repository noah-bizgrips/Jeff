import { daysBetween, evidenceOf, str, type CandidateFinding, type Monitor, type SourceRow } from "./types";

/** Open opportunities that have sat in the same stage for more than AGING_DAYS, grouped by stage. */
export const AGING_DAYS = 14;
const CLOSED = new Set(["won", "lost", "abandoned"]);

export const pipelineAging: Monitor = {
  id: "pipeline_aging",
  run(rows, ctx) {
    const groups = new Map<string, { stage: string; items: { row: SourceRow; age: number }[] }>();
    for (const r of rows) {
      if (r.provider !== "highlevel" || r.resource_type !== "opportunity") continue;
      if (CLOSED.has(String(r.metadata.status ?? "open").toLowerCase())) continue;
      const changed = str(r.metadata.lastStageChangeAt) ?? str(r.metadata.createdAt) ?? r.source_timestamp;
      if (!changed) continue;
      const changedAt = new Date(changed);
      if (Number.isNaN(changedAt.getTime())) continue;
      const age = daysBetween(ctx.now, changedAt);
      if (age <= AGING_DAYS) continue;
      const key = str(r.metadata.pipelineStageId) ?? "unknown";
      const stage = str(r.metadata.stage) ?? key;
      const g = groups.get(key) ?? { stage, items: [] };
      g.items.push({ row: r, age });
      groups.set(key, g);
    }
    const out: CandidateFinding[] = [];
    for (const [key, g] of groups) {
      const total = g.items.reduce((acc, it) => acc + (typeof it.row.metadata.monetaryValue === "number" ? (it.row.metadata.monetaryValue as number) : 0), 0);
      const oldest = Math.max(...g.items.map((i) => i.age));
      out.push({
        fingerprint: `pipeline_aging:${key}`,
        category: "pipeline_aging",
        title: `${g.items.length} opportunit${g.items.length === 1 ? "y" : "ies"} stuck in "${g.stage}" over ${AGING_DAYS} days`,
        observed_facts: g.items.slice(0, 10).map((i) => `"${i.row.title}" has been in "${g.stage}" for ${Math.floor(i.age)} days.`),
        metrics: { count: g.items.length, oldest_days: Math.floor(oldest), total_value: total, threshold_days: AGING_DAYS, formula: "now - lastStageChangeAt > threshold" },
        interpretation: "Interpretation: deals aging in one stage usually mean a missing next step or an unqualified lead. Review each and either advance, schedule, or close.",
        evidence: g.items.slice(0, 10).map((i) => evidenceOf(i.row)),
        range_start: new Date(ctx.now.getTime() - oldest * 86_400_000).toISOString(),
        range_end: ctx.now.toISOString(),
        confidence: 0.8,
        limitations: "Stage timestamps come from HighLevel; manual notes or offline progress are not reflected.",
        severity: total > 10_000 || oldest > 30 ? "high" : "medium",
        proposed_mission: {
          title: `Review aging deals in ${g.stage}`,
          goal: `Prepare a review list of the ${g.items.length} opportunities stuck in "${g.stage}" with a recommended next action for each. No messages are sent.`,
        },
      });
    }
    return out;
  },
};
