import { apiError, json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { createLinkToken, plaidEnv } from "@/lib/integrations/providers/plaid";
import { hasEnv, publicEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

/** POST /api/plaid/link-token — short-lived Link token for the browser. Not an access token. */
export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const missing = ["PLAID_CLIENT_ID", "PLAID_SECRET"].filter((n) => !hasEnv(n));
  if (missing.length) return apiError("provider_not_configured", 409, { missingEnv: missing });
  const webhook = `${publicEnv().appUrl.replace(/\/$/, "")}/api/webhooks/plaid`;
  const linkToken = await createLinkToken(g.session.userId, webhook);
  return json({ linkToken, env: plaidEnv() });
});
