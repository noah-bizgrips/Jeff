import { resolveClient, type ClientMapEntry } from "./map-core";

/** Pure attribution: which synced rows belong to which portal client. */
export interface AttributableRow {
  id: string;
  provider: string;
  resource_type: string;
  metadata: Record<string, unknown>;
}

const s = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);

export function attributeRows(rows: AttributableRow[], map: ClientMapEntry[]): { updates: { id: string; metadata: Record<string, unknown> }[]; unattributedAds: number } {
  const updates: { id: string; metadata: Record<string, unknown> }[] = [];
  let unattributedAds = 0;
  for (const r of rows) {
    let hit: ClientMapEntry | null = null;
    if (r.provider === "stripe") {
      // Customer rows carry their own (hashed) email; everything else points at a customer id.
      hit =
        r.resource_type === "customer"
          ? resolveClient(map, { emailHash: s(r.metadata.email_hash), emailDomain: s(r.metadata.email_domain) })
          : resolveClient(map, { stripeCustomerId: s(r.metadata.customerId) });
    } else if (r.provider === "highlevel") {
      const contactId = r.resource_type === "contact" ? null : s(r.metadata.contactId);
      hit = resolveClient(map, { ghlContactId: contactId, emailHash: s(r.metadata.email_hash) });
    } else if (r.provider === "meta") {
      // Ads insights are per ad account, not per page: attribute only via an explicit page id.
      const pageId = s(r.metadata.page_id);
      hit = pageId ? resolveClient(map, { pageId }) : null;
      if (!hit && (r.resource_type === "ad_insight" || r.resource_type === "campaign")) unattributedAds++;
    }
    const current = s(r.metadata.client_id);
    if (hit && current !== hit.portal_client_id) {
      updates.push({ id: r.id, metadata: { ...r.metadata, client_id: hit.portal_client_id, client_name: hit.name, attribution: r.provider === "meta" ? "meta_page" : r.provider === "stripe" ? (s(r.metadata.customerId) ? "stripe_customer" : "email") : "highlevel_contact" } });
    }
  }
  return { updates, unattributedAds };
}
