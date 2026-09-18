import { createHash } from "node:crypto";
import type { SourceItemInput } from "./types";

/**
 * Pure mappers from Plaid objects to normalised source_items.
 *
 * Money: Plaid amounts are decimal major units where POSITIVE = money leaving
 * the account (outflow) and NEGATIVE = money coming in. We store
 * `amount` as an INTEGER in minor units with the SAME sign convention, plus
 * `direction` ("outflow" | "inflow") for readability.
 *
 * Never stored: account numbers, routing numbers, owner names/addresses,
 * or anything from Plaid's Auth/Identity products (which Gomez never requests).
 */

const PROVIDER = "plaid";
const CAPABILITY = "transactions";

export interface PlaidTransactionLike {
  transaction_id: string;
  account_id: string;
  amount: number;
  iso_currency_code?: string | null;
  unofficial_currency_code?: string | null;
  date: string;
  authorized_date?: string | null;
  name?: string | null;
  merchant_name?: string | null;
  pending?: boolean;
  payment_channel?: string | null;
  personal_finance_category?: { primary?: string | null; detailed?: string | null } | null;
  category?: string[] | null;
}

export interface PlaidAccountLike {
  account_id: string;
  name?: string | null;
  official_name?: string | null;
  mask?: string | null;
  type?: string | null;
  subtype?: string | null;
  balances?: {
    current?: number | null;
    available?: number | null;
    limit?: number | null;
    iso_currency_code?: string | null;
    unofficial_currency_code?: string | null;
  } | null;
}

export function toMinor(amount: number | null | undefined): number {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return 0;
  return Math.round(amount * 100);
}

export function normaliseMerchant(name: string | null | undefined): string {
  // Lowercase, drop reference-like tokens (anything containing a digit, e.g. "#12345", "*2K4", store numbers), keep letters.
  return (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b[a-z0-9]*\d[a-z0-9]*\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashOf(parts: unknown[]) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function currencyOf(iso?: string | null, unofficial?: string | null) {
  return (iso ?? unofficial ?? "USD").toUpperCase();
}

export function mapTransaction(t: PlaidTransactionLike, institution: string | null): SourceItemInput {
  const amountMinor = toMinor(t.amount);
  const direction = amountMinor > 0 ? "outflow" : "inflow";
  const currency = currencyOf(t.iso_currency_code, t.unofficial_currency_code);
  const label = t.merchant_name ?? t.name ?? "Transaction";
  const primary = t.personal_finance_category?.primary ?? t.category?.[0] ?? null;
  const detailed = t.personal_finance_category?.detailed ?? null;
  return {
    provider: PROVIDER,
    capability: CAPABILITY,
    resource_type: "transaction",
    external_id: t.transaction_id,
    title: `${label} · ${(Math.abs(amountMinor) / 100).toFixed(2)} ${currency}${t.pending ? " · pending" : ""}`,
    summary: [primary, detailed].filter(Boolean).join(" / ") || null,
    author: institution,
    source_url: null,
    source_timestamp: t.date ? `${t.date}T00:00:00.000Z` : null,
    content_hash: hashOf([amountMinor, t.pending, t.merchant_name, t.name, primary]),
    tags: ["transaction", direction, ...(t.pending ? ["pending"] : []), ...(primary ? [primary.toLowerCase()] : [])],
    metadata: {
      amount: amountMinor,
      direction,
      currency,
      date: t.date,
      authorized_date: t.authorized_date ?? null,
      pending: !!t.pending,
      category: primary,
      category_detailed: detailed,
      account_id: t.account_id,
      payment_channel: t.payment_channel ?? null,
      merchant_name: t.merchant_name ?? null,
      merchant_key: normaliseMerchant(t.merchant_name ?? t.name),
    },
  };
}

export function mapAccount(a: PlaidAccountLike, institution: string | null, itemId: string): SourceItemInput {
  const currency = currencyOf(a.balances?.iso_currency_code, a.balances?.unofficial_currency_code);
  const label = a.name ?? a.official_name ?? a.type ?? "Account";
  return {
    provider: PROVIDER,
    capability: CAPABILITY,
    resource_type: "account",
    external_id: a.account_id,
    title: `${label}${a.mask ? ` ••${a.mask}` : ""}`,
    summary: [a.type, a.subtype].filter(Boolean).join(" / ") || null,
    author: institution,
    source_url: null,
    source_timestamp: new Date().toISOString(),
    content_hash: hashOf([a.balances?.current, a.balances?.available, a.balances?.limit]),
    tags: ["account", ...(a.type ? [String(a.type)] : [])],
    metadata: {
      item_id: itemId,
      name: label,
      mask: a.mask ?? null, // last digits only, as supplied by Plaid
      type: a.type ?? null,
      subtype: a.subtype ?? null,
      balance_current: a.balances?.current != null ? toMinor(a.balances.current) : null,
      balance_available: a.balances?.available != null ? toMinor(a.balances.available) : null,
      credit_limit: a.balances?.limit != null ? toMinor(a.balances.limit) : null,
      currency,
    },
  };
}
