import { evidenceOf, type CandidateFinding, type Monitor } from "./types";
import { DAY, clientIndex, clientLabel, groupBy, isActiveClient, str } from "./portal-shared";

/** Portal leads still `new` after NEW_HOURS, grouped per client. */
export const NEW_HOURS = 24;

export const leadNotContacted: Monitor = {
  id: "lead_not_contacted",
  run(rows, ctx) {
    const now = ctx.now.getTime();
    const idx = clientIndex(rows);
    const stale = rows.filter((r) => {
      if (r.provider !== "portal" || r.resource_type !== "lead") return false;
      if (str(r.metadata.outcome) !== "new") return false;
      const t = r.source_timestamp ? Date.parse(r.source_timestamp) : NaN;
      return Number.isFinite(t) && now - t > NEW_HOURS * 3_600_000 && isActiveClient(idx, str(r.metadata.client_id));
    });
    const out: CandidateFinding[] = [];
    for (const [clientId, leads] of groupBy(stale, (r) => str(r.metadata.client_id))) {
      const name = clientLabel(idx, clientId);
      const oldestDays = Math.max(...leads.map((l) => (now - Date.parse(l.source_timestamp!)) / DAY));
      out.push({
        fingerprint: `lead_not_contacted:${clientId}`,
        category: "lead_not_contacted",
        title: `${name}: ${leads.length} lead${leads.length === 1 ? "" : "s"} not contacted after ${NEW_HOURS}h`,
        observed_facts: leads.slice(0, 8).map((l) => {
          const hours = Math.round((now - Date.parse(l.source_timestamp!)) / 3_600_000);
          return `${l.title} arrived ${l.source_timestamp!.slice(0, 16).replace("T", " ")}${str(l.metadata.source) ? ` via ${str(l.metadata.source)}` : ""} and is still "new" after ${hours} hours.`;
        }),
        metrics: { leads_new_over_threshold: leads.length, threshold_hours: NEW_HOURS, oldest_days: Math.round(oldestDays * 10) / 10, formula: "outcome = new AND now - submitted_at > threshold" },
        interpretation: `Interpretation: speed-to-lead drives close rate for ${name}; a lead untouched for a day is usually already talking to a competitor. Either the client is not working the leads or the outcome is not being updated in the pipeline.`,
        evidence: leads.slice(0, 15).map(evidenceOf),
        range_start: null,
        range_end: ctx.now.toISOString(),
        confidence: 0.75,
        limitations: "Outcome comes from the portal/GHL pipeline; a lead contacted by phone without a status change looks uncontacted.",
        severity: leads.length >= 5 ? "high" : leads.length >= 2 ? "medium" : "low",
        proposed_mission: { title: `Lead follow-up check for ${name}`, goal: `List the ${leads.length} uncontacted lead(s) for ${name} with age and source, verify against GoHighLevel conversation activity, and prepare a follow-up plan. Do not contact leads.` },
      });
    }
    return out;
  },
};
