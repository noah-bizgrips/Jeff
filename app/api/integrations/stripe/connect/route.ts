import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { isRestrictedKey, testStripe, type StripeSecret } from "@/lib/integrations/providers/stripe";
import { setConnectionStatus, upsertConnection } from "@/lib/integrations/store";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const Body = z.object({
  restrictedKey: z.string().min(20).max(200),
  label: z.string().trim().max(80).optional(),
});

/**
 * POST /api/integrations/stripe/connect
 * Accepts a RESTRICTED read-only key once, encrypts it immediately, runs a
 * harmless read probe, and never echoes the key back. Secret keys (sk_) are
 * rejected: Jeff must not be able to move money.
 */
export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const body = await parseBody(req, Body);
  if (!body.ok) return body.response;
  const key = body.data.restrictedKey.trim();
  if (!isRestrictedKey(key)) {
    return apiError("restricted_key_required", 400, { hint: "Use a Stripe restricted key (rk_live_… / rk_test_…) with read-only permissions." });
  }
  const secret: StripeSecret = { kind: "api_key", restricted_key: key };
  const mode = key.startsWith("rk_live_") ? "live" : "test";
  const conn = await upsertConnection({
    ownerId: g.session.userId,
    provider: "stripe",
    displayName: body.data.label || `Stripe (${mode}, restricted)`,
    status: "testing",
    accessMode: "read",
    capabilities: ["reporting"],
    scopes: ["read"],
    externalAccountId: mode,
    metadata: { mode },
    secret,
  });
  await audit({ event: "connection_created", ownerId: g.session.userId, provider: "stripe", targetId: conn.id, request: req, metadata: { mode } });
  const test = await testStripe(secret);
  await setConnectionStatus(conn.id, {
    status: test.ok ? (test.limited ? "limited" : "connected") : "error",
    lastTestOk: test.ok,
    lastError: test.ok ? null : (test.error ?? "test_failed"),
    accountIdentifier: test.accountIdentifier ?? null,
  });
  await audit({ event: "connection_tested", ownerId: g.session.userId, provider: "stripe", targetId: conn.id, request: req, metadata: { ok: test.ok } });
  return json({ ok: test.ok, limited: !!test.limited, details: test.details ?? null, error: test.error ?? null, connectionId: conn.id });
});
