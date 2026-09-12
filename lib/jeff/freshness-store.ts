import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeFreshness, type FreshnessConnection, type FreshnessRun, type ProviderFreshness } from "./freshness";

export async function loadFreshness(ownerId: string, now = new Date()): Promise<ProviderFreshness[]> {
  const admin = createAdminClient();
  const [conns, runs] = await Promise.all([
    admin.from("connections").select("id, provider, display_name, status, last_sync_at, last_error").eq("owner_id", ownerId).in("status", ["connected", "limited", "reconnect_required", "error", "paused"]),
    admin.from("sync_runs").select("connection_id, provider, status, started_at, finished_at, created_at, error").eq("owner_id", ownerId).order("created_at", { ascending: false }).limit(200),
  ]);
  return computeFreshness((conns.data ?? []) as FreshnessConnection[], (runs.data ?? []) as FreshnessRun[], now);
}
