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

/** Consonant skeleton so "Seaver" ≈ "Seever" ≈ "Sever". */
function skeleton(word: string): string {
  return word.toLowerCase().replace(/[^a-z]/g, "").replace(/[aeiouy]/g, "").replace(/(.)\1+/g, "$1");
}

/**
 * How well a record names the person: full name 10, surname (fuzzy) 6, first
 * name alone 1, nothing 0. Search terms are [full name, surname, first name]
 * as the pre-parser emits them; a single term is treated as the full name.
 */
export function nameMatchScore(r: Row, terms: string[]): number {
  const hay = `${r.title ?? ""} ${r.author ?? ""}`.toLowerCase();
  if (!terms.length) return 0;
  const full = terms[0]!.toLowerCase();
  if (hay.includes(full)) return 10;
  const words = hay.split(/[^a-z0-9]+/).filter(Boolean);
  const nameWords = full.split(/\s+/).filter(Boolean);
  const surname = nameWords.length > 1 ? nameWords[nameWords.length - 1]! : null;
  if (surname && surname.length >= 3) {
    const sk = skeleton(surname);
    if (sk.length >= 2 && words.some((w) => w === surname || skeleton(w) === sk)) return 6;
    // Emails name people through their address: steve@seaverbaths.com, s.seever@gmail.com
    const addresses = (Array.isArray(r.metadata?.to) ? (r.metadata.to as unknown[]) : []).filter((a): a is string => typeof a === "string").map((a) => a.toLowerCase());
    if (addresses.some((a) => a.includes(surname))) return 6;
    if (addresses.some((a) => skeleton(a.split("@")[0] ?? "").includes(sk) || skeleton(a.split("@")[1] ?? "").startsWith(sk))) return 4;
  }
  const first = nameWords[0]!;
  return words.includes(first) ? 1 : 0;
}

/** Turns matching rows into dated candidates. Exported for tests. */
export function rankAnchorCandidates(rows: Row[], anchor: TimeframeAnchor): AnchorResolution {
  const out: (AnchorCandidate & { name: number })[] = [];
  const push = (kind: string, date: string | null, label: string, r: Row) => {
    if (!date) return;
    const name = nameMatchScore(r, anchor.search_terms);
    if (!name) return;
    out.push({ date, label, provider: r.provider, resource_type: r.resource_type, score: scoreFor(anchor.event, kind), name });
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
  // A first-name-only hit ("Steve Davlin" for "Steve Seaver") is only offered when nothing names the person better.
  const bestName = Math.max(0, ...out.map((c) => c.name));
  const seen = new Set<string>();
  const candidates = out
    .filter((c) => c.score > 0 && (c.name >= 6 || bestName < 6))
    .filter((c) => {
      const k = `${c.date}|${c.label}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  // Best = names the person best, then fits the kind of moment best, then earliest.
  const top = [...candidates].sort((a, b) => b.name - a.name || b.score - a.score || a.date.localeCompare(b.date))[0];
  const strip = (c: AnchorCandidate & { name: number }): AnchorCandidate => ({ date: c.date, label: c.label, provider: c.provider, resource_type: c.resource_type, score: c.score });
  return { best: top ? strip(top) : null, candidates: candidates.slice(0, 8).map(strip) };
}

export async function resolveAnchor(ownerId: string, anchor: TimeframeAnchor): Promise<AnchorResolution> {
  const admin = createAdminClient();
  const terms = anchor.search_terms.map((t) => t.replace(/[%_,()"\\]/g, " ").replace(/\s+/g, " ").trim()).filter((t) => t.length >= 3);
  if (!terms.length) return { best: null, candidates: [] };
  // PostgREST or() filter; values are double-quoted so spaces survive.
  // Emails are usually addressed to the person rather than titled after them, so recipients are searched too.
  const or = terms.flatMap((t) => [`title.ilike."%${t}%"`, `author.ilike."%${t}%"`, `metadata->>to.ilike."%${t}%"`]).join(",");
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
