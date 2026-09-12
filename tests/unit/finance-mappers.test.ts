import { describe, expect, it } from "vitest";
import { mapCharge, mapCustomer, mapInvoice, mapSubscription, mapBalanceTransaction, mapPayout, mapRefund, mapDispute, emailDomain, emailHash } from "@/lib/integrations/sync/stripe-mappers";
import { mapAccount, mapTransaction, normaliseMerchant, toMinor } from "@/lib/integrations/sync/plaid-mappers";

describe("Stripe mappers", () => {
  it("charge: minor-unit amount, dashboard URL, customer label, no card data", () => {
    const item = mapCharge({
      id: "ch_1",
      amount: 12345,
      currency: "usd",
      status: "succeeded",
      paid: true,
      created: 1_700_000_000,
      customer: { id: "cus_1", name: "Acme LLC", email: "billing@acme.com" },
      payment_method_details: { type: "card" },
      billing_details: { name: "Jane Cardholder", email: "jane@acme.com" },
    });
    expect(item.resource_type).toBe("charge");
    expect(item.metadata.amount).toBe(12345);
    expect(item.metadata.currency).toBe("usd");
    expect(item.title).toContain("123.45 USD");
    expect(item.title).toContain("Acme LLC");
    expect(item.source_url).toBe("https://dashboard.stripe.com/payments/ch_1");
    expect(JSON.stringify(item)).not.toContain("Jane Cardholder");
    expect(JSON.stringify(item)).not.toContain("jane@acme.com");
    expect(item.source_timestamp).toBe("2023-11-14T22:13:20.000Z");
  });

  it("failed charge keeps the failure code and a bounded message", () => {
    const item = mapCharge({ id: "ch_2", amount: 500, currency: "usd", status: "failed", created: 1, failure_code: "card_declined", failure_message: "x".repeat(400) });
    expect(item.metadata.failure_code).toBe("card_declined");
    expect(String(item.metadata.failure_message).length).toBe(200);
    expect(item.tags).toContain("failed");
  });

  it("invoice: never stores hosted URLs, keeps dashboard link and amounts", () => {
    const item = mapInvoice({
      id: "in_1",
      number: "A-0001",
      status: "open",
      amount_due: 10000,
      amount_paid: 0,
      currency: "usd",
      created: 1_700_000_000,
      due_date: 1_700_500_000,
      customer: "cus_1",
      customer_email: "ap@client.com",
      ...({ hosted_invoice_url: "https://invoice.stripe.com/i/acct_x/live_SECRETTOKEN" } as object),
    });
    expect(JSON.stringify(item)).not.toContain("SECRETTOKEN");
    expect(item.source_url).toBe("https://dashboard.stripe.com/invoices/in_1");
    expect(item.metadata.amount_remaining).toBe(10000);
    expect(item.metadata.due_date).toBe("2023-11-20T17:06:40.000Z");
    expect(item.author).toBe("client.com");
  });

  it("subscription: items + MRR in minor units", () => {
    const item = mapSubscription({
      id: "sub_1",
      status: "active",
      created: 1,
      current_period_end: 2,
      cancel_at_period_end: true,
      customer: { id: "cus_1", name: "Acme" },
      items: { data: [{ quantity: 2, price: { id: "price_1", product: { id: "prod_1", name: "Pro" }, unit_amount: 12000, currency: "usd", recurring: { interval: "year", interval_count: 1 } } }] },
    });
    expect(item.metadata.mrr_minor).toBe(2000); // 2 × 12000/12
    expect(item.tags).toContain("cancelling");
    expect((item.metadata.items as unknown[]).length).toBe(1);
  });

  it("customer: email reduced to hash + domain; deleted customers skipped", () => {
    const item = mapCustomer({ id: "cus_1", name: "Acme", email: "Owner@Acme.com", created: 1, delinquent: true });
    expect(item).not.toBeNull();
    expect(JSON.stringify(item)).not.toContain("Owner@Acme.com");
    expect(item!.metadata.email_domain).toBe("acme.com");
    expect(item!.metadata.email_hash).toBe(emailHash("owner@acme.com"));
    expect(item!.tags).toContain("delinquent");
    expect(mapCustomer({ id: "cus_2", created: 1, deleted: true })).toBeNull();
  });

  it("refund/dispute/balance/payout carry amounts and statuses", () => {
    expect(mapRefund({ id: "re_1", amount: 100, currency: "usd", status: "succeeded", created: 1, charge: "ch_1" }).source_url).toBe("https://dashboard.stripe.com/payments/ch_1");
    const d = mapDispute({ id: "dp_1", amount: 5000, currency: "usd", status: "needs_response", reason: "fraudulent", created: 1 });
    expect(d.metadata.status).toBe("needs_response");
    const b = mapBalanceTransaction({ id: "txn_1", type: "charge", amount: 1000, fee: 59, net: 941, currency: "usd", created: 1 });
    expect(b.metadata.net).toBe(941);
    const p = mapPayout({ id: "po_1", amount: 941, currency: "usd", status: "paid", created: 1, arrival_date: 2 });
    expect(p.metadata.arrival_date).toBe("1970-01-01T00:00:02.000Z");
  });

  it("email helpers", () => {
    expect(emailDomain("a@b.co")).toBe("b.co");
    expect(emailDomain("")).toBeNull();
    expect(emailHash(null)).toBeNull();
  });
});

describe("Plaid mappers", () => {
  it("transaction: sign convention, minor units, merchant key, no account numbers", () => {
    const t = mapTransaction(
      { transaction_id: "t1", account_id: "acc_1", amount: 42.5, iso_currency_code: "USD", date: "2026-09-01", merchant_name: "Netflix #12345", name: "NETFLIX.COM 12345", pending: false, payment_channel: "online", personal_finance_category: { primary: "ENTERTAINMENT", detailed: "ENTERTAINMENT_TV_AND_MOVIES" } },
      "Test Bank",
    );
    expect(t.metadata.amount).toBe(4250);
    expect(t.metadata.direction).toBe("outflow");
    expect(t.metadata.merchant_key).toBe("netflix");
    expect(t.source_timestamp).toBe("2026-09-01T00:00:00.000Z");
    expect(t.tags).toContain("entertainment");
    expect(t.author).toBe("Test Bank");
    const inflow = mapTransaction({ transaction_id: "t2", account_id: "acc_1", amount: -1000, date: "2026-09-02", name: "Stripe payout" }, null);
    expect(inflow.metadata.amount).toBe(-100000);
    expect(inflow.metadata.direction).toBe("inflow");
  });

  it("account: mask/balances only", () => {
    const a = mapAccount(
      { account_id: "acc_1", name: "Business Checking", mask: "1234", type: "depository", subtype: "checking", balances: { current: 1500.25, available: 1400, iso_currency_code: "USD" }, ...({ account_number: "000123456789", routing: "011000015" } as object) },
      "Test Bank",
      "item_1",
    );
    const json = JSON.stringify(a);
    expect(json).not.toContain("000123456789");
    expect(json).not.toContain("011000015");
    expect(a.metadata.balance_current).toBe(150025);
    expect(a.title).toBe("Business Checking ••1234");
  });

  it("helpers", () => {
    expect(toMinor(0.1 + 0.2)).toBe(30);
    expect(toMinor(null)).toBe(0);
    expect(normaliseMerchant("AMZN Mktp US*2K4 88812")).toBe("amzn mktp us");
  });
});
