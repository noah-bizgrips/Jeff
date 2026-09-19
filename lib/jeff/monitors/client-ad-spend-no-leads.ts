import { evidenceOf, type CandidateFinding, type Monitor } from "./types";
import { DAY, money, num, tsOf } from "./finance-shared";
import { clientIndex, clientLabel, groupBy, str } from "./portal-shared";

/**
 * Per client: Meta spend attributed to the client over WINDOW_DAYS exceeds
 * MIN_SPEND_MINOR while the portal recorded zero leads from that client's
 * sources in the same window. Only runs when attributed ad rows exist.
 */
export const WINDOW_DAYS = 7;
export const MIN_SPEND_MINOR = 10_000; // $100

export const clientAdSpendNoLeads: Monitor = {
  id: "client_ad_spend_no_leads",
  run(rows, ctx) {
    const now = ctx.now.getTime();
    const since = now - WINDOW_DAYS * DAY;
    const ads = rows.filter((r) => r.provider === "meta" && r.resource_type === "ad_insight" && !!str(r.metadata.client_id) && (tsOf(r) ?? 0) >= since);
    if (!ads.length) return [];
    const idx = clientIndex(rows);
    const leadsByClient = groupBy(
      rows.filter((r) => r.provider === "portal" && r.resource_type === "lead" && (tsOf(r) ?? 0) >= since),
      (r) => str(r.metadata.client_id),
    );
    const out: CandidateFinding[] = [];
    for (const [clientId, insights] of groupBy(ads, (r) => str(r.metadata.client_id))) {
      const spend = insights.reduce((a, r) => a + num(r.metadata.spend), 0);
      if (spend < MIN_SPEND_MINOR) continue;
      const leads = (leadsByClient.get(clientId) ?? []).length;
      if (leads > 0) continue;
      const name = clientLabel(idx, clientId, str(insights[0]!.metadata.client_name));
      const currency = str(insights[0]!.metadata.currency) ?? "usd";
      const campaigns = [...new Set(insights.map((r) => str(r.metadata.campaign_name)).filter(Boolean))].slice(0, 5);
      out.push({
        fingerprint: `client_ad_spend_no_leads:${clientId}`,
        category: "client_ad_spend_no_leads",
        title: `${name}: ${money(spend, currency)} of ad spend in ${WINDOW_DAYS} days with no portal leads`,
        observed_facts: [
          `Attributed Meta spend for ${name} over the last ${WINDOW_DAYS} days: ${money(spend, currency)} across ${insights.length} campaign-day rows${campaigns.length ? ` (${campaigns.join(", ")})` : ""}.`,
          `The portal recorded 0 leads from ${name}'s lead sources in the same window.`,
        ],
        metrics: { spend_minor: spend, currency, leads: 0, window_days: WINDOW_DAYS, campaign_days: insights.length, formula: "spend = Σ ad_insight.spend (attributed via meta_page → client); leads = count(portal leads for client in window)" },
        interpretation: "Interpretation: either the ads are not converting or the lead route (Meta form → portal) is broken. Check the lead source before touching the campaign — a routing failure looks identical to a creative failure from here.",
        evidence: insights.slice(0, 10).map(evidenceOf),
        range_start: new Date(since).toISOString(),
        range_end: ctx.now.toISOString(),
        confidence: 0.65,
        limitations: "Ad spend is attributed to a client only through a Facebook page id recorded in the portal; spend on accounts without a mapped page is not counted. Meta's attribution can restate for 3 days.",
        severity: spend > 50_000 ? "high" : "medium",
        proposed_mission: { title: `Check lead routing and ad performance for ${name}`, goal: `Verify the Meta form/page → portal lead source for ${name} is active and receiving leads, then compare campaign CPL against prior weeks. Do not change budgets.` },
      });
    }
    return out;
  },
};
