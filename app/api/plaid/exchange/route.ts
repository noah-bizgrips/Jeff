import { z } from "zod";
import { json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { exchangePublicToken, plaidEnv, testPlaid, type PlaidSecret } from "@/lib/integrations/providers/plaid";
import { setConnectionStatus, upsertConnection } from "@/lib/integrations/store";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const Body = z.object({
  publicToken: z.string().min(10).max(300),
  institution: z.object({ id: z.string().max(100).optional(), name: z.string().max(200).optional() }).optional(),
});

/**
 * POST /api/plaid/exchange
 * Exchanges the Link public token for an access token, stores it encrypted,
 * and runs a harmless accounts read. The response never contains the token.
 */
export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const body = await parseBody(req, Body);
  if (!body.ok) return body.response;
  const { accessToken, itemId } = await exchangePublicToken(body.data.publicToken);
  const secret: PlaidSecret = { kind: "plaid_access_token", access_token: accessToken, item_id: itemId };
  const name = body.data.institution?.name ?? "Financial account";
  const conn = await upsertConnection({
    ownerId: g.session.userId,
    provider: "plaid",
    displayName: `Financial Accounts · ${name}`,
    status: "testing",
    accessMode: "read",
    capabilities: ["transactions"],
    scopes: ["transactions"],
    accountIdentifier: name,
    externalAccountId: itemId,
    metadata: { env: plaidEnv(), institution_id: body.data.institution?.id ?? null, products: ["transactions"] },
    secret,
  });
  await audit({ event: "connection_created", ownerId: g.session.userId, provider: "plaid", targetId: conn.id, request: req, metadata: { env: plaidEnv() } });
  const test = await testPlaid(secret);
  await setConnectionStatus(conn.id, {
    status: test.ok ? "connected" : "error",
    lastTestOk: test.ok,
    lastError: test.ok ? null : (test.error ?? "test_failed"),
    accountIdentifier: test.accountIdentifier ?? name,
  });
  await audit({ event: "connection_tested", ownerId: g.session.userId, provider: "plaid", targetId: conn.id, request: req, metadata: { ok: test.ok } });
  return json({ ok: test.ok, connectionId: conn.id, details: test.details ?? null, error: test.error ?? null });
});
