import Stripe from "stripe";
import { apiError, json } from "@/lib/api";
import { audit } from "@/lib/audit";
import { hasEnv, requireEnv } from "@/lib/env";
import { log } from "@/lib/security/log";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/stripe — signature verified with STRIPE_WEBHOOK_SECRET.
 * Public endpoint (no session), so it does nothing but record the event type
 * for later processing. Payloads are not stored.
 */
export async function POST(req: Request) {
  if (!hasEnv("STRIPE_WEBHOOK_SECRET")) return apiError("webhook_not_configured", 503);
  const sig = req.headers.get("stripe-signature");
  if (!sig) {
    await audit({ event: "webhook_rejected", actor: "webhook", provider: "stripe", metadata: { reason: "missing_signature" } });
    return apiError("missing_signature", 400);
  }
  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = await Stripe.webhooks.constructEventAsync(raw, sig, requireEnv("STRIPE_WEBHOOK_SECRET"));
  } catch {
    await audit({ event: "webhook_rejected", actor: "webhook", provider: "stripe", metadata: { reason: "bad_signature" } });
    return apiError("invalid_signature", 400);
  }
  log.info("stripe_webhook", { type: event.type, id: event.id });
  await audit({ event: "webhook_received", actor: "webhook", provider: "stripe", targetId: event.id, metadata: { type: event.type } });
  return json({ received: true });
}
