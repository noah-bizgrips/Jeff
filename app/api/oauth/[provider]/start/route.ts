import { NextResponse } from "next/server";
import { apiError, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { resolveOAuthAdapter } from "@/lib/integrations/providers";
import { getProvider } from "@/lib/integrations/registry";
import { buildAuthorizationStart, setStateCookie } from "@/lib/integrations/oauth";
import { hasEnv } from "@/lib/env";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * GET /api/oauth/{provider}/start
 * Owner + aal2 only. Creates a signed state cookie (+ PKCE where supported)
 * and redirects to the provider's consent screen.
 */
export const GET = withErrorBoundary(async (req, ctx) => {
  const { provider: slug = "" } = await ctx.params;
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const adapter = resolveOAuthAdapter(slug);
  const provider = adapter?.id ?? slug;
  const def = getProvider(provider);
  if (!adapter || !def) return apiError("unknown_provider", 404);
  const missing = def.requiredEnv.filter((n) => !hasEnv(n));
  if (missing.length) return apiError("provider_not_configured", 409, { missingEnv: missing });

  const start = buildAuthorizationStart(adapter.config);
  await setStateCookie(start.cookie);
  await audit({ event: "oauth_started", ownerId: g.session.userId, provider, request: req });
  return NextResponse.redirect(start.url, { status: 302 });
});
