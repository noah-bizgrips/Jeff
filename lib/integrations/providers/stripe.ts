import "server-only";
import Stripe from "stripe";
import type { TestResult } from "./base";
import type { SecretBundle } from "@/lib/integrations/store";

/**
 * Stripe: read-only reporting through a RESTRICTED key supplied once via the
 * protected form. Jeff refuses secret keys (sk_) outright.
 */
export interface StripeSecret extends SecretBundle {
  kind: "api_key";
  restricted_key: string;
}

export function isRestrictedKey(value: string): boolean {
  return /^rk_(live|test)_[A-Za-z0-9]{16,}$/.test(value);
}

export function stripeClient(secret: StripeSecret): Stripe {
  return new Stripe(secret.restricted_key, { timeout: 10000, maxNetworkRetries: 1 });
}

/** Harmless read: list one customer. Never charges, never writes. */
export async function testStripe(secret: SecretBundle): Promise<TestResult> {
  const s = secret as StripeSecret;
  if (!isRestrictedKey(s.restricted_key)) return { ok: false, error: "not_a_restricted_key" };
  const stripe = stripeClient(s);
  const checks: Record<string, boolean> = {};
  const probes: [string, () => Promise<unknown>][] = [
    ["customers", () => stripe.customers.list({ limit: 1 })],
    ["charges", () => stripe.charges.list({ limit: 1 })],
    ["invoices", () => stripe.invoices.list({ limit: 1 })],
    ["subscriptions", () => stripe.subscriptions.list({ limit: 1 })],
    ["products", () => stripe.products.list({ limit: 1 })],
    ["balance", () => stripe.balance.retrieve()],
  ];
  for (const [name, fn] of probes) {
    try {
      await fn();
      checks[name] = true;
    } catch {
      checks[name] = false;
    }
  }
  const passed = Object.values(checks).filter(Boolean).length;
  if (passed === 0) return { ok: false, error: "stripe_all_probes_failed", details: checks };
  let accountIdentifier: string | null = null;
  try {
    const acct = await stripe.accounts.retrieve(null);
    accountIdentifier = acct.settings?.dashboard?.display_name ?? acct.id ?? null;
  } catch {
    accountIdentifier = s.restricted_key.startsWith("rk_live_") ? "Stripe live (restricted)" : "Stripe test (restricted)";
  }
  return { ok: true, limited: passed < probes.length, accountIdentifier, details: checks };
}
