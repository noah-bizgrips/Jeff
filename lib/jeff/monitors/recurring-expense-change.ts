import { evidenceOf, str, type CandidateFinding, type Monitor, type SourceRow } from "./types";
import { DAY, money, num, tsOf } from "./finance-shared";

/**
 * Recurring outflows (Plaid) grouped by normalised merchant. A merchant is
 * "recurring" when it has >= MIN_OCCURRENCES charges at roughly monthly
 * cadence (MIN_GAP_DAYS..MAX_GAP_DAYS between consecutive charges, on
 * average). Flags:
 *   - amount drift: latest charge differs from the median by > DRIFT_PCT
 *   - missing: no charge in the last MISSING_AFTER_DAYS although the cadence
 *     says one was due (subscription cancelled, card failed, or vendor change)
 */
export const MIN_OCCURRENCES = 3;
export const MIN_GAP_DAYS = 20;
export const MAX_GAP_DAYS = 40;
export const DRIFT_PCT = 15;
export const MISSING_AFTER_DAYS = 45;
export const LOOKBACK_DAYS = 200;
const MIN_AMOUNT_MINOR = 500; // ignore sub-$5 noise

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

interface Occurrence {
  row: SourceRow;
  ts: number;
  amount: number;
}

export const recurringExpenseChange: Monitor = {
  id: "recurring_expense_change",
  run(rows, ctx) {
    const now = ctx.now.getTime();
    const since = now - LOOKBACK_DAYS * DAY;
    const byMerchant = new Map<string, Occurrence[]>();
    for (const r of rows) {
      if (r.provider !== "plaid" || r.resource_type !== "transaction") continue;
      if (r.metadata.pending === true) continue;
      const amount = num(r.metadata.amount);
      if (amount < MIN_AMOUNT_MINOR) continue; // outflows only, ignore tiny ones
      const ts = tsOf(r);
      if (ts === null || ts < since) continue;
      const key = str(r.metadata.merchant_key) ?? "";
      if (!key) continue;
      const list = byMerchant.get(key) ?? [];
      list.push({ row: r, ts, amount });
      byMerchant.set(key, list);
    }

    const out: CandidateFinding[] = [];
    for (const [key, occ] of byMerchant) {
      if (occ.length < MIN_OCCURRENCES) continue;
      occ.sort((a, b) => a.ts - b.ts);
      const gaps: number[] = [];
      for (let i = 1; i < occ.length; i++) gaps.push((occ[i]!.ts - occ[i - 1]!.ts) / DAY);
      const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      if (avgGap < MIN_GAP_DAYS || avgGap > MAX_GAP_DAYS) continue;
      const merchant = str(occ[occ.length - 1]!.row.metadata.merchant_name) ?? occ[occ.length - 1]!.row.title;
      const currency = str(occ[0]!.row.metadata.currency) ?? "USD";
      const amounts = occ.map((o) => o.amount);
      const med = median(amounts.slice(0, -1).length ? amounts.slice(0, -1) : amounts);
      const latest = occ[occ.length - 1]!;
      const driftPct = med ? Math.round(((latest.amount - med) / med) * 1000) / 10 : 0;
      const daysSinceLast = (now - latest.ts) / DAY;
      const evidence = occ.slice(-6).map((o) => evidenceOf(o.row));
      const rangeStart = new Date(occ[0]!.ts).toISOString();

      if (Math.abs(driftPct) > DRIFT_PCT) {
        out.push({
          fingerprint: `recurring_expense_change:drift:${key}`,
          category: "recurring_expense_change",
          title: `${merchant} charged ${money(latest.amount, currency)} — ${driftPct > 0 ? "up" : "down"} ${Math.abs(driftPct)}% from its usual ${money(med, currency)}`,
          observed_facts: [
            `${occ.length} charges from ${merchant} in the last ${LOOKBACK_DAYS} days, about every ${Math.round(avgGap)} days.`,
            `Typical amount ${money(med, currency)}; latest on ${latest.row.metadata.date ?? new Date(latest.ts).toISOString().slice(0, 10)} was ${money(latest.amount, currency)}.`,
          ],
          metrics: { occurrences: occ.length, avg_gap_days: Math.round(avgGap * 10) / 10, median_minor: med, latest_minor: latest.amount, drift_pct: driftPct, currency, formula: "drift_pct = (latest − median(previous)) / median(previous) × 100" },
          interpretation: "Interpretation: a recurring charge that changed size usually means a plan change, a price increase, usage-based billing, or an extra seat. Worth a quick check that it was expected.",
          evidence,
          range_start: rangeStart,
          range_end: ctx.now.toISOString(),
          confidence: occ.length >= 5 ? 0.8 : 0.6,
          limitations: "Merchant grouping is name-based and can merge or split vendors with inconsistent descriptors. Amounts in the local account currency.",
          severity: Math.abs(latest.amount - med) > 20_000 ? "medium" : "low",
          proposed_mission: { title: `Check the ${merchant} charge change`, goal: `Find the reason ${merchant} now bills ${money(latest.amount, currency)} instead of ${money(med, currency)} (plan, seats, usage, or price increase) using synced records. Read-only.` },
        });
      }

      if (daysSinceLast > Math.max(MISSING_AFTER_DAYS, avgGap * 1.5)) {
        out.push({
          fingerprint: `recurring_expense_change:missing:${key}`,
          category: "recurring_expense_change",
          title: `${merchant} (usually ${money(med, currency)} every ~${Math.round(avgGap)} days) has not charged in ${Math.floor(daysSinceLast)} days`,
          observed_facts: [
            `${occ.length} charges from ${merchant} between ${rangeStart.slice(0, 10)} and ${new Date(latest.ts).toISOString().slice(0, 10)}.`,
            `No charge in the last ${Math.floor(daysSinceLast)} days; the cadence predicted one around ${new Date(latest.ts + avgGap * DAY).toISOString().slice(0, 10)}.`,
          ],
          metrics: { occurrences: occ.length, avg_gap_days: Math.round(avgGap * 10) / 10, median_minor: med, days_since_last: Math.floor(daysSinceLast), currency, formula: "flag when days_since_last > max(45, 1.5 × avg_gap_days)" },
          interpretation: "Interpretation: a recurring vendor that stopped charging may have been cancelled, may have a failed payment, or moved to a different card/account. If the service is still in use, a lapse could cause an interruption.",
          evidence,
          range_start: rangeStart,
          range_end: ctx.now.toISOString(),
          confidence: 0.6,
          limitations: "Only sees accounts connected through Plaid; a vendor moved to another card looks like a stopped charge.",
          severity: "low",
          proposed_mission: { title: `Confirm status of ${merchant}`, goal: `Check whether the ${merchant} subscription is still active or intentionally cancelled, using synced records only. No changes.` },
        });
      }
    }
    return out;
  },
};
