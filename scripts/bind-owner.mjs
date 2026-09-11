#!/usr/bin/env node
/**
 * One-time owner bootstrap for local/dev use:
 *   npm run owner:bind        (loads .env.local via node --env-file)
 *
 * Reads OWNER_USER_ID / OWNER_EMAIL / SUPABASE_SECRET_KEY from the environment
 * and upserts public.app_owner. Prints nothing sensitive.
 * In production, sign in and POST /api/admin/bind-owner instead.
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const userId = (process.env.OWNER_USER_ID ?? "").trim();
const email = (process.env.OWNER_EMAIL ?? "noah@bizgrips.com").trim().toLowerCase();

for (const [name, v] of [["NEXT_PUBLIC_SUPABASE_URL", url], ["SUPABASE_SECRET_KEY", secret], ["OWNER_USER_ID", userId]]) {
  if (!v) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
}

const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: user, error: userErr } = await admin.auth.admin.getUserById(userId);
if (userErr || !user?.user) {
  console.error("OWNER_USER_ID does not match an auth user.");
  process.exit(1);
}
if ((user.user.email ?? "").toLowerCase() !== email) {
  console.error("OWNER_USER_ID's email does not match OWNER_EMAIL.");
  process.exit(1);
}
const { error } = await admin.from("app_owner").upsert({ id: 1, user_id: userId, email }, { onConflict: "id" });
if (error) {
  console.error("Bind failed:", error.code ?? error.message);
  process.exit(1);
}
console.error("app_owner bound to the configured owner.");
