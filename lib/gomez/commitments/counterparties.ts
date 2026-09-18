import { bareAddress } from "@/lib/gomez/rules/engine";
import { emailHash } from "@/lib/gomez/clients/client-leads";
import type { SourceRow } from "@/lib/gomez/monitors/types";

/**
 * Known counterparties — people Gomez has a relationship record for. A promise
 * owed TO the owner only counts when the sender is one of these; a stranger
 * (or a marketing list that slipped through) promising "we'll get back to you
 * tomorrow" is not a commitment anyone is tracking.
 *
 * Sources, all from synced rows (pure):
 *   - HighLevel contacts (email_hash) and any HighLevel conversation (contactId);
 *   - portal client users and leads (email_hash);
 *   - Google Calendar attendees (raw addresses);
 *   - Slack messages (workspace members by definition);
 *   - anyone the owner has written to (Gmail `to` on owner-authored mail) or
 *     any thread the owner has replied in.
 */

export interface KnownCounterparties {
  addresses: Set<string>;
  hashes: Set<string>;
  /** Thread keys (Gmail threadId) that contain an owner-authored message. */
  ownerThreads: Set<string>;
}

const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function knownCounterparties(rows: SourceRow[], ownAddresses: string[]): KnownCounterparties {
  const own = new Set(ownAddresses.map((a) => a.toLowerCase()));
  const addresses = new Set<string>();
  const hashes = new Set<string>();
  const ownerThreads = new Set<string>();
  for (const r of rows) {
    const m = r.metadata ?? {};
    if (r.provider === "highlevel" || r.provider === "portal") {
      const h = s(m.email_hash);
      if (h) hashes.add(h.toLowerCase());
      if (r.provider === "portal" && r.resource_type === "client" && Array.isArray(m.client_users)) {
        for (const u of m.client_users as { email_hash?: unknown }[]) {
          const uh = s(u?.email_hash);
          if (uh) hashes.add(uh.toLowerCase());
        }
      }
      continue;
    }
    if (r.provider === "google" && r.resource_type === "event" && Array.isArray(m.attendees)) {
      for (const a of m.attendees as unknown[]) {
        const addr = typeof a === "string" ? a.trim().toLowerCase() : s((a as { email?: unknown })?.email)?.toLowerCase();
        if (addr && addr.includes("@") && !own.has(addr)) addresses.add(addr);
      }
      continue;
    }
    if (r.provider === "google" && r.resource_type === "email") {
      const sender = bareAddress(r.author);
      if (sender && own.has(sender)) {
        const thread = s(m.threadId) ?? r.external_id;
        ownerThreads.add(thread);
        for (const to of Array.isArray(m.to) ? (m.to as unknown[]) : []) {
          const addr = s(to)?.toLowerCase();
          if (addr && addr.includes("@") && !own.has(addr)) addresses.add(addr);
        }
      }
    }
  }
  return { addresses, hashes, ownerThreads };
}

/** True when the row's sender is someone Gomez knows (see module doc). */
export function isKnownCounterparty(row: SourceRow, known: KnownCounterparties): boolean {
  // CRM conversations and Slack messages are with known people by construction.
  if (row.provider === "highlevel" || row.provider === "slack") return true;
  const m = row.metadata ?? {};
  const thread = s(m.threadId) ?? row.external_id;
  if (known.ownerThreads.has(thread)) return true;
  const sender = bareAddress(row.author);
  if (!sender) return false;
  if (known.addresses.has(sender)) return true;
  return known.hashes.size > 0 && known.hashes.has(emailHash(sender));
}
