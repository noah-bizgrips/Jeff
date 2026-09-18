import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { withErrorBoundary } from "@/lib/api";
import { createClient } from "@/lib/supabase/server";
import { resolveOwnerSession } from "@/lib/auth/session";
import { resolveOAuthAdapter } from "@/lib/integrations/providers";
import { getProvider } from "@/lib/integrations/registry";
import {
  clearStateCookie,
  exchangeCode,
  verifyState,
} from "@/lib/integrations/oauth";
import {
  upsertConnection,
  setConnectionStatus,
} from "@/lib/integrations/store";
import { audit } from "@/lib/audit";
import { errorMessage, log } from "@/lib/security/log";
import { publicEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

function back(reason: string, provider: string, ok = false) {
  const url = new URL("/connections", publicEnv().appUrl);
  url.searchParams.set("provider", provider);
  url.searchParams.set(ok ? "connected" : "oauth_error", reason);
  return NextResponse.redirect(url, { status: 303 });
}

/**
 * GET /api/oauth/{provider}/callback
 * Verifies the signed state, exchanges the code server-side, stores the
 * credential encrypted, then runs the provider's harmless test. The
 * connection is marked `connected` only if the test passes.
 */
export const GET = withErrorBoundary(async (req, ctx) => {
  const { provider: slug = "" } = await ctx.params;
  const adapter = resolveOAuthAdapter(slug);
  const provider = adapter?.id ?? slug;
  const def = getProvider(provider);
  if (!adapter || !def) return back("unknown_provider", provider);

  // The callback is a top-level navigation, so the owner's session cookies are present.
  const supabase = await createClient();
  const session = await resolveOwnerSession(supabase);
  if (session.status !== "owner" || session.aal !== "aal2") {
    return NextResponse.redirect(new URL("/login", publicEnv().appUrl), {
      status: 303,
    });
  }

  const url = new URL(req.url);
  const cookieStore = await cookies();
  const state = verifyState(
    provider,
    cookieStore.get(`gomez_oauth_${provider}`)?.value,
    url.searchParams.get("state"),
  );
  await clearStateCookie(provider);
  if (!state.ok) {
    await audit({
      event: "oauth_failed",
      ownerId: session.userId,
      provider,
      request: req,
      metadata: { reason: state.reason },
    });
    return back(state.reason, provider);
  }
  const providerError = url.searchParams.get("error");
  if (providerError) {
    await audit({
      event: "oauth_failed",
      ownerId: session.userId,
      provider,
      request: req,
      metadata: { reason: "provider_denied" },
    });
    return back("provider_denied", provider);
  }
  const code = url.searchParams.get("code");
  if (!code) return back("missing_code", provider);

  let result;
  try {
    const tokens = adapter.exchange
      ? await adapter.exchange(code, state.verifier)
      : await exchangeCode(adapter.config, code, state.verifier);
    result = await adapter.onCallback(tokens);
  } catch (err) {
    log.warn("oauth_exchange_failed", { provider, message: errorMessage(err) });
    await audit({
      event: "oauth_failed",
      ownerId: session.userId,
      provider,
      request: req,
      metadata: { reason: "exchange_failed" },
    });
    return back("exchange_failed", provider);
  }

  let conn;
  try {
    conn = await upsertConnection({
      ownerId: session.userId,
      provider,
      displayName: result.displayName ?? def.name,
      status: "testing",
      accessMode: def.access,
      scopes: result.scopes,
      capabilities: result.capabilities,
      accountIdentifier: result.accountIdentifier,
      externalAccountId: result.externalAccountId,
      metadata: result.metadata ?? {},
      secret: result.secret,
      secretExpiresAt: result.expiresAt,
    });
  } catch (err) {
    log.error("oauth_store_failed", { provider, message: errorMessage(err) });
    await audit({
      event: "oauth_failed",
      ownerId: session.userId,
      provider,
      request: req,
      metadata: { reason: "store_failed" },
    });
    return back("store_failed", provider);
  }
  await audit({
    event: "connection_created",
    ownerId: session.userId,
    provider,
    targetId: conn.id,
    request: req,
    metadata: { scopes: result.scopes },
  });

  try {
    const test = await adapter.test(result.secret, conn.id);
    await setConnectionStatus(conn.id, {
      status: test.ok ? (test.limited ? "limited" : "connected") : "error",
      lastTestOk: test.ok,
      lastError: test.ok ? null : (test.error ?? "test_failed"),
      accountIdentifier:
        test.accountIdentifier ?? result.accountIdentifier ?? null,
      metadata: { ...(result.metadata ?? {}), last_test_details: test.details ?? null, token_expires_at: result.expiresAt ?? null },
    });
    await audit({
      event: "connection_tested",
      ownerId: session.userId,
      provider,
      targetId: conn.id,
      request: req,
      metadata: { ok: test.ok, limited: !!test.limited },
    });
    if (!test.ok) return back("test_failed", provider);
  } catch (err) {
    await setConnectionStatus(conn.id, {
      status: "error",
      lastTestOk: false,
      lastError: errorMessage(err),
    });
    return back("test_failed", provider);
  }

  return back(provider, provider, true);
});
