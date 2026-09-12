import { describe, expect, it } from "vitest";
import type { SourceRow } from "@/lib/jeff/monitors/types";
import { failedPayment, HIGH_MINOR } from "@/lib/jeff/monitors/failed-payment";
import { cashflowChange } from "@/lib/jeff/monitors/cashflow-change";
import { recurringExpenseChange } from "@/lib/jeff/monitors/recurring-expense-change";
import { summarizeFinance } from "@/lib/jeff/tools";

const NOW = new Date("2026-09-12T12:00:00.000Z");
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();

let seq = 0;
function row(partial: Partial<SourceRow> & { provider: string; resource_type: string; metadata?: Record<string, unknown> }): SourceRow {
  seq++;
  return {
    id: `row-${seq}`,
    capability: null,
    external_id: partial.external_id ?? `ext-${seq}`,
    title: partial.title ?? `item ${seq}`,
    summary: null,
    author: partial.author ?? null,
    source_url: null,
    source_timestamp: partial.source_timestamp ?? daysAgo(1),
    tags: [],
    ...partial,
    metadata: partial.metadata ?? {},
  };
}

function plaidTx(amountMinor: number, day: number, merchant: string, extra: Record<string, unknown> = {}): SourceRow {
  return row({
    provider: "plaid",
    resource_type: "transaction",
    source_timestamp: daysAgo(day),
    metadata: { amount: amountMinor, currency: "USD", merchant_name: merchant, merchant_key: merchant.toLowerCase(), pending: false, ...extra },
  });
}

describe("failed_payment monitor", () => {
  it("flags past-due invoices and failed charges; severity high over $500", () => {
    const rows = [
      row({ provider: "stripe", resource_type: "invoice", author: "acme.com", metadata: { status: "open", amount_due: 60000, amount_remaining: 60000, due_date: daysAgo(3), number: "A-1", currency: "usd" } }),
      row({ provider: "stripe", resource_type: "invoice", metadata: { status: "open", amount_due: 100, amount_remaining: 100, due_date: new Date(NOW.getTime() + 5 * DAY).toISOString(), currency: "usd" } }), // not yet due
      row({ provider: "stripe", resource_type: "invoice", metadata: { status: "paid", amount_due: 100, amount_remaining: 0, currency: "usd" } }),
      row({ provider: "stripe", resource_type: "charge", source_timestamp: daysAgo(2), metadata: { status: "failed", amount: 2500, currency: "usd", failure_code: "card_declined" } }),
      row({ provider: "stripe", resource_type: "charge", source_timestamp: daysAgo(60), metadata: { status: "failed", amount: 9999, currency: "usd" } }), // outside lookback
    ];
    const out = failedPayment.run(rows, { now: NOW });
    expect(out).toHaveLength(1);
    const f = out[0]!;
    expect(f.metrics.past_due_invoices).toBe(1);
    expect(f.metrics.failed_charges).toBe(1);
    expect(f.metrics.total_minor).toBe(62500);
    expect(f.severity).toBe("high");
    expect(f.evidence).toHaveLength(2);
    expect(f.fingerprint).toBe("failed_payment:stripe:open");
    expect(HIGH_MINOR).toBe(50000);
  });
  it("is silent when nothing is owed or failed", () => {
    expect(failedPayment.run([row({ provider: "stripe", resource_type: "invoice", metadata: { status: "paid", amount_due: 1 } })], { now: NOW })).toEqual([]);
  });
});

describe("cashflow_change monitor", () => {
  it("flags a > 25% and > $500 outflow increase (bank) with formulas", () => {
    const rows: SourceRow[] = [];
    for (let i = 0; i < 12; i++) rows.push(plaidTx(10000, 5 + i, `Vendor ${i}`)); // current: $1,200 outflow
    for (let i = 0; i < 12; i++) rows.push(plaidTx(5000, 35 + i, `Vendor ${i}`)); // prior: $600 outflow
    const out = cashflowChange.run(rows, { now: NOW });
    expect(out).toHaveLength(1);
    const f = out[0]!;
    expect(f.fingerprint).toBe("cashflow_change:plaid:30d");
    expect(f.metrics.outflow_change_pct).toBe(100);
    expect(String(f.metrics.formula)).toContain("change_pct");
    expect(f.confidence).toBe(0.7);
  });
  it("ignores small or proportionally small changes and pending rows", () => {
    const rows: SourceRow[] = [];
    for (let i = 0; i < 12; i++) rows.push(plaidTx(10000, 5 + i, "V"));
    for (let i = 0; i < 12; i++) rows.push(plaidTx(9000, 35 + i, "V")); // +11%
    rows.push(plaidTx(900000, 2, "Pending giant", { pending: true }));
    expect(cashflowChange.run(rows, { now: NOW })).toEqual([]);
  });
  it("evaluates Stripe balance transactions separately and excludes payouts", () => {
    const rows: SourceRow[] = [];
    for (let i = 0; i < 6; i++) rows.push(row({ provider: "stripe", resource_type: "balance_transaction", source_timestamp: daysAgo(3 + i), metadata: { type: "charge", net: 20000 } }));
    for (let i = 0; i < 6; i++) rows.push(row({ provider: "stripe", resource_type: "balance_transaction", source_timestamp: daysAgo(33 + i), metadata: { type: "charge", net: 5000 } }));
    rows.push(row({ provider: "stripe", resource_type: "balance_transaction", source_timestamp: daysAgo(4), metadata: { type: "payout", net: -900000 } }));
    const out = cashflowChange.run(rows, { now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]!.fingerprint).toBe("cashflow_change:stripe:30d");
    expect((out[0]!.metrics.current as { outflow_minor: number }).outflow_minor).toBe(0);
    expect(out[0]!.confidence).toBe(0.4); // fewer than 20 transactions
  });
});

describe("recurring_expense_change monitor", () => {
  it("flags amount drift on a monthly vendor", () => {
    const rows = [plaidTx(4999, 95, "Notion"), plaidTx(4999, 65, "Notion"), plaidTx(4999, 35, "Notion"), plaidTx(7999, 5, "Notion")];
    const out = recurringExpenseChange.run(rows, { now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]!.fingerprint).toBe("recurring_expense_change:drift:notion");
    expect(out[0]!.metrics.drift_pct).toBe(60);
    expect(out[0]!.title).toContain("up 60%");
  });
  it("flags a recurring vendor that stopped charging", () => {
    const rows = [plaidTx(2000, 150, "Zoom"), plaidTx(2000, 120, "Zoom"), plaidTx(2000, 90, "Zoom"), plaidTx(2000, 60, "Zoom")];
    const out = recurringExpenseChange.run(rows, { now: NOW });
    expect(out.map((f) => f.fingerprint)).toEqual(["recurring_expense_change:missing:zoom"]);
  });
  it("ignores irregular, tiny, inflow, or too-few merchants", () => {
    const rows = [
      plaidTx(2000, 3, "Coffee"),
      plaidTx(2000, 4, "Coffee"),
      plaidTx(2000, 5, "Coffee"), // gaps of 1 day: not monthly
      plaidTx(300, 65, "Tiny"),
      plaidTx(300, 35, "Tiny"),
      plaidTx(300, 5, "Tiny"), // below $5
      plaidTx(-50000, 65, "Client"),
      plaidTx(-50000, 35, "Client"),
      plaidTx(-50000, 5, "Client"), // inflow
      plaidTx(9000, 35, "Once"),
      plaidTx(9000, 5, "Once"), // only 2
    ];
    expect(recurringExpenseChange.run(rows, { now: NOW })).toEqual([]);
  });
});

describe("get_financial_summary aggregation", () => {
  it("returns bounded, PII-free totals in minor units", () => {
    const rows = [
      { provider: "stripe", resource_type: "balance_transaction", title: "", source_timestamp: daysAgo(2), metadata: { type: "charge", net: 941, currency: "usd" } },
      { provider: "stripe", resource_type: "balance_transaction", title: "", source_timestamp: daysAgo(2), metadata: { type: "payout", net: -941 } },
      { provider: "stripe", resource_type: "charge", title: "", source_timestamp: daysAgo(2), metadata: { status: "failed", amount: 500 } },
      { provider: "stripe", resource_type: "invoice", title: "", source_timestamp: daysAgo(40), metadata: { status: "open", amount_due: 1000, amount_remaining: 1000, due_date: daysAgo(1) } },
      { provider: "stripe", resource_type: "subscription", title: "", source_timestamp: daysAgo(200), metadata: { status: "active", mrr_minor: 4900 } },
      { provider: "plaid", resource_type: "transaction", title: "", source_timestamp: daysAgo(3), metadata: { amount: 2500, merchant_name: "Adobe", merchant_key: "adobe", pending: false } },
      { provider: "plaid", resource_type: "transaction", title: "", source_timestamp: daysAgo(3), metadata: { amount: -10000, merchant_name: "Client", merchant_key: "client", pending: false } },
      { provider: "plaid", resource_type: "account", title: "Checking ••1111", source_timestamp: daysAgo(0), metadata: { name: "Checking", type: "depository", subtype: "checking", balance_current: 12345, currency: "USD", email: "leak@example.com" } },
    ];
    const s = summarizeFinance(rows, 30);
    expect(s.stripe.inflow_minor).toBe(941);
    expect(s.stripe.outflow_minor).toBe(0); // payouts excluded
    expect(s.stripe.charges_failed).toBe(1);
    expect(s.invoices.past_due_count).toBe(1);
    expect(s.subscriptions.mrr_minor).toBe(4900);
    expect(s.bank.inflow_minor).toBe(10000);
    expect(s.bank.outflow_minor).toBe(2500);
    expect(s.top_merchants[0]).toEqual({ name: "Adobe", total_minor: 2500, count: 1 });
    expect(s.accounts[0]!.balance_current_minor).toBe(12345);
    expect(JSON.stringify(s)).not.toContain("leak@example.com");
    expect(s.note).toBeUndefined();
    expect(summarizeFinance([], 30).note).toMatch(/No financial records/);
  });
});
