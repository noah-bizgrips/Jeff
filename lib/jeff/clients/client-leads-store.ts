import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ClientLeadIndex, type ClientLeadRow } from "./client-leads";

/**
 * Loads just the rows the client-lead index needs (portal clients, leads,
 * lead sources and HighLevel contacts) — cheaper than a full monitor row load
 * when only rule evaluation needs the index.
 */
export async function loadClientLeadIndex(ownerId: string): Promise<ClientLeadIndex> {
  const admin = createAdminClient();
  const rows: ClientLeadRow[] = [];
  const { data: portal } = await admin
    .from("source_items")
    .select("provider, resource_type, external_id, author, tags, metadata")
    .eq("owner_id", ownerId)
    .eq("is_sample", false)
    .eq("provider", "portal")
    .in("resource_type", ["client", "lead", "lead_source"])
    .limit(5000);
  rows.push(...((portal ?? []) as ClientLeadRow[]));
  const { data: contacts } = await admin
    .from("source_items")
    .select("provider, resource_type, external_id, author, tags, metadata")
    .eq("owner_id", ownerId)
    .eq("is_sample", false)
    .eq("provider", "highlevel")
    .eq("resource_type", "contact")
    .limit(5000);
  rows.push(...((contacts ?? []) as ClientLeadRow[]));
  return ClientLeadIndex.from(rows);
}
