import type { SourceRow } from "./types";

/** Shared helpers for finance monitors. Amounts are integers in minor units. */

export const DAY = 86_400_000;

export function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function money(minor: number, currency = "USD"): string {
  const sign = minor < 0 ? "-" : "";
  return `${sign}$${(Math.abs(minor) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${currency && currency.toUpperCase() !== "USD" ? ` ${currency.toUpperCase()}` : ""}`;
}

export function tsOf(r: SourceRow): number | null {
  const iso = r.source_timestamp ?? (typeof r.metadata.date === "string" ? `${r.metadata.date}T00:00:00.000Z` : null);
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

export function inWindow(r: SourceRow, start: number, end: number): boolean {
  const t = tsOf(r);
  return t !== null && t >= start && t < end;
}

/** Plaid transactions: positive amount = outflow. Returns { inflow, outflow } in minor units (both positive). */
export function plaidFlows(rows: SourceRow[]): { inflow: number; outflow: number; count: number } {
  let inflow = 0;
  let outflow = 0;
  let count = 0;
  for (const r of rows) {
    if (r.provider !== "plaid" || r.resource_type !== "transaction") continue;
    if (r.metadata.pending === true) continue;
    const a = num(r.metadata.amount);
    if (a > 0) outflow += a;
    else inflow += -a;
    count++;
  }
  return { inflow, outflow, count };
}

/** Stripe balance transactions: net > 0 is inflow to the balance, net < 0 (payouts, refunds) is outflow. */
export function stripeFlows(rows: SourceRow[]): { inflow: number; outflow: number; count: number } {
  let inflow = 0;
  let outflow = 0;
  let count = 0;
  for (const r of rows) {
    if (r.provider !== "stripe" || r.resource_type !== "balance_transaction") continue;
    // Payouts move money to the bank (already counted by Plaid if connected); exclude to avoid double counting outflow.
    if (String(r.metadata.type ?? "") === "payout") continue;
    const n = num(r.metadata.net);
    if (n > 0) inflow += n;
    else outflow += -n;
    count++;
  }
  return { inflow, outflow, count };
}

export function pct(now: number, before: number): number | null {
  if (before === 0) return now === 0 ? 0 : null;
  return Math.round(((now - before) / before) * 1000) / 10;
}
