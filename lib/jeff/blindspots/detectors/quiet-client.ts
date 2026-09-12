import { clientIdOf, daysAgo, evidenceOf, ts, type BlindSpotCandidate, type BlindSpotContext, type Detector } from "../types";

/** A client with no activity for this long, after being active before, has gone quiet. */
export const QUIET_DAYS = 21;
export const PRIOR_WINDOW_DAYS = 30;
/** Minimum activity in the prior window for "quiet" to be a change rather than the norm. */
export const MIN_PRIOR_ACTIVITY = 3;

const ACTIVE_CLIENT = new Set(["delivery", "active_setup"]);
const ACTIVITY_TYPES = new Set(["lead", "appointment", "message", "invoice", "charge", "portal_event", "task", "opportunity", "contact"]);

function isClientActivity(rowType: string): boolean {
  return ACTIVITY_TYPES.has(rowType);
}

export const quietClient: Detector = {
  id: "quiet_client",
  run(ctx: BlindSpotContext): BlindSpotCandidate[] {
    const quietSince = daysAgo(ctx, QUIET_DAYS);
    const priorStart = quietSince - PRIOR_WINDOW_DAYS * 86_400_000;
    const out: BlindSpotCandidate[] = [];
    for (const c of ctx.clients) {
      if (!c.status || !ACTIVE_CLIENT.has(c.status)) continue;
      const stripeIds = new Set(c.stripe_customer_ids);
      const hlIds = new Set(c.highlevel_contact_ids);
      const mine = ctx.sourceItems.filter((r) => {
        if (!isClientActivity(r.resource_type)) return false;
        if (clientIdOf(r) === c.portal_client_id) return true;
        const cust = typeof r.metadata?.customerId === "string" ? r.metadata.customerId : null;
        if (cust && stripeIds.has(cust)) return true;
        const contact = typeof r.metadata?.contactId === "string" ? r.metadata.contactId : null;
        return !!contact && hlIds.has(contact);
      });
      const recent = mine.filter((r) => ts(r.source_timestamp) >= quietSince);
      if (recent.length) continue;
      const prior = mine.filter((r) => {
        const t = ts(r.source_timestamp);
        return t >= priorStart && t < quietSince;
      });
      if (prior.length < MIN_PRIOR_ACTIVITY) continue;
      const lastActivity = prior.map((r) => ts(r.source_timestamp)).sort((a, b) => b - a)[0]!;
      const silentDays = Math.floor((ctx.now.getTime() - lastActivity) / 86_400_000);
      const lastViewed = ctx.attention.filter((a) => a.kind === "client_viewed" && a.ref_id === c.portal_client_id).map((a) => ts(a.created_at)).sort((a, b) => b - a)[0];
      out.push({
        fingerprint: `blindspot:quiet_client:${c.portal_client_id}`,
        subtype: "quiet_client",
        ref: c.portal_client_id,
        title: `${c.name} has gone quiet (${silentDays} days without activity)`,
        observed_facts: [
          `No leads, appointments, messages, invoices or portal activity for ${c.name} in the last ${QUIET_DAYS} days.`,
          `In the ${PRIOR_WINDOW_DAYS} days before that there were ${prior.length} activity records (about ${(prior.length / PRIOR_WINDOW_DAYS).toFixed(2)} per day).`,
          `Portal status is "${c.status}".`,
        ],
        metrics: { silent_days: silentDays, prior_activity: prior.length, prior_rate_per_day: Math.round((prior.length / PRIOR_WINDOW_DAYS) * 100) / 100, formula: `activity(last ${QUIET_DAYS}d) = 0 AND activity(prior ${PRIOR_WINDOW_DAYS}d) ≥ ${MIN_PRIOR_ACTIVITY}` },
        interpretation: "A client that was active and then went silent is a churn or delivery-stall signal that rarely shows up as a single finding.",
        attention: lastViewed ? `You last opened this client ${Math.floor((ctx.now.getTime() - lastViewed) / 86_400_000)} days ago.` : "You have not opened this client's overview in the last 30 days.",
        evidence: prior.slice(0, 5).map(evidenceOf),
        range_start: new Date(priorStart).toISOString(),
        range_end: ctx.now.toISOString(),
        confidence: 0.7,
        limitations: "Activity only counts records Jeff can attribute to the client; unattributed emails or calls are invisible here.",
        impact: "client",
      });
    }
    return out;
  },
};
