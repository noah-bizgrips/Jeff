import { evidenceOf, type CandidateFinding, type Monitor } from "./types";
import { money, num } from "./finance-shared";
import { clientIndex, clientLabel, groupBy, str } from "./portal-shared";

/**
 * Stripe invoices that are open/past-due AND attributed to a portal client
 * (metadata.client_id set by attribution). Complements `failed_payment`, which
 * is account-wide; this one says *which client*.
 */
export const clientUnpaidInvoice: Monitor = {
  id: "client_unpaid_invoice",
  run(rows, ctx) {
    const now = ctx.now.getTime();
    const idx = clientIndex(rows);
    const unpaid = rows.filter((r) => {
      if (r.provider !== "stripe" || r.resource_type !== "invoice") return false;
      if (!str(r.metadata.client_id)) return false;
      const status = String(r.metadata.status ?? "");
      if (status === "past_due" || status === "uncollectible") return true;
      if (status !== "open") return false;
      const due = str(r.metadata.due_date);
      return !!due && Date.parse(due) < now;
    });
    const out: CandidateFinding[] = [];
    for (const [clientId, invoices] of groupBy(unpaid, (r) => str(r.metadata.client_id))) {
      const name = clientLabel(idx, clientId, str(invoices[0]!.metadata.client_name));
      const currency = str(invoices[0]!.metadata.currency) ?? "usd";
      const outstanding = invoices.reduce((a, r) => a + num(r.metadata.amount_remaining ?? r.metadata.amount_due), 0);
      out.push({
        fingerprint: `client_unpaid_invoice:${clientId}`,
        category: "client_unpaid_invoice",
        title: `${name}: ${invoices.length} unpaid invoice${invoices.length === 1 ? "" : "s"} (${money(outstanding, currency)})`,
        observed_facts: invoices.slice(0, 8).map((r) => `Invoice ${str(r.metadata.number) ?? r.external_id} is ${String(r.metadata.status)} with ${money(num(r.metadata.amount_remaining ?? r.metadata.amount_due), currency)} outstanding${str(r.metadata.due_date) ? `, due ${str(r.metadata.due_date)!.slice(0, 10)}` : ""}.`),
        metrics: { invoices: invoices.length, outstanding_minor: outstanding, currency, attribution: str(invoices[0]!.metadata.attribution), formula: "Σ amount_remaining over open (due_date < now), past_due, uncollectible invoices attributed to this client" },
        interpretation: `Interpretation: ${name} is behind on payment. If work is still being delivered for them, this is the moment to pause new deliverables or send a reminder — Gomez will not contact them.`,
        evidence: invoices.slice(0, 10).map(evidenceOf),
        range_start: null,
        range_end: ctx.now.toISOString(),
        confidence: str(invoices[0]!.metadata.attribution) === "email" ? 0.7 : 0.9,
        limitations: "Attribution links Stripe customers to portal clients by hashed email/domain; a client paying from a different address is not matched. Invoices paid after the last sync clear on the next run.",
        severity: outstanding > 100_000 ? "high" : "medium",
        proposed_mission: { title: `Payment follow-up for ${name}`, goal: `Prepare a payment reminder for ${name} listing invoice numbers, amounts and due dates. Do not send it.` },
      });
    }
    return out;
  },
};
