import { createHmac } from "node:crypto";
import { apiError, json } from "@/lib/api";
import { audit } from "@/lib/audit";
import { hasEnv, requireEnv } from "@/lib/env";
import { safeEqual } from "@/lib/crypto/secrets";

export const dynamic = "force-dynamic";

/** POST /api/webhooks/github — HMAC-SHA256 verified with GITHUB_APP_WEBHOOK_SECRET. */
export async function POST(req: Request) {
  if (!hasEnv("GITHUB_APP_WEBHOOK_SECRET")) return apiError("webhook_not_configured", 503);
  const sig = req.headers.get("x-hub-signature-256");
  const raw = await req.text();
  const expected = `sha256=${createHmac("sha256", requireEnv("GITHUB_APP_WEBHOOK_SECRET")).update(raw).digest("hex")}`;
  if (!sig || !safeEqual(sig, expected)) {
    await audit({ event: "webhook_rejected", actor: "webhook", provider: "github", metadata: { reason: "bad_signature" } });
    return apiError("invalid_signature", 400);
  }
  const event = req.headers.get("x-github-event") ?? "unknown";
  const delivery = req.headers.get("x-github-delivery") ?? undefined;
  await audit({ event: "webhook_received", actor: "webhook", provider: "github", targetId: delivery, metadata: { type: event } });
  return json({ received: true });
}
