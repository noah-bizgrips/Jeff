import { apiError, json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { createLinkToken, plaidEnv } from "@/lib/integrations/providers/plaid";
import { hasEnv, publicEnv } from "@/lib/env";
import { log } from "@/lib/security/log";

export const dynamic = "force-dynamic";

/** POST /api/plaid/link-token — short-lived Link token for the browser. Not an access token. */
export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const missing = ["PLAID_CLIENT_ID", "PLAID_SECRET"].filter((n) => !hasEnv(n));
  if (missing.length) return apiError("provider_not_configured", 409, { missingEnv: missing });
  const webhook = `${publicEnv().appUrl.replace(/\/$/, "")}/api/webhooks/plaid`;
  try {
    const linkToken = await createLinkToken(g.session.userId, webhook);
    return json({ linkToken, env: plaidEnv() });
  } catch (err) {
    // Plaid's error_code/error_type are documentation identifiers, not secrets; the message can mention keys, so it is not returned.
    const data = (err as { response?: { data?: { error_code?: string; error_type?: string; error_message?: string } } })?.response?.data;
    log.warn("plaid_link_token_failed", { env: plaidEnv(), error_code: data?.error_code ?? null, error_type: data?.error_type ?? null });
    return apiError("plaid_link_token_failed", 502, { error_code: data?.error_code ?? null, env: plaidEnv() });
  }
});
