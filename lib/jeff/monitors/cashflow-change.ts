import { evidenceOf, type CandidateFinding, type Monitor, type SourceRow } from "./types";
import { DAY, inWindow, money, pct, plaidFlows, stripeFlows } from "./finance-shared";

/**
 * Compares inflow/outflow for the last WINDOW_DAYS against the prior
 * WINDOW_DAYS. Reports when either side moved by more than PCT_THRESHOLD
 * AND more than ABS_THRESHOLD_MINOR. Plaid transactions and Stripe balance
 * transactions are evaluated as separate sources (they can double count when
 * Stripe payouts land in a Plaid-connected bank account, so they are never
 * summed together).
 */
export const WINDOW_DAYS = 30;
export const PCT_THRESHOLD = 25;
export const ABS_THRESHOLD_MINOR = 50_000; // $500.00
export const MIN_TRANSACTIONS = 20;

interface Flows {
  inflow: number;
  outflow: number;
  count: number;
}

function evaluate(source: "plaid" | "stripe", label: string, current: Flows, prior: Flows, currentRows: SourceRow[], ctx: { now: Date }): CandidateFinding | null {
  const inPct = pct(current.inflow, prior.inflow);
  const outPct = pct(current.outflow, prior.outflow);
  const inDelta = current.inflow - prior.inflow;
  const outDelta = current.outflow - prior.outflow;
  const inflowMoved = inPct !== null && Math.abs(inPct) > PCT_THRESHOLD && Math.abs(inDelta) > ABS_THRESHOLD_MINOR;
  const outflowMoved = outPct !== null && Math.abs(outPct) > PCT_THRESHOLD && Math.abs(outDelta) > ABS_THRESHOLD_MINOR;
  if (!inflowMoved && !outflowMoved) return null;
  if (prior.count === 0) return null; // nothing to compare against

  const parts: string[] = [];
  if (inflowMoved) parts.push(`inflow ${inPct! > 0 ? "up" : "down"} ${Math.abs(inPct!)}%`);
  if (outflowMoved) parts.push(`outflow ${outPct! > 0 ? "up" : "down"} ${Math.abs(outPct!)}%`);
  const lowConfidence = current.count + prior.count < MIN_TRANSACTIONS;
  const now = ctx.now.getTime();
  const rangeStart = new Date(now - 2 * WINDOW_DAYS * DAY).toISOString();

  return {
    fingerprint: `cashflow_change:${source}:${WINDOW_DAYS}d`,
    category: "cashflow_change",
    title: `${label}: ${parts.join(", ")} vs the prior ${WINDOW_DAYS} days`,
    observed_facts: [
      `Last ${WINDOW_DAYS} days: inflow ${money(current.inflow)}, outflow ${money(current.outflow)}, net ${money(current.inflow - current.outflow)} across ${current.count} transactions.`,
      `Prior ${WINDOW_DAYS} days: inflow ${money(prior.inflow)}, outflow ${money(prior.outflow)}, net ${money(prior.inflow - prior.outflow)} across ${prior.count} transactions.`,
    ],
    metrics: {
      window_days: WINDOW_DAYS,
      current: { inflow_minor: current.inflow, outflow_minor: current.outflow, net_minor: current.inflow - current.outflow, count: current.count },
      prior: { inflow_minor: prior.inflow, outflow_minor: prior.outflow, net_minor: prior.inflow - prior.outflow, count: prior.count },
      inflow_change_pct: inPct,
      outflow_change_pct: outPct,
      inflow_delta_minor: inDelta,
      outflow_delta_minor: outDelta,
      thresholds: { pct: PCT_THRESHOLD, abs_minor: ABS_THRESHOLD_MINOR },
      formula: "change_pct = (current − prior) / prior × 100; flagged when |change_pct| > pct AND |current − prior| > abs_minor",
    },
    interpretation:
      "Interpretation: a swing this size is usually one of: a large one-off payment or expense, a change in billing timing, or a real trend. Check the biggest transactions in the window before drawing conclusions.",
    evidence: currentRows
      .slice()
      .sort((a, b) => Math.abs(Number(b.metadata.amount ?? b.metadata.net ?? 0)) - Math.abs(Number(a.metadata.amount ?? a.metadata.net ?? 0)))
      .slice(0, 10)
      .map(evidenceOf),
    range_start: rangeStart,
    range_end: ctx.now.toISOString(),
    confidence: lowConfidence ? 0.4 : 0.7,
    limitations: `${lowConfidence ? `Fewer than ${MIN_TRANSACTIONS} transactions in the comparison, so this may be noise. ` : ""}Pending transactions are excluded; windows are calendar-based and can straddle billing cycles.`,
    severity: Math.max(Math.abs(inDelta), Math.abs(outDelta)) > 5 * ABS_THRESHOLD_MINOR ? "high" : "medium",
    proposed_mission: {
      title: `Explain the ${label.toLowerCase()} change`,
      goal: `List the transactions driving the ${parts.join(" and ")} over the last ${WINDOW_DAYS} days versus the prior period, grouped by merchant/customer, and note whether each looks one-off or recurring. Read-only analysis.`,
    },
  };
}

export const cashflowChange: Monitor = {
  id: "cashflow_change",
  run(rows, ctx) {
    const now = ctx.now.getTime();
    const currentStart = now - WINDOW_DAYS * DAY;
    const priorStart = now - 2 * WINDOW_DAYS * DAY;
    const current = rows.filter((r) => inWindow(r, currentStart, now));
    const prior = rows.filter((r) => inWindow(r, priorStart, currentStart));
    const out: CandidateFinding[] = [];
    const plaidNow = plaidFlows(current);
    const plaidPrior = plaidFlows(prior);
    if (plaidNow.count + plaidPrior.count > 0) {
      const f = evaluate("plaid", "Bank cash flow", plaidNow, plaidPrior, current.filter((r) => r.provider === "plaid" && r.resource_type === "transaction"), ctx);
      if (f) out.push(f);
    }
    const stripeNow = stripeFlows(current);
    const stripePrior = stripeFlows(prior);
    if (stripeNow.count + stripePrior.count > 0) {
      const f = evaluate("stripe", "Stripe revenue", stripeNow, stripePrior, current.filter((r) => r.provider === "stripe" && r.resource_type === "balance_transaction"), ctx);
      if (f) out.push(f);
    }
    return out;
  },
};
