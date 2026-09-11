"use client";
import { createBrowserClient } from "@supabase/ssr";
import { publicEnv } from "@/lib/env";

/**
 * Browser Supabase client. Uses only the publishable key, which is safe to
 * ship to the client. RLS is the security boundary for anything it touches.
 */
export function createClient() {
  const { supabaseUrl, supabasePublishableKey } = publicEnv();
  return createBrowserClient(supabaseUrl, supabasePublishableKey);
}
