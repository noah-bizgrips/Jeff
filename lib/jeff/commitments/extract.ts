import { createHash } from "node:crypto";
import { classifyCommitment } from "@/lib/jeff/monitors/commitment-classifier";
import { bareAddress } from "@/lib/jeff/rules/engine";
import type { SourceRow } from "@/lib/jeff/monitors/types";

/**
 * Commitment extraction (spec §35): pure. Scans human-authored emails and
 * CRM conversation items, extracts "actor will do X by Y", decides who owes
 * whom, and composes a context-rich reminder from linked CRM records.
 * Operating rules are applied by the caller before rows reach this function.
 */

export interface CommitmentCandidate {
  fingerprint: string;
  source_item_id: string;
  provider: string;
  actor: string | null;
  action_text: string;
  context_text: string;
  due_at: string | null;
  confidence: number;
  direction: "owed_by_me" | "owed_to_me";
  counterparty: string | null;
  source_url: string | null;
  observed_at: string;
}

export interface ExtractOptions {
  ownAddresses: string[];
  now: Date;
  lookbackDays?: number;
  minConfidence?: number;
}

function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function displayName(author: string | null): string | null {
  if (!author) return null;
  const m = author.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>/);
  if (m) return m[1]!.trim();
  const addr = bareAddress(author);
  if (addr) return addr.split("@")[0]!.replace(/[._]/g, " ");
  return author.trim() || null;
}

function moneyOf(v: unknown): string | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

/** Finds an opportunity (HighLevel) tied to the same contact for richer context. */
function linkedOpportunity(row: SourceRow, opportunities: SourceRow[]): SourceRow | null {
  const contactId = typeof row.metadata.contactId === "string" ? row.metadata.contactId : null;
  if (contactId) {
    const hit = opportunities.find((o) => o.metadata.contactId === contactId);
    if (hit) return hit;
  }
  const emailHash = typeof row.metadata.email_hash === "string" ? row.metadata.email_hash : null;
  if (emailHash) return opportunities.find((o) => o.metadata.email_hash === emailHash) ?? null;
  return null;
}

export function composeContext(row: SourceRow, opp: SourceRow | null, direction: "owed_by_me" | "owed_to_me", counterparty: string | null, now: Date): string {
  const days = row.source_timestamp ? Math.max(0, Math.round((now.getTime() - Date.parse(row.source_timestamp)) / 86_400_000)) : null;
  const ago = days == null ? "recently" : days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  if (opp) {
    const value = moneyOf(opp.metadata.monetaryValue);
    const stage = typeof opp.metadata.stage === "string" ? opp.metadata.stage : typeof opp.metadata.status === "string" ? opp.metadata.status : null;
    const who = counterparty ?? (opp.title ?? "the client");
    return `${who}'s ${value ? `${value} ` : ""}${stage ? `${stage.toLowerCase()} ` : ""}opportunity "${opp.title ?? "untitled"}" — last message ${ago}${direction === "owed_by_me" ? "; you said you would follow up" : `; ${who} promised a next step`}.`;
  }
  const subject = row.title ?? "the thread";
  return direction === "owed_by_me" ? `You promised this in "${subject}" ${ago}; no later reply from the other side is synced.` : `${counterparty ?? "They"} promised this in "${subject}" ${ago}; nothing further is synced.`;
}

export function extractCommitments(rows: SourceRow[], opts: ExtractOptions): CommitmentCandidate[] {
  const lookback = (opts.lookbackDays ?? 30) * 86_400_000;
  const minConf = opts.minConfidence ?? 0.45;
  const own = new Set(opts.ownAddresses.map((a) => a.toLowerCase()));
  const opportunities = rows.filter((r) => r.resource_type === "opportunity");
  const conversational = rows.filter((r) => (r.resource_type === "email" || r.resource_type === "message") && r.source_timestamp && opts.now.getTime() - Date.parse(r.source_timestamp) <= lookback);
  // Group by thread to detect replies.
  const byThread = new Map<string, SourceRow[]>();
  for (const r of conversational) {
    const t = typeof r.metadata.threadId === "string" ? r.metadata.threadId : typeof r.metadata.contactId === "string" ? `contact:${r.metadata.contactId}` : r.external_id;
    byThread.set(t, [...(byThread.get(t) ?? []), r]);
  }
  const out: CommitmentCandidate[] = [];
  const seen = new Set<string>();
  for (const msgs of byThread.values()) {
    const sorted = [...msgs].sort((a, b) => Date.parse(a.source_timestamp!) - Date.parse(b.source_timestamp!));
    for (const m of sorted) {
      const at = Date.parse(m.source_timestamp!);
      const sender = bareAddress(m.author);
      const repliedByOther = sorted.some((x) => Date.parse(x.source_timestamp!) > at && bareAddress(x.author) !== sender);
      const signal = classifyCommitment(m, { ownAddresses: [...own], repliedByOther });
      if (signal.sender_class !== "human" || !signal.sentence || signal.confidence < minConf) continue;
      const fromOwner = !!sender && own.has(sender);
      // HighLevel conversations: direction is stored as lastMessageDirection (outbound = owner side).
      const outbound = m.provider === "highlevel" && m.metadata.lastMessageDirection === "outbound";
      const direction: CommitmentCandidate["direction"] = fromOwner || outbound ? "owed_by_me" : "owed_to_me";
      const counterparty = direction === "owed_to_me" ? displayName(m.author) : (typeof m.metadata.contactName === "string" ? (m.metadata.contactName as string) : displayName(sorted.find((x) => bareAddress(x.author) !== sender)?.author ?? null));
      const fp = createHash("sha256").update(`${m.id}:${normalize(signal.sentence)}`).digest("hex").slice(0, 32);
      if (seen.has(fp)) continue;
      seen.add(fp);
      const opp = linkedOpportunity(m, opportunities);
      out.push({
        fingerprint: fp,
        source_item_id: m.id,
        provider: m.provider,
        actor: signal.actor,
        action_text: signal.sentence.slice(0, 300),
        context_text: composeContext(m, opp, direction, counterparty, opts.now),
        due_at: signal.due_date ? `${signal.due_date}T23:59:59.000Z` : null,
        confidence: signal.confidence,
        direction,
        counterparty,
        source_url: m.source_url,
        observed_at: m.source_timestamp!,
      });
    }
  }
  return out.sort((a, b) => (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999") || b.confidence - a.confidence);
}

export function isOverdue(c: { due_at: string | null; status: string }, now: Date): boolean {
  return !!c.due_at && ["open", "overdue"].includes(c.status) && Date.parse(c.due_at) < now.getTime();
}
