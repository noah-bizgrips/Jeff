/**
 * Central environment access. Values are read lazily so that build-time
 * evaluation never fails on missing secrets, and so nothing here can be
 * accidentally inlined into the client bundle (no NEXT_PUBLIC_ prefix on
 * anything sensitive).
 *
 * Never log the return values of these helpers.
 */

export const DEFAULT_OWNER_EMAIL = "noah@bizgrips.com";

export function publicEnv() {
  return {
    appUrl: process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000"),
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    supabasePublishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
  };
}

export function ownerIdentity() {
  return {
    email: (process.env.OWNER_EMAIL ?? DEFAULT_OWNER_EMAIL).trim().toLowerCase(),
    userId: (process.env.OWNER_USER_ID ?? "").trim(),
  };
}

export function appMode(): "demo" | "live" {
  return process.env.JEFF_MODE === "live" ? "live" : "demo";
}

export function isProduction() {
  return process.env.NODE_ENV === "production";
}

/** True when the variable exists and is non-empty. Never returns the value. */
export function hasEnv(name: string): boolean {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0;
}

/** Read a server secret. Throws a value-free error when missing. */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}
