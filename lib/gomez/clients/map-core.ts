/**
 * Pure client-map construction and resolution (no I/O, unit-testable).
 *
 * Join keys, in order of trust:
 *   portal client id (source of truth)
 *   → Meta page / form ids from portal lead_sources
 *   → GHL contact id from the portal client record
 *   → hashed emails / domains from portal users and leads
 *   → Stripe customers by email hash, or by a NON-public email domain
 *   → HighLevel contacts by ghl contact id or email hash
 */

export interface MapSourceRow {
  provider: string;
  resource_type: string;
  external_id: string;
  title: string | null;
  metadata: Record<string, unknown>;
}

export interface ClientMapEntry {
  portal_client_id: string;
  name: string;
  slug: string | null;
  status: string | null;
  ghl_contact_id: string | null;
  meta_page_ids: string[];
  meta_form_ids: string[];
  email_hashes: string[];
  email_domains: string[];
  stripe_customer_ids: string[];
  highlevel_contact_ids: string[];
}

/** Domains many unrelated people share — never a client signal on their own. */
export const PUBLIC_MAILBOX_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "icloud.com",
  "aol.com",
  "live.com",
  "me.com",
  "msn.com",
  "protonmail.com",
  "proton.me",
  "mail.com",
  "ymail.com",
  "comcast.net",
  "att.net",
  "verizon.net",
]);

export function isPublicMailboxDomain(domain: string | null | undefined): boolean {
  return !domain || PUBLIC_MAILBOX_DOMAINS.has(domain.toLowerCase());
}

const s = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);
const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];

export function buildClientMap(rows: MapSourceRow[]): ClientMapEntry[] {
  const clients = new Map<string, ClientMapEntry>();
  for (const r of rows) {
    if (r.provider !== "portal" || r.resource_type !== "client") continue;
    const id = s(r.metadata.client_id) ?? r.external_id;
    clients.set(id, {
      portal_client_id: id,
      name: r.title ?? `Client ${id}`,
      slug: s(r.metadata.slug),
      status: s(r.metadata.status),
      ghl_contact_id: s(r.metadata.ghl_contact_id),
      meta_page_ids: [],
      meta_form_ids: [],
      email_hashes: [],
      email_domains: [],
      stripe_customer_ids: [],
      highlevel_contact_ids: [],
    });
  }
  if (!clients.size) return [];

  for (const r of rows) {
    if (r.provider !== "portal") continue;
    const cid = s(r.metadata.client_id);
    const c = cid ? clients.get(cid) : undefined;
    if (!c) continue;
    if (r.resource_type === "lead_source") {
      const type = s(r.metadata.source_type);
      const key = s(r.metadata.routing_key);
      if (type === "meta_page" && key) c.meta_page_ids.push(key);
      if (type === "meta_form" && (key || s(r.metadata.meta_form_id))) c.meta_form_ids.push((key ?? s(r.metadata.meta_form_id))!);
      if (s(r.metadata.meta_form_id)) c.meta_form_ids.push(s(r.metadata.meta_form_id)!);
    } else if (r.resource_type === "client_user") {
      c.email_hashes.push(s(r.metadata.email_hash) ?? "");
      c.email_domains.push(s(r.metadata.email_domain) ?? "");
    }
    // Leads are the client's *customers*, not the client — they must not
    // feed the client's own email identity (a homeowner's gmail is not the
    // bath company).
  }

  for (const c of clients.values()) {
    c.meta_page_ids = uniq(c.meta_page_ids);
    c.meta_form_ids = uniq(c.meta_form_ids);
    c.email_hashes = uniq(c.email_hashes);
    c.email_domains = uniq(c.email_domains).filter((d) => !isPublicMailboxDomain(d));
  }

  const hashIndex = new Map<string, ClientMapEntry>();
  const domainIndex = new Map<string, ClientMapEntry[]>();
  const ghlIndex = new Map<string, ClientMapEntry>();
  for (const c of clients.values()) {
    for (const h of c.email_hashes) hashIndex.set(h, c);
    for (const d of c.email_domains) domainIndex.set(d, [...(domainIndex.get(d) ?? []), c]);
    if (c.ghl_contact_id) ghlIndex.set(c.ghl_contact_id, c);
  }

  for (const r of rows) {
    if (r.provider === "stripe" && r.resource_type === "customer") {
      const h = s(r.metadata.email_hash);
      const d = s(r.metadata.email_domain);
      const byHash = h ? hashIndex.get(h) : undefined;
      // Domain match only when exactly one client owns that (non-public) domain.
      const byDomain = !byHash && d && !isPublicMailboxDomain(d) ? domainIndex.get(d) : undefined;
      const hit = byHash ?? (byDomain && byDomain.length === 1 ? byDomain[0] : undefined);
      if (hit) hit.stripe_customer_ids.push(r.external_id);
    } else if (r.provider === "highlevel" && r.resource_type === "contact") {
      const h = s(r.metadata.email_hash);
      const hit = ghlIndex.get(r.external_id) ?? (h ? hashIndex.get(h) : undefined);
      if (hit) hit.highlevel_contact_ids.push(r.external_id);
    }
  }
  for (const c of clients.values()) {
    c.stripe_customer_ids = uniq(c.stripe_customer_ids);
    c.highlevel_contact_ids = uniq(c.highlevel_contact_ids);
  }
  return [...clients.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface ResolveQuery {
  pageId?: string | null;
  formId?: string | null;
  emailHash?: string | null;
  emailDomain?: string | null;
  ghlContactId?: string | null;
  stripeCustomerId?: string | null;
  clientId?: string | null;
}

/** Deterministic lookup; strongest key first. Domain matches require a unique, non-public domain. */
export function resolveClient(map: ClientMapEntry[], q: ResolveQuery): ClientMapEntry | null {
  if (q.clientId) {
    const hit = map.find((c) => c.portal_client_id === q.clientId);
    if (hit) return hit;
  }
  if (q.pageId) {
    const hit = map.find((c) => c.meta_page_ids.includes(q.pageId!));
    if (hit) return hit;
  }
  if (q.formId) {
    const hit = map.find((c) => c.meta_form_ids.includes(q.formId!));
    if (hit) return hit;
  }
  if (q.stripeCustomerId) {
    const hit = map.find((c) => c.stripe_customer_ids.includes(q.stripeCustomerId!));
    if (hit) return hit;
  }
  if (q.ghlContactId) {
    const hit = map.find((c) => c.ghl_contact_id === q.ghlContactId || c.highlevel_contact_ids.includes(q.ghlContactId!));
    if (hit) return hit;
  }
  if (q.emailHash) {
    const hit = map.find((c) => c.email_hashes.includes(q.emailHash!));
    if (hit) return hit;
  }
  if (q.emailDomain && !isPublicMailboxDomain(q.emailDomain)) {
    const hits = map.filter((c) => c.email_domains.includes(q.emailDomain!.toLowerCase()));
    if (hits.length === 1) return hits[0]!;
  }
  return null;
}
