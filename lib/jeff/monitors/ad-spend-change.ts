import { evidenceOf, type CandidateFinding, type Monitor } from "./types";
import { DAY, money, pct } from "./finance-shared";
import { adDays, ADS_LIMITATIONS, median, sumSpend } from "./ads-shared";

/**
 * Ad spend change: (a) last 7 days vs the prior 7 days, flagged when the change
 * is > CHANGE_PCT and > CHANGE_MINOR; (b) any single day > SPIKE_FACTOR × the
 * 14-day median daily spend. One finding per condition per account.
 */
export const CHANGE_PCT = 30;
export const CHANGE_MINOR = 20_000; // $200.00
export const SPIKE_FACTOR = 1.5;

export const adSpendChange: Monitor = {
  id: "ad_spend_change",
  run(rows, ctx) {
    const now = ctx.now.getTime();
    const days = adDays(rows);
    if (!days.length) return [];
    const byAccount = new Map<string, typeof days>();
    for (const d of days) byAccount.set(d.accountId, [...(byAccount.get(d.accountId) ?? []), d]);
    const findings: CandidateFinding[] = [];

    for (const [accountId, list] of byAccount) {
      const currency = list[0]!.currency;
      const last7 = list.filter((d) => d.ts >= now - 7 * DAY && d.ts < now);
      const prior7 = list.filter((d) => d.ts >= now - 14 * DAY && d.ts < now - 7 * DAY);
      const cur = sumSpend(last7);
      const prev = sumSpend(prior7);
      const change = pct(cur, prev);
      if (prior7.length && change !== null && Math.abs(change) > CHANGE_PCT && Math.abs(cur - prev) > CHANGE_MINOR) {
        const up = cur > prev;
        findings.push({
          fingerprint: `ad_spend_change:meta:${accountId}:weekly`,
          category: "ad_spend_change",
          title: `Meta ad spend ${up ? "up" : "down"} ${Math.abs(change)}% week over week (${money(cur, currency)} vs ${money(prev, currency)})`,
          observed_facts: [
            `Spend in the last 7 days: ${money(cur, currency)} across ${new Set(last7.map((d) => d.campaignId)).size} campaigns.`,
            `Spend in the prior 7 days: ${money(prev, currency)} across ${new Set(prior7.map((d) => d.campaignId)).size} campaigns.`,
          ],
          metrics: { spend_last_7_minor: cur, spend_prior_7_minor: prev, change_pct: change, currency, formula: "change_pct = (spend_last_7 − spend_prior_7) / spend_prior_7 × 100" },
          interpretation: up
            ? "Interpretation: spend accelerated. That is fine if it was planned (new campaign, budget increase); if not, check for a runaway budget or an audience change."
            : "Interpretation: spend dropped. Campaigns may have paused, hit budget caps, or lost delivery; lead volume will follow.",
          evidence: [...last7, ...prior7].slice(0, 15).map((d) => evidenceOf(d.row)),
          range_start: new Date(now - 14 * DAY).toISOString(),
          range_end: ctx.now.toISOString(),
          confidence: 0.8,
          limitations: ADS_LIMITATIONS,
          severity: Math.abs(cur - prev) > 5 * CHANGE_MINOR ? "high" : "medium",
          proposed_mission: {
            title: "Review Meta spend change",
            goal: `Explain the ${Math.abs(change)}% week-over-week change in Meta ad spend for account ${accountId}: which campaigns changed, whether it was intentional, and its effect on leads and CPL. Read-only analysis; no budget changes.`,
          },
        });
      }

      // Daily spike vs the 14-day median.
      const perDay = new Map<string, number>();
      for (const d of list.filter((x) => x.ts >= now - 14 * DAY)) perDay.set(d.date, (perDay.get(d.date) ?? 0) + d.spend);
      const med = median([...perDay.values()]);
      if (med && med > 0) {
        for (const [date, spend] of perDay) {
          if (spend > SPIKE_FACTOR * med && spend - med > CHANGE_MINOR / 2) {
            findings.push({
              fingerprint: `ad_spend_change:meta:${accountId}:spike:${date}`,
              category: "ad_spend_change",
              title: `Meta daily spend spike on ${date}: ${money(spend, currency)} vs ${money(Math.round(med), currency)} median`,
              observed_facts: [`Spend on ${date} was ${money(spend, currency)}; the 14-day median daily spend is ${money(Math.round(med), currency)}.`],
              metrics: {
                day_spend_minor: spend,
                median_daily_minor: Math.round(med),
                factor: Math.round((spend / med) * 100) / 100,
                currency,
                formula: `spike when day_spend > ${SPIKE_FACTOR} × median(daily spend over 14 days)`,
              },
              interpretation: "Interpretation: a single-day spike usually means a budget or bid change, a new campaign launch, or a delivery anomaly.",
              evidence: list.filter((d) => d.date === date).slice(0, 10).map((d) => evidenceOf(d.row)),
              range_start: new Date(now - 14 * DAY).toISOString(),
              range_end: ctx.now.toISOString(),
              confidence: 0.7,
              limitations: ADS_LIMITATIONS,
              severity: "medium",
              proposed_mission: null,
            });
          }
        }
      }
    }
    return findings;
  },
};
