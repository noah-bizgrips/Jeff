import { evidenceOf, str, type CandidateFinding, type Monitor, type SourceRow } from "./types";
import { DAY, money, num, tsOf } from "./finance-shared";

/**
 * Failed charges and open/past-due invoices in the last LOOKBACK_DAYS.
 * Severity is high when the outstanding + failed total exceeds HIGH_MINOR.
 */
export const LOOKBACK_DAYS = 30;
export const HIGH_MINOR = 50_000; // $500.00

export const failedPayment: Monitor = {
  id: "failed_payment",
  run(rows, ctx) {
    const now = ctx.now.getTime();
    const since = now - LOOKBACK_DAYS * DAY;
    const failedCharges: SourceRow[] = [];
    const openInvoices: SourceRow[] = [];
    for (const r of rows) {
      if (r.provider !== "stripe") continue;
      const t = tsOf(r);
      if (r.resource_type === "charge") {
        if (r.metadata.status === "failed" && t !== null && t >= since) failedCharges.push(r);
      } else if (r.resource_type === "invoice") {
        const status = String(r.metadata.status ?? "");
        if (status !== "open" && status !== "past_due" && status !== "uncollectible") continue;
        const due = str(r.metadata.due_date);
        const dueTs = due ? Date.parse(due) : NaN;
        const pastDue = status !== "open" || (Number.isFinite(dueTs) && dueTs < now);
        if (pastDue) openInvoices.push(r);
      }
    }
    if (!failedCharges.length && !openInvoices.length) return [];

    const failedTotal = failedCharges.reduce((a, r) => a + num(r.metadata.amount), 0);
    const outstanding = openInvoices.reduce((a, r) => a + num(r.metadata.amount_remaining ?? r.metadata.amount_due), 0);
    const total = failedTotal + outstanding;
    const currency = str(failedCharges[0]?.metadata.currency) ?? str(openInvoices[0]?.metadata.currency) ?? "usd";
    const evidenceRows = [...openInvoices, ...failedCharges].slice(0, 15);

    const facts: string[] = [];
    for (const r of openInvoices.slice(0, 8)) {
      facts.push(`Invoice ${str(r.metadata.number) ?? r.external_id} (${r.author ?? "customer"}) is ${String(r.metadata.status)} with ${money(num(r.metadata.amount_remaining ?? r.metadata.amount_due), currency)} outstanding${str(r.metadata.due_date) ? `, due ${String(r.metadata.due_date).slice(0, 10)}` : ""}.`);
    }
    for (const r of failedCharges.slice(0, 8)) {
      facts.push(`Charge ${r.external_id} for ${money(num(r.metadata.amount), currency)} failed${str(r.metadata.failure_code) ? ` (${String(r.metadata.failure_code)})` : ""}${r.author ? ` — ${r.author}` : ""}.`);
    }

    const finding: CandidateFinding = {
      fingerprint: "failed_payment:stripe:open",
      category: "failed_payment",
      title: `${openInvoices.length} past-due invoice${openInvoices.length === 1 ? "" : "s"} and ${failedCharges.length} failed charge${failedCharges.length === 1 ? "" : "s"} (${money(total, currency)})`,
      observed_facts: facts,
      metrics: {
        past_due_invoices: openInvoices.length,
        outstanding_minor: outstanding,
        failed_charges: failedCharges.length,
        failed_minor: failedTotal,
        total_minor: total,
        currency,
        lookback_days: LOOKBACK_DAYS,
        formula: "outstanding = Σ invoice.amount_remaining (open & due_date < now, past_due, uncollectible); failed = Σ charge.amount (status = failed, created within lookback)",
      },
      interpretation:
        "Interpretation: money that is owed or that bounced. Past-due invoices usually need a friendly reminder or an updated card; repeated failed charges on the same customer often indicate an expired card. Gomez will not contact customers — it can prepare the list.",
      evidence: evidenceRows.map(evidenceOf),
      range_start: new Date(since).toISOString(),
      range_end: ctx.now.toISOString(),
      confidence: 0.9,
      limitations: "Based on synced Stripe objects only; payments collected outside Stripe are not visible. Invoices marked paid after the last sync will clear on the next run.",
      severity: total > HIGH_MINOR ? "high" : "medium",
      proposed_mission: {
        title: "Prepare a collections follow-up list",
        goal: `Prepare a list of ${openInvoices.length} past-due invoices and ${failedCharges.length} failed charges with customer, amount, age, and a suggested next step for each. Do not send any messages.`,
      },
    };
    return [finding];
  },
};
