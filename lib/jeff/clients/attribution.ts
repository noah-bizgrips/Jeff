import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadClientMap } from "./map";
import { attributeRows, type AttributableRow } from "./attribution-core";

export { attributeRows } from "./attribution-core";

const BATCH = 2000;

/**
 * Stamps `metadata.client_id` (portal id) onto synced provider rows that can be
 * tied to a client. Bounded to BATCH rows per run; unmatched rows are left
 * untouched and the limitation is reported. Never touches portal rows (they
 * already carry client_id from the source of truth).
 */
export async function attributeSourceItems(ownerId: string): Promise<{ scanned: number; attributed: number; unattributed_ads: number }> {
  const map = await loadClientMap(ownerId);
  if (!map.length) return { scanned: 0, attributed: 0, unattributed_ads: 0 };
  const admin = createAdminClient();
  // Only rows not yet attributed (or whose attribution may have changed) within the batch.
  const { data, error } = await admin
    .from("source_items")
    .select("id, provider, resource_type, metadata")
    .eq("owner_id", ownerId)
    .eq("is_sample", false)
    .in("provider", ["stripe", "highlevel", "meta"])
    .in("resource_type", ["invoice", "charge", "subscription", "customer", "contact", "opportunity", "message", "ad_insight", "campaign", "page_insight", "post", "ig_insight", "ig_media"])
    .order("synced_at", { ascending: false })
    .limit(BATCH);
  if (error) throw new Error(`attribution_rows_failed:${error.code ?? ""}`);
  const rows = (data ?? []) as AttributableRow[];
  const { updates, unattributedAds } = attributeRows(rows, map);
  for (const u of updates) {
    const { error: upErr } = await admin.from("source_items").update({ metadata: u.metadata }).eq("id", u.id);
    if (upErr) throw new Error(`attribution_update_failed:${upErr.code ?? ""}`);
  }
  return { scanned: rows.length, attributed: updates.length, unattributed_ads: unattributedAds };
}
