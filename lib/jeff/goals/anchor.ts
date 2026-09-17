import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { TimeframeAnchor } from "./schema";

/**
 * Resolves "starting from Steve Seaver's sign date" against synced records.
 * Pure ranking over a bounded search; the owner confirms the pick at review.
 * Only titles/authors are searched (never message bodies), and only the
 * owner's own rows. Nothing here is authoritative until approved.
 */

export interface AnchorCandidate {
  date: string; // YYYY-MM-DD
  label: string; // "Stripe invoice paid (INV-0012)"
  provider: string;
  resource_type: string;
  /** Higher = better fit for the anchor's event kind. */
  score: number;
}

export interface AnchorResolution {
  best: AnchorCandidate | null;
  candidates: AnchorCandidate[];
}

interface Row {
  provider: string;
  resource_type: string;
  title: string | null;
  author: string | null;
  source_timestamp: string | null;
  metadata: Record<string, unknown>;
}

const SEARCH_TYPES = ["invoice", "charge", "customer", "opportunity", "contact", "client", "email", "event"];
const CONTRACT_WORDS = /\b(contract|agreement|proposal|sign|signed|signature|docusign|pandadoc|onboarding)\b/i;

const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const day = (iso: string | null) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toISOString().slice(0, 10) : null);

function scoreFor(event: TimeframeAnchor["event"], kind: string): number {
  const table: Record<string, Record<string, number>> = {
    signed: { contract_email: 5, opportunity_won: 4, client_created: 3, invoice_paid: 2, contact_created: 1, customer_created: 1, appointment: 1 },
    first_payment: { invoice_paid: 5, charge: 4, customer_created: 2, client_created: 1 },
    created: { client_created: 5, contact_created: 3, customer_created: 2, opportunity_won: 1 },
    custom: { contract_email: 3, opportunity_won: 3, client_created: 3, invoice_paid: 2, contact_created: 1, customer_created: 1, appointment: 1 },
  };
  return table[event]?.[kind] ?? 0;
}

/** Turns matching rows into dated candidates. Exported for tests. */
export function rankAnchorCandidates(rows: Row[], anchor: TimeframeAnchor): AnchorResolution {
  const out: AnchorCandidate[] = [];
  const push = (kind: string, date: string | null, label: string, r: Row) => {
    if (!date) return;
    out.push({ date, label, provider: r.provider, resource_type: r.resource_type, score: scoreFor(anchor.event, kind) });
  };
  for (const r of rows) {
    const m = r.metadata ?? {};
    const title = r.title ?? "";
    if (r.provider === "portal" && r.resource_type === "client") {
      push("client_created", day(str(m.created_at)), `Client Portal account created (${title})`, r);
    } else if (r.provider === "highlevel" && r.resource_type === "opportunity") {
      const status = String(m.status ?? "").toLowerCase();
      if (status === "won") push("opportunity_won", day(str(m.lastStatusChangeAt)) ?? day(r.source_timestamp), `HighLevel opportunity won (${title})`, r);
    } else if (r.provider === "highlevel" && r.resource_type === "contact") {
      push("contact_created", day(str(m.dateAdded)) ?? day(r.source_timestamp), `HighLevel contact created (${title})`, r);
    } else if (r.provider === "highlevel" && r.resource_type === "event") {
      push("appointment", day(r.source_timestamp), `HighLevel appointment (${title})`, r);
    } else if (r.provider === "stripe" && r.resource_type === "invoice") {
      if (m.paid === true || String(m.status ?? "") === "paid") push("invoice_paid", day(r.source_timestamp), `Stripe invoice paid (${str(m.number) ?? title})`, r);
    } else if (r.provider === "stripe" && r.resource_type === "charge") {
      if (m.paid !== false) push("charge", day(r.source_timestamp), `Stripe payment (${title})`, r);
    } else if (r.provider === "stripe" && r.resource_type === "customer") {
      push("customer_created", day(r.source_timestamp), `Stripe customer created (${title})`, r);
    } else if (r.provider === "google" && r.resource_type === "email") {
      if (CONTRACT_WORDS.test(title)) push("contract_email", day(r.source_timestamp), `Email: ${title.slice(0, 60)}`, r);
    } else if (r.provider === "google" && r.resource_type === "event") {
      push("appointment", day(r.source_timestamp), `Calendar: ${title.slice(0, 60)}`, r);
    }
  }
  // Best = highest score, then earliest date; candidates deduplicated by date+label, sorted by date.
  const seen = new Set<string>();
  const candidates = out
    .filter((c) => c.score > 0)
    .filter((c) => {
      const k = `${c.date}|${c.label}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  const best = [...candidates].sort((a, b) => b.score - a.score || a.date.localeCompare(b.date))[0] ?? null;
  return { best, candidates: candidates.slice(0, 8) };
}

export async function resolveAnchor(ownerId: string, anchor: TimeframeAnchor): Promise<AnchorResolution> {
  const admin = createAdminClient();
  const terms = anchor.search_terms.map((t) => t.replace(/[%_,()"\\]/g, " ").replace(/\s+/g, " ").trim()).filter((t) => t.length >= 3);
  if (!terms.length) return { best: null, candidates: [] };
  // PostgREST or() filter; values are double-quoted so spaces survive.
  const or = terms.flatMap((t) => [`title.ilike."%${t}%"`, `author.ilike."%${t}%"`]).join(",");
  const { data, error } = await admin
    .from("source_items")
    .select("provider, resource_type, title, author, source_timestamp, metadata")
    .eq("owner_id", ownerId)
    .eq("is_sample", false)
    .in("resource_type", SEARCH_TYPES)
    .or(or)
    .order("source_timestamp", { ascending: false })
    .limit(120);
  if (error) throw new Error(`anchor_search_failed:${error.code ?? ""}`);
  return rankAnchorCandidates((data ?? []) as Row[], anchor);
}
