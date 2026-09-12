import Stripe from "stripe";
import { after } from "next/server";
import { syncFromWebhook } from "@/lib/integrations/sync/webhook-trigger";
import { apiError, json } from "@/lib/api";
import { audit } from "@/lib/audit";
import { hasEnv, requireEnv } from "@/lib/env";
import { log } from "@/lib/security/log";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
  // Follow-through: pull the changed objects after the response is sent (bounded, never affects the reply).
  after(() => syncFromWebhook("stripe"));
  return json({ received: true });
}
