import { daysBetween, evidenceOf, str, type CandidateFinding, type Monitor, type SourceRow } from "./types";

/**
 * Open HighLevel opportunities whose contact has had no conversation activity
 * for more than GAP_DAYS. "Activity" = the newest HighLevel message item for
 * that contactId (lastMessageDate), falling back to the opportunity's own
 * lastActionDate / updatedAt.
 */
export const GAP_DAYS = 3;
const CLOSED = new Set(["won", "lost", "abandoned"]);

export const leadFollowupGap: Monitor = {
  id: "lead_followup_gap",
  run(rows, ctx) {
    const opps = rows.filter((r) => r.provider === "highlevel" && r.resource_type === "opportunity" && !CLOSED.has(String(r.metadata.status ?? "open").toLowerCase()));
    const lastMessageByContact = new Map<string, { at: Date; row: SourceRow }>();
    for (const m of rows) {
      if (m.provider !== "highlevel" || m.resource_type !== "message") continue;
      const cid = str(m.metadata.contactId);
      const ts = str(m.metadata.lastMessageDate) ?? m.source_timestamp;
      if (!cid || !ts) continue;
      const at = new Date(ts);
      if (Number.isNaN(at.getTime())) continue;
      const prev = lastMessageByContact.get(cid);
      if (!prev || at > prev.at) lastMessageByContact.set(cid, { at, row: m });
    }
    const out: CandidateFinding[] = [];
    for (const o of opps) {
      const cid = str(o.metadata.contactId);
      if (!cid) continue;
      const last = lastMessageByContact.get(cid);
      const fallback = str(o.metadata.lastActionDate) ?? o.source_timestamp;
      const lastActivity = last?.at ?? (fallback ? new Date(fallback) : null);
      if (!lastActivity || Number.isNaN(lastActivity.getTime())) continue;
      const gap = daysBetween(ctx.now, lastActivity);
      if (gap <= GAP_DAYS) continue;
      const stage = str(o.metadata.stage) ?? str(o.metadata.pipelineStageId) ?? "unknown stage";
      const value = typeof o.metadata.monetaryValue === "number" ? (o.metadata.monetaryValue as number) : null;
      const name = o.title ?? "opportunity";
      out.push({
        fingerprint: `lead_followup_gap:${o.external_id}`,
        category: "lead_followup_gap",
        title: `No follow-up in ${Math.floor(gap)} days: ${name}`,
        observed_facts: [
          `Opportunity "${name}" is open in stage "${stage}"${value != null ? ` with value $${value.toLocaleString()}` : ""}.`,
          last
            ? `Last conversation activity for this contact was ${last.at.toISOString().slice(0, 10)}.`
            : `No conversation activity found for this contact in synced data; last opportunity action ${lastActivity.toISOString().slice(0, 10)}.`,
        ],
        metrics: { days_since_activity: gap, threshold_days: GAP_DAYS, formula: "now - max(lastMessageDate, lastActionDate)" },
        interpretation: "Interpretation: this lead may be going cold. A short check-in is usually worth more than waiting; if the deal is dead, closing it keeps the pipeline honest.",
        evidence: [evidenceOf(o), ...(last ? [evidenceOf(last.row)] : [])],
        range_start: lastActivity.toISOString(),
        range_end: ctx.now.toISOString(),
        confidence: last ? 0.7 : 0.5,
        limitations: "Activity outside HighLevel (calls, in-person) is not visible. Conversation sync covers the most recent 300 conversations only.",
        severity: gap > 10 ? "high" : gap > 6 ? "medium" : "low",
        proposed_mission: {
          title: `Prepare follow-up for ${name}`,
          goal: `Draft a follow-up message and next step for the open opportunity "${name}" (stage ${stage}). Do not send anything — prepare for owner review.`,
        },
      });
    }
    return out;
  },
};
