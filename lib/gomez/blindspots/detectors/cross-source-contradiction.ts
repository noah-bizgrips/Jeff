import { clientIdOf, daysAgo, evidenceOf, ts, type BlindSpotCandidate, type BlindSpotContext, type Detector } from "../types";
import type { SourceRow } from "@/lib/gomez/monitors/types";
import { isPublicMailboxDomain } from "@/lib/gomez/clients/map-core";

/** A delivery client with no billing activity for this long contradicts "we are serving them". */
export const NO_BILLING_DAYS = 45;
/** A meeting with a client contact followed by silence for this long. */
export const NO_FOLLOWUP_DAYS = 5;

function domainOfEmail(e: string): string | null {
  const at = e.lastIndexOf("@");
  return at >= 0 ? e.slice(at + 1).toLowerCase() : null;
}

function attendeeDomains(r: SourceRow): string[] {
  const list = r.metadata?.attendees;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const a of list) {
    const email = typeof a === "string" ? a : typeof (a as { email?: unknown })?.email === "string" ? ((a as { email: string }).email as string) : null;
    const d = email ? domainOfEmail(email) : null;
    if (d) out.push(d);
  }
  return out;
}

export const crossSourceContradiction: Detector = {
  id: "cross_source_contradiction",
  run(ctx: BlindSpotContext): BlindSpotCandidate[] {
    const out: BlindSpotCandidate[] = [];
    const billingSince = daysAgo(ctx, NO_BILLING_DAYS);

    // 1. Delivery client with no Stripe invoice/charge attributed in 45+ days.
    for (const c of ctx.clients) {
      if (c.status !== "delivery") continue;
      const custIds = new Set(c.stripe_customer_ids);
      const billing = ctx.sourceItems.filter((r) => r.provider === "stripe" && (r.resource_type === "invoice" || r.resource_type === "charge") && (clientIdOf(r) === c.portal_client_id || (typeof r.metadata?.customerId === "string" && custIds.has(r.metadata.customerId as string))));
      const recent = billing.filter((r) => ts(r.source_timestamp) >= billingSince);
      if (recent.length) continue;
      const last = billing.map((r) => ts(r.source_timestamp)).filter(Number.isFinite).sort((a, b) => b - a)[0];
      out.push({
        fingerprint: `blindspot:contradiction:no_billing:${c.portal_client_id}`,
        subtype: "cross_source_contradiction",
        ref: `no_billing:${c.portal_client_id}`,
        title: `${c.name} is in delivery but has no Stripe billing in ${NO_BILLING_DAYS}+ days`,
        observed_facts: [`Portal status: delivery.`, last ? `Last attributed Stripe invoice/charge: ${new Date(last).toISOString().slice(0, 10)}.` : `No Stripe invoice or charge is attributed to this client at all.`, `Stripe customers matched to this client: ${c.stripe_customer_ids.length}.`],
        metrics: { days_since_billing: last ? Math.floor((ctx.now.getTime() - last) / 86_400_000) : null, threshold_days: NO_BILLING_DAYS, matched_stripe_customers: c.stripe_customer_ids.length, formula: `days since last attributed invoice/charge > ${NO_BILLING_DAYS}` },
        interpretation: c.stripe_customer_ids.length ? "Either the client stopped being billed, or billing moved somewhere Gomez can't see. Both are worth a look." : "Gomez can't match this client to a Stripe customer by email, so either billing is off-platform or the attribution needs a manual link.",
        attention: "Billing gaps per client don't appear in any dashboard; you only notice at month end.",
        evidence: billing.slice(0, 3).map(evidenceOf),
        range_start: new Date(billingSince).toISOString(),
        range_end: ctx.now.toISOString(),
        confidence: c.stripe_customer_ids.length ? 0.75 : 0.5,
        limitations: "Attribution is by client-user email → Stripe customer email; a different billing contact breaks the link.",
        impact: "financial",
      });
    }

    // 2. HighLevel opportunity won with no portal client.
    const portalClientContactIds = new Set(ctx.clients.flatMap((c) => [c.ghl_contact_id, ...c.highlevel_contact_ids].filter(Boolean) as string[]));
    const wonSince = daysAgo(ctx, 60);
    for (const r of ctx.sourceItems) {
      if (r.provider !== "highlevel" || r.resource_type !== "opportunity") continue;
      const status = String(r.metadata?.status ?? "").toLowerCase();
      const stage = String(r.metadata?.stage ?? "").toLowerCase();
      if (!(status === "won" || /won|signed|client/.test(stage))) continue;
      if (ts(r.source_timestamp) < wonSince) continue;
      const contactId = typeof r.metadata?.contactId === "string" ? r.metadata.contactId : null;
      if (clientIdOf(r) || (contactId && portalClientContactIds.has(contactId))) continue;
      out.push({
        fingerprint: `blindspot:contradiction:won_no_client:${r.external_id}`,
        subtype: "cross_source_contradiction",
        ref: `won_no_client:${r.external_id}`,
        title: `"${r.title ?? "Opportunity"}" is won in HighLevel but has no client portal`,
        observed_facts: [`Opportunity status/stage: ${status || stage}.`, `Updated ${r.source_timestamp ?? "unknown"}.`, `No portal client matches its contact.`],
        metrics: { days_since_won: Math.floor((ctx.now.getTime() - ts(r.source_timestamp)) / 86_400_000), formula: "won opportunity (≤60d) with no portal client sharing its contact id" },
        interpretation: "A signed deal without a portal means onboarding hasn't started (or is being tracked off-system). Time-to-first-payment usually slips from exactly here.",
        attention: "Won deals leave the pipeline views you watch; the missing portal only shows up when the client asks.",
        evidence: [evidenceOf(r)],
        range_start: new Date(wonSince).toISOString(),
        range_end: ctx.now.toISOString(),
        confidence: 0.7,
        limitations: "Stage names are matched heuristically (won/signed/client).",
        impact: "client",
      });
    }

    // 3. Calendar event with a client-domain attendee, then no conversation for 5 days.
    const clientDomains = new Map<string, (typeof ctx.clients)[number]>();
    for (const c of ctx.clients) for (const d of c.email_domains) if (!isPublicMailboxDomain(d)) clientDomains.set(d.toLowerCase(), c);
    if (clientDomains.size) {
      const eventSince = daysAgo(ctx, 21);
      const cutoff = daysAgo(ctx, NO_FOLLOWUP_DAYS);
      for (const ev of ctx.sourceItems) {
        if (ev.resource_type !== "event") continue;
        const t = ts(ev.source_timestamp);
        if (!(t >= eventSince && t <= cutoff)) continue;
        const dom = attendeeDomains(ev).find((d) => clientDomains.has(d));
        if (!dom) continue;
        const client = clientDomains.get(dom)!;
        const followUp = ctx.sourceItems.some((m) => (m.resource_type === "message" || m.resource_type === "email") && ts(m.source_timestamp) > t && (clientIdOf(m) === client.portal_client_id || (m.author ?? "").toLowerCase().includes(`@${dom}`) || (m.title ?? "").toLowerCase().includes(client.name.toLowerCase())));
        if (followUp) continue;
        out.push({
          fingerprint: `blindspot:contradiction:meeting_no_followup:${ev.external_id}`,
          subtype: "cross_source_contradiction",
          ref: `meeting_no_followup:${ev.external_id}`,
          title: `Met with ${client.name} on ${new Date(t).toISOString().slice(0, 10)} — no follow-up conversation since`,
          observed_facts: [`Calendar event "${ev.title ?? "meeting"}" included an attendee at ${dom}.`, `No email or message involving ${client.name} has been synced in the ${NO_FOLLOWUP_DAYS}+ days since.`],
          metrics: { days_since_meeting: Math.floor((ctx.now.getTime() - t) / 86_400_000), threshold_days: NO_FOLLOWUP_DAYS, formula: `event with client-domain attendee AND no later message/email for ${NO_FOLLOWUP_DAYS}d` },
          interpretation: "Meetings that aren't followed by any written communication tend to be the ones where commitments were made verbally and then forgotten.",
          attention: "Past meetings drop off the calendar view; nothing reminds you a thread never started.",
          evidence: [evidenceOf(ev)],
          range_start: new Date(t).toISOString(),
          range_end: ctx.now.toISOString(),
          confidence: 0.55,
          limitations: "Follow-ups by phone or SMS outside synced sources are invisible; attendee matching is by email domain only.",
          impact: "client",
        });
      }
    }
    return out;
  },
};
