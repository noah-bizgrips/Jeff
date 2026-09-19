import { createHash } from "node:crypto";

/**
 * Client leads — people who came in through a client-portal client's lead
 * sources (a homeowner wanting a bathroom) as opposed to agency leads (people
 * who might hire BizGrips). Following up with a client lead is the client's
 * job, so Jeff must not nag the owner about it.
 *
 * Pure and deterministic. A lead is a client lead ONLY when it is traceable to
 * a portal client record:
 *   - every portal `lead` row is a client lead;
 *   - a HighLevel contact whose id equals a portal lead's `ghl_contact_id`,
 *     whose `email_hash` equals a portal lead's, whose `phone_last4` matches a
 *     portal lead of the same client (the row must carry that client_id), or
 *     whose `source` / tags equal a portal `lead_source` routing key;
 *   - HighLevel opportunities / conversations / events whose `contactId` (or
 *     `id`) resolves to such a contact;
 *   - Gmail rows whose sender address hashes to a portal lead's `email_hash`.
 *
 * The connected HighLevel location is primarily agency leads, so the location
 * itself is never a signal, and a portal client's OWN contact (the client as a
 * BizGrips customer) is explicitly never treated as a lead.
 */

export interface ClientLeadRow {
  provider: string;
  resource_type: string;
  external_id: string;
  author?: string | null;
  tags?: string[] | null;
  metadata: Record<string, unknown>;
}

export type ClientLeadVia = "portal_lead" | "ghl_contact_id" | "email_hash" | "phone_last4" | "lead_source";

export interface ClientLeadMatch {
  client_id: string | null;
  via: ClientLeadVia;
}

const s = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);

function last4(v: unknown): string | null {
  const digits = (s(v) ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function senderAddress(author: string | null | undefined): string | null {
  if (!author) return null;
  const m = author.match(/<([^>]+)>/);
  const addr = (m ? m[1]! : author).trim().toLowerCase();
  return addr.includes("@") ? addr : null;
}

export function emailHash(address: string): string {
  return createHash("sha256").update(address.trim().toLowerCase(), "utf8").digest("hex");
}

export class ClientLeadIndex {
  private readonly ghlIds = new Map<string, ClientLeadMatch>();
  private readonly emailHashes = new Map<string, ClientLeadMatch>();
  private readonly phoneByClient = new Map<string, ClientLeadMatch>();
  private readonly routingKeys = new Map<string, ClientLeadMatch>();
  /** Portal clients' own HighLevel contact ids — the client, never a lead. */
  private readonly clientContactIds = new Set<string>();
  private readonly hashCache = new Map<string, string>();
  private leads = 0;

  static from(rows: ClientLeadRow[]): ClientLeadIndex {
    const idx = new ClientLeadIndex();
    for (const r of rows) {
      if (r.provider !== "portal") continue;
      if (r.resource_type === "client") {
        const own = s(r.metadata.ghl_contact_id);
        if (own) idx.clientContactIds.add(own);
      } else if (r.resource_type === "lead_source") {
        const cid = s(r.metadata.client_id);
        for (const key of [s(r.metadata.routing_key), s(r.metadata.meta_form_id)]) {
          if (key) idx.routingKeys.set(key.toLowerCase(), { client_id: cid, via: "lead_source" });
        }
      }
    }
    for (const r of rows) {
      if (r.provider !== "portal" || r.resource_type !== "lead") continue;
      idx.leads++;
      const cid = s(r.metadata.client_id);
      const ghl = s(r.metadata.ghl_contact_id);
      if (ghl && !idx.clientContactIds.has(ghl)) idx.ghlIds.set(ghl, { client_id: cid, via: "ghl_contact_id" });
      const hash = s(r.metadata.email_hash);
      if (hash) idx.emailHashes.set(hash.toLowerCase(), { client_id: cid, via: "email_hash" });
      const phone = last4(r.metadata.phone_last4);
      if (phone && cid) idx.phoneByClient.set(`${cid}:${phone}`, { client_id: cid, via: "phone_last4" });
    }
    // Second pass: HighLevel contacts that resolve to a lead by hash / phone / routing key
    // make their own contact id a lead id, so opportunities and conversations follow.
    for (const r of rows) {
      if (r.provider !== "highlevel" || r.resource_type !== "contact") continue;
      if (idx.ghlIds.has(r.external_id) || idx.clientContactIds.has(r.external_id)) continue;
      const hit = idx.matchContactFields(r);
      if (hit) idx.ghlIds.set(r.external_id, hit);
    }
    return idx;
  }

  /** Number of portal lead rows the index was built from. */
  get size(): number {
    return this.leads;
  }

  get empty(): boolean {
    return this.leads === 0 && this.routingKeys.size === 0;
  }

  private matchContactFields(r: ClientLeadRow): ClientLeadMatch | null {
    const hash = s(r.metadata.email_hash);
    if (hash) {
      const hit = this.emailHashes.get(hash.toLowerCase());
      if (hit) return hit;
    }
    const cid = s(r.metadata.client_id);
    const phone = last4(r.metadata.phone_last4) ?? last4(r.metadata.phone);
    if (cid && phone) {
      const hit = this.phoneByClient.get(`${cid}:${phone}`);
      if (hit) return hit;
    }
    if (this.routingKeys.size) {
      const keys = [s(r.metadata.source), s(r.metadata.form_id), s(r.metadata.meta_form_id), ...(r.tags ?? []), ...(Array.isArray(r.metadata.tags) ? (r.metadata.tags as unknown[]).map(s) : [])];
      for (const k of keys) {
        if (!k) continue;
        const hit = this.routingKeys.get(k.toLowerCase());
        if (hit) return hit;
      }
    }
    return null;
  }

  /** Returns how the row traces back to a client-portal lead, or null. */
  match(r: ClientLeadRow): ClientLeadMatch | null {
    if (r.provider === "portal") return r.resource_type === "lead" ? { client_id: s(r.metadata.client_id), via: "portal_lead" } : null;
    if (this.empty) return null;
    if (r.provider === "highlevel") {
      const contactId = r.resource_type === "contact" ? r.external_id : (s(r.metadata.contactId) ?? s(r.metadata.contact_id));
      if (contactId) {
        if (this.clientContactIds.has(contactId)) return null;
        const hit = this.ghlIds.get(contactId);
        if (hit) return hit;
      }
      return this.matchContactFields(r);
    }
    if (r.resource_type === "email" || r.resource_type === "message") {
      const hash = s(r.metadata.email_hash);
      if (hash) {
        const hit = this.emailHashes.get(hash.toLowerCase());
        if (hit) return hit;
      }
      if (!this.emailHashes.size) return null;
      const addr = senderAddress(r.author);
      if (!addr) return null;
      let h = this.hashCache.get(addr);
      if (!h) {
        h = emailHash(addr);
        this.hashCache.set(addr, h);
      }
      return this.emailHashes.get(h) ?? null;
    }
    return null;
  }

  isClientLead(r: ClientLeadRow): boolean {
    return this.match(r) !== null;
  }
}

/** Convenience for callers holding an index. Without an index only portal lead rows count. */
export function isClientLead(row: ClientLeadRow, index?: ClientLeadIndex | null): boolean {
  if (index) return index.isClientLead(row);
  return row.provider === "portal" && row.resource_type === "lead";
}
