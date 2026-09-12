import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildClientMap, type ClientMapEntry, type MapSourceRow } from "./map-core";

export type { ClientMapEntry } from "./map-core";
export { buildClientMap, resolveClient, isPublicMailboxDomain } from "./map-core";

/**
 * Rebuilds public.client_map for the owner from synced source_items. Runs
 * after each portal sync (and after Stripe/HighLevel syncs so derived ids
 * stay current). Derived data only; safe to rebuild at any time.
 */
export async function rebuildClientMap(ownerId: string): Promise<{ clients: number; withStripe: number; withHighLevel: number }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("source_items")
    .select("provider, resource_type, external_id, title, metadata")
    .eq("owner_id", ownerId)
    .eq("is_sample", false)
    .or("and(provider.eq.portal,resource_type.in.(client,client_user,lead_source,lead)),and(provider.eq.stripe,resource_type.eq.customer),and(provider.eq.highlevel,resource_type.eq.contact)")
    .limit(10_000);
  if (error) throw new Error(`client_map_rows_failed:${error.code ?? ""}`);
  const entries = buildClientMap((data ?? []) as MapSourceRow[]);
  if (entries.length) {
    const rows = entries.map((e) => ({ owner_id: ownerId, ...e, updated_at: new Date().toISOString() }));
    const { error: upErr } = await admin.from("client_map").upsert(rows, { onConflict: "owner_id,portal_client_id" });
    if (upErr) throw new Error(`client_map_upsert_failed:${upErr.code ?? ""}`);
    // Drop clients that no longer exist in the portal export.
    const keep = entries.map((e) => e.portal_client_id);
    await admin.from("client_map").delete().eq("owner_id", ownerId).not("portal_client_id", "in", `(${keep.map((k) => `"${k}"`).join(",")})`);
  }
  return {
    clients: entries.length,
    withStripe: entries.filter((e) => e.stripe_customer_ids.length).length,
    withHighLevel: entries.filter((e) => e.highlevel_contact_ids.length).length,
  };
}

export async function loadClientMap(ownerId: string): Promise<ClientMapEntry[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("client_map")
    .select("portal_client_id, name, slug, status, ghl_contact_id, meta_page_ids, meta_form_ids, email_hashes, email_domains, stripe_customer_ids, highlevel_contact_ids")
    .eq("owner_id", ownerId)
    .order("name");
  if (error) throw new Error(`client_map_load_failed:${error.code ?? ""}`);
  return (data ?? []) as ClientMapEntry[];
}
