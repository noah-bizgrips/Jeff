import "server-only";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { publicEnv, requireEnv } from "@/lib/env";

/**
 * Service-role client. Bypasses RLS. Server-only, and only for code paths
 * that have ALREADY verified the owner + aal2 (or trusted webhooks).
 *
 * The secret key never leaves this module; do not return the client to the UI.
 */
export function createAdminClient(): SupabaseClient {
  const { supabaseUrl } = publicEnv();
  return createSupabaseClient(supabaseUrl, requireEnv("SUPABASE_SECRET_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
