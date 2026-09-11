import { apiError, json } from "@/lib/api";
import { audit } from "@/lib/audit";
import { hasEnv } from "@/lib/env";
import { verifyPlaidWebhook } from "@/lib/integrations/providers/plaid";
import { log } from "@/lib/security/log";

export const dynamic = "force-dynamic";

/** POST /api/webhooks/plaid — verified via Plaid-Verification JWT. */
export async function POST(req: Request) {
  if (!hasEnv("PLAID_CLIENT_ID") || !hasEnv("PLAID_SECRET")) return apiError("webhook_not_configured", 503);
  const raw = await req.text();
  const ok = await verifyPlaidWebhook(raw, req.headers.get("plaid-verification")).catch(() => false);
  if (!ok) {
    await audit({ event: "webhook_rejected", actor: "webhook", provider: "plaid", metadata: { reason: "verification_failed" } });
    return apiError("invalid_signature", 400);
  }
  let payload: { webhook_type?: string; webhook_code?: string; item_id?: string } = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    return apiError("invalid_json", 400);
  }
  log.info("plaid_webhook", { type: payload.webhook_type, code: payload.webhook_code });
  await audit({
    event: "webhook_received",
    actor: "webhook",
    provider: "plaid",
    targetId: payload.item_id,
    metadata: { type: payload.webhook_type, code: payload.webhook_code },
  });
  // Transactions sync is triggered by a later scheduled/queued job; V1 records the signal only.
  return json({ received: true });
}
