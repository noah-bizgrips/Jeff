import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { META_PERMISSIONS, metaAdapter, type MetaSecret } from "@/lib/integrations/providers/meta";
import { setConnectionStatus, upsertConnection } from "@/lib/integrations/store";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const Body = z.object({
  token: z.string().min(40).max(1000),
  label: z.string().trim().max(80).optional(),
});

/**
 * POST /api/integrations/meta/connect
 * Accepts a Meta Business Manager SYSTEM USER token once (generated in
 * Business Settings with ads_read only), encrypts it immediately, verifies
 * it with harmless reads, and never echoes it back. This bypasses the
 * Facebook Login dialog, which a Consumer-type app cannot use for ads.
 */
export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const body = await parseBody(req, Body);
  if (!body.ok) return body.response;
  const token = body.data.token.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return apiError("meta_token_invalid", 400, { hint: "Paste the system user access token exactly as Meta generated it." });
  const secret: MetaSecret = { kind: "oauth_tokens", user_token: token, expires_at: null };
  const test = await metaAdapter.test(secret, "pending");
  const details = (test.details ?? {}) as { granted?: string[]; missing?: string[] };
  const conn = await upsertConnection({
    ownerId: g.session.userId,
    provider: "meta",
    displayName: body.data.label || `Meta · ${test.accountIdentifier ?? "system user"}`,
    status: "testing",
    accessMode: "read",
    capabilities: ["ads"],
    scopes: details.granted?.length ? details.granted.filter((s) => (META_PERMISSIONS as readonly string[]).includes(s)) : ["ads_read"],
    externalAccountId: null,
    metadata: { auth: "system_user_token", selected_ad_accounts: [], selected_pages: [], selected_instagram_accounts: [] },
    secret,
  });
  await audit({ event: "connection_created", ownerId: g.session.userId, provider: "meta", targetId: conn.id, request: req, metadata: { auth: "system_user_token" } });
  await setConnectionStatus(conn.id, {
    status: test.ok ? (test.limited ? "limited" : "connected") : "error",
    lastTestOk: test.ok,
    lastError: test.ok ? null : (test.error ?? "test_failed"),
    accountIdentifier: test.accountIdentifier ?? null,
    metadata: { auth: "system_user_token", selected_ad_accounts: [], selected_pages: [], selected_instagram_accounts: [], last_test_details: test.details ?? null },
  });
  await audit({ event: "connection_tested", ownerId: g.session.userId, provider: "meta", targetId: conn.id, request: req, metadata: { ok: test.ok, limited: !!test.limited } });
  return json({ ok: test.ok, limited: !!test.limited, details: test.details ?? null, error: test.error ?? null, connectionId: conn.id });
});
