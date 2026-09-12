import { evidenceOf, type CandidateFinding, type Monitor } from "./types";
import { DAY, money } from "./finance-shared";
import { adDays, ADS_LIMITATIONS, median, sumSpend } from "./ads-shared";

/**
 * Underperforming acquisition: a campaign whose 30-day cost per lead is more
 * than CPL_FACTOR × the account's median campaign CPL (with at least MIN_LEADS
 * leads), or a campaign that spent > NO_LEAD_SPEND_MINOR over 7 days with zero
 * leads.
 */
export const CPL_FACTOR = 1.5;
export const MIN_LEADS = 10;
export const NO_LEAD_SPEND_MINOR = 10_000; // $100.00

export const underperformingAcquisition: Monitor = {
  id: "underperforming_acquisition",
  run(rows, ctx) {
    const now = ctx.now.getTime();
    const days = adDays(rows).filter((d) => d.ts >= now - 30 * DAY && d.ts < now);
    if (!days.length) return [];
    const findings: CandidateFinding[] = [];
    const byAccount = new Map<string, typeof days>();
    for (const d of days) byAccount.set(d.accountId, [...(byAccount.get(d.accountId) ?? []), d]);

    for (const [accountId, list] of byAccount) {
      const currency = list[0]!.currency;
      const byCampaign = new Map<string, typeof list>();
      for (const d of list) byCampaign.set(d.campaignId, [...(byCampaign.get(d.campaignId) ?? []), d]);
      const cpls: { id: string; name: string; spend: number; leads: number; cpl: number }[] = [];
      for (const [id, cd] of byCampaign) {
        const spend = sumSpend(cd);
        const leads = cd.reduce((a, d) => a + d.leads, 0);
        if (leads > 0) cpls.push({ id, name: cd[0]!.campaignName, spend, leads, cpl: spend / leads });
      }
      const med = median(cpls.filter((c) => c.leads >= MIN_LEADS).map((c) => c.cpl));

      if (med && med > 0) {
        for (const c of cpls) {
          if (c.leads >= MIN_LEADS && c.cpl > CPL_FACTOR * med) {
            findings.push({
              fingerprint: `underperforming_acquisition:meta:${accountId}:${c.id}:cpl`,
              category: "underperforming_acquisition",
              title: `"${c.name}" costs ${money(Math.round(c.cpl), currency)} per lead vs ${money(Math.round(med), currency)} median`,
              observed_facts: [
                `Campaign "${c.name}" spent ${money(c.spend, currency)} for ${c.leads} leads in 30 days.`,
                `Median cost per lead across campaigns with ≥ ${MIN_LEADS} leads: ${money(Math.round(med), currency)}.`,
              ],
              metrics: {
                spend_minor: c.spend,
                leads: c.leads,
                cpl_minor: Math.round(c.cpl),
                median_cpl_minor: Math.round(med),
                factor: Math.round((c.cpl / med) * 100) / 100,
                currency,
                formula: "cpl = spend / leads; flagged when cpl > 1.5 × median(cpl of campaigns with ≥ 10 leads)",
              },
              interpretation:
                "Interpretation: this campaign buys leads much less efficiently than the rest of the account. Common causes: audience fatigue, creative decay, or a broader objective. Consider pausing or reallocating — a change Jeff will only prepare, not make.",
              evidence: byCampaign.get(c.id)!.slice(0, 10).map((d) => evidenceOf(d.row)),
              range_start: new Date(now - 30 * DAY).toISOString(),
              range_end: ctx.now.toISOString(),
              confidence: 0.75,
              limitations: ADS_LIMITATIONS,
              severity: c.cpl > 2 * med ? "high" : "medium",
              proposed_mission: {
                title: `Review campaign "${c.name}"`,
                goal: `Analyze why "${c.name}" has a cost per lead of ${money(Math.round(c.cpl), currency)} against a ${money(Math.round(med), currency)} account median: creative, audience, placement and landing-page differences. Propose a reallocation for approval; do not change budgets.`,
              },
            });
          }
        }
      }

      // Spend with zero leads over the last 7 days.
      for (const [id, cd] of byCampaign) {
        const last7 = cd.filter((d) => d.ts >= now - 7 * DAY);
        const spend = sumSpend(last7);
        const leads = last7.reduce((a, d) => a + d.leads, 0);
        if (spend > NO_LEAD_SPEND_MINOR && leads === 0) {
          findings.push({
            fingerprint: `underperforming_acquisition:meta:${accountId}:${id}:noleads`,
            category: "underperforming_acquisition",
            title: `"${cd[0]!.campaignName}" spent ${money(spend, currency)} in 7 days with no leads`,
            observed_facts: [`Campaign "${cd[0]!.campaignName}" spent ${money(spend, currency)} over the last 7 days and reported 0 lead actions.`],
            metrics: { spend_7d_minor: spend, leads_7d: 0, currency, formula: "flagged when Σ spend (7d) > $100 and Σ leads (7d) = 0" },
            interpretation:
              "Interpretation: either the campaign's objective is not lead generation (awareness/traffic), lead tracking is broken, or the campaign is not converting. Verify the objective and the pixel/lead-form setup first.",
            evidence: last7.slice(0, 10).map((d) => evidenceOf(d.row)),
            range_start: new Date(now - 7 * DAY).toISOString(),
            range_end: ctx.now.toISOString(),
            confidence: 0.6,
            limitations: `${ADS_LIMITATIONS} Campaigns with non-lead objectives will trigger this rule; dismiss or add a rule to exclude them.`,
            severity: spend > 5 * NO_LEAD_SPEND_MINOR ? "high" : "medium",
            proposed_mission: null,
          });
        }
      }
    }
    return findings;
  },
};
