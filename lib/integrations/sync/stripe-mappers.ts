import { createHash } from "node:crypto";
import type { SourceItemInput } from "./types";

/**
 * Pure mappers from Stripe API objects to normalised source_items.
 *
 * Rules:
 *  - amounts are stored as integers in MINOR units (cents) plus a currency code;
 *  - no card numbers, no addresses, no phone numbers, no hosted URLs that carry
 *    secret tokens (hosted_invoice_url, receipt_url, invoice_pdf are dropped);
 *  - customer emails are reduced to a sha256 hash + domain; names are kept as
 *    given by the customer record (business-facing).
 *
 * The input types are deliberately structural (plain object shapes) so the
 * mappers stay testable without Stripe SDK class instances.
 */

const PROVIDER = "stripe";
const CAPABILITY = "reporting";
const DASHBOARD = "https://dashboard.stripe.com";

export interface StripeCustomerRef {
  id: string;
  name?: string | null;
  email?: string | null;
  deleted?: boolean;
}

export interface StripeChargeLike {
  id: string;
  amount: number;
  currency: string;
  status: string;
  paid?: boolean;
  refunded?: boolean;
  amount_refunded?: number;
  created: number;
  customer?: string | StripeCustomerRef | null;
  invoice?: string | { id: string } | null;
  description?: string | null;
  failure_code?: string | null;
  failure_message?: string | null;
  payment_method_details?: { type?: string | null } | null;
  billing_details?: { name?: string | null; email?: string | null } | null;
}

export interface StripeInvoiceLike {
  id: string;
  number?: string | null;
  status?: string | null;
  amount_due: number;
  amount_paid: number;
  amount_remaining?: number;
  currency: string;
  created: number;
  due_date?: number | null;
  paid?: boolean;
  attempt_count?: number;
  customer?: string | StripeCustomerRef | null;
  customer_name?: string | null;
  customer_email?: string | null;
  subscription?: string | { id: string } | null;
}

export interface StripeSubscriptionLike {
  id: string;
  status: string;
  created: number;
  current_period_end?: number | null;
  cancel_at_period_end?: boolean;
  canceled_at?: number | null;
  customer?: string | StripeCustomerRef | null;
  items?: {
    data?: {
      quantity?: number | null;
      price?: {
        id: string;
        product?: string | { id: string; name?: string | null } | null;
        unit_amount?: number | null;
        currency?: string;
        recurring?: { interval?: string | null; interval_count?: number | null } | null;
        nickname?: string | null;
      } | null;
    }[];
  };
}

export interface StripeCustomerLike {
  id: string;
  name?: string | null;
  email?: string | null;
  created: number;
  delinquent?: boolean | null;
  currency?: string | null;
  description?: string | null;
  deleted?: boolean;
}

export interface StripeRefundLike {
  id: string;
  amount: number;
  currency: string;
  status?: string | null;
  reason?: string | null;
  created: number;
  charge?: string | { id: string } | null;
}

export interface StripeDisputeLike {
  id: string;
  amount: number;
  currency: string;
  status: string;
  reason?: string | null;
  created: number;
  charge?: string | { id: string } | null;
  evidence_details?: { due_by?: number | null } | null;
}

export interface StripeBalanceTransactionLike {
  id: string;
  type: string;
  amount: number;
  fee: number;
  net: number;
  currency: string;
  created: number;
  available_on?: number;
  status?: string;
  description?: string | null;
  reporting_category?: string | null;
}

export interface StripePayoutLike {
  id: string;
  amount: number;
  currency: string;
  status: string;
  created: number;
  arrival_date?: number;
  method?: string | null;
  type?: string | null;
  automatic?: boolean;
}

export function epochToIso(sec: number | null | undefined): string | null {
  if (typeof sec !== "number" || !Number.isFinite(sec)) return null;
  return new Date(sec * 1000).toISOString();
}

export function formatMinor(amount: number, currency: string): string {
  const major = amount / 100;
  return `${major.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency.toUpperCase()}`;
}

export function emailHash(email: string | null | undefined): string | null {
  const e = (email ?? "").trim().toLowerCase();
  return e ? createHash("sha256").update(e).digest("hex") : null;
}

export function emailDomain(email: string | null | undefined): string | null {
  const e = (email ?? "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  return at > 0 ? e.slice(at + 1) : null;
}

function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

function customerLabel(c: string | StripeCustomerRef | null | undefined, fallbackName?: string | null, fallbackEmail?: string | null): string | null {
  if (c && typeof c === "object" && !c.deleted) {
    if (c.name) return c.name;
    const d = emailDomain(c.email);
    if (d) return d;
  }
  if (fallbackName) return fallbackName;
  const d = emailDomain(fallbackEmail);
  return d ?? null;
}

function hashOf(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function base(resourceType: string, externalId: string, fields: Partial<SourceItemInput>): SourceItemInput {
  return {
    provider: PROVIDER,
    capability: CAPABILITY,
    resource_type: resourceType,
    external_id: externalId,
    title: fields.title ?? externalId,
    summary: fields.summary ?? null,
    author: fields.author ?? null,
    source_url: fields.source_url ?? null,
    source_timestamp: fields.source_timestamp ?? null,
    content_hash: fields.content_hash ?? null,
    tags: fields.tags ?? [],
    metadata: fields.metadata ?? {},
  };
}

export function mapCharge(c: StripeChargeLike): SourceItemInput {
  const who = customerLabel(c.customer, c.billing_details?.name, c.billing_details?.email);
  const failed = c.status === "failed";
  const metadata: Record<string, unknown> = {
    amount: c.amount,
    currency: c.currency.toLowerCase(),
    status: c.status,
    paid: !!c.paid,
    refunded: !!c.refunded,
    amount_refunded: c.amount_refunded ?? 0,
    customerId: idOf(c.customer),
    invoiceId: idOf(c.invoice),
    paymentMethodType: c.payment_method_details?.type ?? null,
  };
  if (failed) {
    metadata.failure_code = c.failure_code ?? null;
    metadata.failure_message = c.failure_message ? String(c.failure_message).slice(0, 200) : null;
  }
  return base("charge", c.id, {
    title: `${formatMinor(c.amount, c.currency)} · ${c.status}${who ? ` · ${who}` : ""}`,
    summary: `Payment charge${who ? ` from ${who}` : ""} — ${c.status === "succeeded" ? "paid" : c.status}, ${formatMinor(c.amount, c.currency)}${c.refunded ? " (refunded)" : ""}${c.description ? `. ${String(c.description).slice(0, 200)}` : ""}`,
    author: who,
    source_url: `${DASHBOARD}/payments/${c.id}`,
    source_timestamp: epochToIso(c.created),
    content_hash: hashOf([c.amount, c.status, c.refunded, c.amount_refunded]),
    tags: ["payment", c.status, ...(c.refunded ? ["refunded"] : [])],
    metadata,
  });
}

export function mapInvoice(inv: StripeInvoiceLike): SourceItemInput {
  const who = customerLabel(inv.customer, inv.customer_name, inv.customer_email);
  const status = inv.status ?? "unknown";
  const when = epochToIso(inv.created);
  const paidWord = status === "paid" ? "paid" : status === "open" ? "open (unpaid)" : status;
  return base("invoice", inv.id, {
    title: `${inv.number ?? inv.id} · ${status} · ${formatMinor(inv.amount_due, inv.currency)}${who ? ` · ${who}` : ""}`,
    // Searchable, human sentence so "Seever invoice paid 1500" style questions match.
    summary: `Invoice ${inv.number ?? inv.id}${who ? ` for ${who}` : ""} — ${paidWord}, ${formatMinor(inv.amount_due, inv.currency)}${inv.amount_paid && inv.amount_paid !== inv.amount_due ? ` (paid ${formatMinor(inv.amount_paid, inv.currency)})` : ""}${when ? `, created ${when.slice(0, 10)}` : ""}${inv.due_date ? `, due ${epochToIso(inv.due_date)?.slice(0, 10)}` : ""}.`,
    author: who,
    // Never the hosted_invoice_url / invoice_pdf (they embed access tokens).
    source_url: `${DASHBOARD}/invoices/${inv.id}`,
    source_timestamp: epochToIso(inv.created),
    content_hash: hashOf([status, inv.amount_due, inv.amount_paid, inv.attempt_count]),
    tags: ["invoice", status],
    metadata: {
      status,
      amount_due: inv.amount_due,
      amount_paid: inv.amount_paid,
      amount_remaining: inv.amount_remaining ?? Math.max(0, inv.amount_due - inv.amount_paid),
      currency: inv.currency.toLowerCase(),
      customerId: idOf(inv.customer),
      subscriptionId: idOf(inv.subscription),
      due_date: epochToIso(inv.due_date),
      paid: !!inv.paid,
      attempt_count: inv.attempt_count ?? 0,
      number: inv.number ?? null,
    },
  });
}

export function mapSubscription(s: StripeSubscriptionLike): SourceItemInput {
  const items = (s.items?.data ?? []).map((it) => ({
    priceId: it.price?.id ?? null,
    productId: idOf(it.price?.product ?? null),
    productName: it.price?.product && typeof it.price.product === "object" ? (it.price.product.name ?? null) : null,
    quantity: it.quantity ?? 1,
    unit_amount: it.price?.unit_amount ?? null,
    currency: it.price?.currency ?? null,
    interval: it.price?.recurring?.interval ?? null,
    interval_count: it.price?.recurring?.interval_count ?? null,
  }));
  const mrrMinor = items.reduce((acc, it) => {
    if (it.unit_amount == null) return acc;
    const perMonth = it.interval === "year" ? it.unit_amount / 12 / (it.interval_count ?? 1) : it.interval === "month" ? it.unit_amount / (it.interval_count ?? 1) : it.interval === "week" ? (it.unit_amount * 52) / 12 : it.interval === "day" ? it.unit_amount * 30 : 0;
    return acc + perMonth * (it.quantity ?? 1);
  }, 0);
  const who = customerLabel(s.customer);
  const label = items.map((i) => i.productName ?? i.priceId).filter(Boolean).join(", ");
  return base("subscription", s.id, {
    title: `Subscription · ${s.status}${label ? ` · ${label}` : ""}${who ? ` · ${who}` : ""}`,
    author: who,
    source_url: `${DASHBOARD}/subscriptions/${s.id}`,
    source_timestamp: epochToIso(s.created),
    content_hash: hashOf([s.status, s.current_period_end, s.cancel_at_period_end, items]),
    tags: ["subscription", s.status, ...(s.cancel_at_period_end ? ["cancelling"] : [])],
    metadata: {
      status: s.status,
      current_period_end: epochToIso(s.current_period_end),
      cancel_at_period_end: !!s.cancel_at_period_end,
      canceled_at: epochToIso(s.canceled_at),
      customerId: idOf(s.customer),
      items,
      mrr_minor: Math.round(mrrMinor),
      currency: items[0]?.currency ?? null,
    },
  });
}

export function mapCustomer(c: StripeCustomerLike): SourceItemInput | null {
  if (c.deleted) return null;
  const domain = emailDomain(c.email);
  return base("customer", c.id, {
    title: c.name ?? domain ?? c.id,
    summary: c.description ? String(c.description).slice(0, 200) : null,
    source_url: `${DASHBOARD}/customers/${c.id}`,
    source_timestamp: epochToIso(c.created),
    content_hash: hashOf([c.name, domain, c.delinquent]),
    tags: ["customer", ...(c.delinquent ? ["delinquent"] : [])],
    metadata: {
      created: epochToIso(c.created),
      delinquent: !!c.delinquent,
      currency: c.currency ?? null,
      email_hash: emailHash(c.email),
      email_domain: domain,
    },
  });
}

export function mapRefund(r: StripeRefundLike): SourceItemInput {
  return base("refund", r.id, {
    title: `Refund ${formatMinor(r.amount, r.currency)} · ${r.status ?? "unknown"}`,
    source_url: idOf(r.charge) ? `${DASHBOARD}/payments/${idOf(r.charge)}` : null,
    source_timestamp: epochToIso(r.created),
    content_hash: hashOf([r.amount, r.status, r.reason]),
    tags: ["refund", ...(r.status ? [r.status] : [])],
    metadata: { amount: r.amount, currency: r.currency.toLowerCase(), status: r.status ?? null, reason: r.reason ?? null, chargeId: idOf(r.charge) },
  });
}

export function mapDispute(d: StripeDisputeLike): SourceItemInput {
  return base("dispute", d.id, {
    title: `Dispute ${formatMinor(d.amount, d.currency)} · ${d.status}${d.reason ? ` · ${d.reason}` : ""}`,
    source_url: `${DASHBOARD}/disputes/${d.id}`,
    source_timestamp: epochToIso(d.created),
    content_hash: hashOf([d.amount, d.status, d.reason]),
    tags: ["dispute", d.status],
    metadata: {
      amount: d.amount,
      currency: d.currency.toLowerCase(),
      status: d.status,
      reason: d.reason ?? null,
      chargeId: idOf(d.charge),
      evidence_due_by: epochToIso(d.evidence_details?.due_by),
    },
  });
}

export function mapBalanceTransaction(b: StripeBalanceTransactionLike): SourceItemInput {
  return base("balance_transaction", b.id, {
    title: `${b.type} · ${formatMinor(b.net, b.currency)} net`,
    summary: b.description ? String(b.description).slice(0, 200) : null,
    source_url: `${DASHBOARD}/balance/history`,
    source_timestamp: epochToIso(b.created),
    content_hash: hashOf([b.amount, b.fee, b.net, b.status]),
    tags: ["balance", b.type],
    metadata: {
      type: b.type,
      reporting_category: b.reporting_category ?? null,
      amount: b.amount,
      fee: b.fee,
      net: b.net,
      currency: b.currency.toLowerCase(),
      available_on: epochToIso(b.available_on),
      status: b.status ?? null,
    },
  });
}

export function mapPayout(p: StripePayoutLike): SourceItemInput {
  return base("payout", p.id, {
    title: `Payout ${formatMinor(p.amount, p.currency)} · ${p.status}`,
    source_url: `${DASHBOARD}/payouts/${p.id}`,
    source_timestamp: epochToIso(p.created),
    content_hash: hashOf([p.amount, p.status, p.arrival_date]),
    tags: ["payout", p.status],
    metadata: {
      amount: p.amount,
      currency: p.currency.toLowerCase(),
      status: p.status,
      arrival_date: epochToIso(p.arrival_date),
      method: p.method ?? null,
      type: p.type ?? null,
      automatic: !!p.automatic,
    },
  });
}
