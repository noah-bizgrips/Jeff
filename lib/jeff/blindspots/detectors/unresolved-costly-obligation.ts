import { DAY, evidenceOf, money, ts, type BlindSpotCandidate, type BlindSpotContext, type Detector } from "../types";
import type { SourceRow } from "@/lib/jeff/monitors/types";

/**
 * An obligation Jeff has reminded about ≥ MIN_REMINDERS times, still open,
 * that is tied to a recurring charge whose next billing lands within
 * LOOKAHEAD_DAYS. "Cancel Calendly" reminded three times while Calendly bills
 * again on Friday is a blind spot with a price tag.
 */

export const MIN_REMINDERS = 3;
export const LOOKAHEAD_DAYS = 14;
const OPEN = new Set(["open", "waiting", "overdue", "snoozed", "possibly_complete", "needs_confirmation"]);

const ACTION_WORDS = /\b(cancel|cancellation|downgrade|renew|renewal|switch|migrate|review|unsubscribe|stop paying|pay|invoice|subscription|plan|bill|billing|charge)\b/i;

interface Recurring {
  merchant: string;
  name: string;
  amount: number;
  currency: string;
  cadenceDays: number;
  nextAt: number;
  rows: SourceRow[];
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : 0;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Recurring outflows (Plaid or Stripe subscriptions) with a predicted next charge. */
export function recurringCharges(rows: SourceRow[], now: number): Recurring[] {
  const byMerchant = new Map<string, SourceRow[]>();
  for (const r of rows) {
    const plaid = r.provider === "plaid" && r.resource_type === "transaction" && !r.metadata.pending && num(r.metadata.amount) > 0 && str(r.metadata.direction) !== "inflow";
    if (!plaid) continue;
    const key = (str(r.metadata.merchant_key) ?? str(r.metadata.merchant_name) ?? r.title ?? "").toLowerCase();
    if (!key) continue;
    byMerchant.set(key, [...(byMerchant.get(key) ?? []), r]);
  }
  const out: Recurring[] = [];
  for (const [merchant, list] of byMerchant) {
    const sorted = list.map((r) => ({ r, at: ts(r.source_timestamp) })).filter((x) => Number.isFinite(x.at)).sort((a, b) => a.at - b.at);
    if (sorted.length < 2) continue;
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) gaps.push((sorted[i]!.at - sorted[i - 1]!.at) / DAY);
    const cadence = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    if (cadence < 6 || cadence > 400) continue;
    const last = sorted.at(-1)!;
    let nextAt = last.at + cadence * DAY;
    while (nextAt < now - DAY) nextAt += cadence * DAY;
    out.push({ merchant, name: str(last.r.metadata.merchant_name) ?? last.r.title ?? merchant, amount: Math.abs(num(last.r.metadata.amount)), currency: (str(last.r.metadata.currency) ?? "USD").toUpperCase(), cadenceDays: Math.round(cadence), nextAt, rows: sorted.map((x) => x.r) });
  }
  return out;
}

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3);
}

export const unresolvedCostlyObligation: Detector = {
  id: "unresolved_costly_obligation",
  run(ctx: BlindSpotContext): BlindSpotCandidate[] {
    const obligations = (ctx.obligations ?? []).filter((o) => OPEN.has(o.status) && o.reminder_count >= MIN_REMINDERS);
    if (!obligations.length) return [];
    const now = ctx.now.getTime();
    const recurring = recurringCharges(ctx.sourceItems, now).filter((r) => r.nextAt - now <= LOOKAHEAD_DAYS * DAY);
    if (!recurring.length) return [];
    const out: BlindSpotCandidate[] = [];
    for (const o of obligations) {
      const text = `${o.title} ${o.counterparty ?? ""} ${str(o.metadata.merchant) ?? ""}`;
      const explicit = str(o.metadata.merchant_key)?.toLowerCase() ?? null;
      const ow = words(text);
      const match = recurring.find((r) => {
        if (explicit && r.merchant === explicit) return true;
        const mw = words(r.name).concat(words(r.merchant));
        return mw.some((w) => w.length >= 4 && ow.includes(w));
      });
      if (!match) continue;
      const days = Math.max(0, Math.round((match.nextAt - now) / DAY));
      const actionable = ACTION_WORDS.test(o.title);
      const annual = Math.round(match.amount * (365 / Math.max(1, match.cadenceDays)));
      out.push({
        fingerprint: `blindspot:unresolved_costly_obligation:${o.id}`,
        subtype: "unresolved_costly_obligation",
        ref: o.id,
        title: `"${o.title}" is still open after ${o.reminder_count} reminders — ${match.name} bills ${money(match.amount, match.currency)} in ${days} day${days === 1 ? "" : "s"}`,
        observed_facts: [
          `Obligation "${o.title}" (${o.status.replace(/_/g, " ")}) has been reminded ${o.reminder_count} times${o.due_at ? `; due ${o.due_at.slice(0, 10)}` : ""}.`,
          `${match.name} charges about every ${match.cadenceDays} days; last ${new Date(ts(match.rows.at(-1)!.source_timestamp)).toISOString().slice(0, 10)} for ${money(match.amount, match.currency)}; next expected ${new Date(match.nextAt).toISOString().slice(0, 10)}.`,
          `${match.rows.length} charges on record (≈ ${money(annual, match.currency)}/year).`,
        ],
        metrics: { obligation_id: o.id, reminders: o.reminder_count, min_reminders: MIN_REMINDERS, merchant: match.merchant, next_charge_minor: match.amount, amount_minor: match.amount, annualised_minor: annual, cadence_days: match.cadenceDays, days_until: days, due_at: new Date(match.nextAt).toISOString(), currency: match.currency, consequence_minor: match.amount, formula: `open obligation with reminders ≥ ${MIN_REMINDERS} whose merchant matches a recurring charge due within ${LOOKAHEAD_DAYS} days` },
        interpretation: actionable ? `Every reminder so far has been ignored and the next charge lands anyway. Doing it now saves ${money(match.amount, match.currency)}; leaving it costs ≈ ${money(annual, match.currency)} a year.` : `The obligation and the charge share a merchant; if the intent is to change or stop the service, the next charge is the deadline.`,
        attention: `Reminded ${o.reminder_count} times without an action; the money side lives in a different tool than the reminder.`,
        evidence: match.rows.slice(-2).map(evidenceOf),
        range_start: match.rows[0]?.source_timestamp ?? null,
        range_end: ctx.now.toISOString(),
        confidence: explicit ? 0.85 : actionable ? 0.7 : 0.55,
        limitations: "The link between the obligation and the charge is by merchant name unless the obligation records the merchant explicitly.",
        impact: "financial",
      });
    }
    return out;
  },
};
