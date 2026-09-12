import "server-only";
import type { OAuthProviderAdapter, TestResult } from "./base";
import { expiresAtFrom, fetchJson } from "./base";
import { refreshAccessToken, type TokenResponse } from "@/lib/integrations/oauth";
import { publicEnv, requireEnv } from "@/lib/env";
import type { SecretBundle } from "@/lib/integrations/store";

/**
 * HighLevel / LeadConnector OAuth (v2 API). Read-only scopes. The connection
 * is per Location (sub-account); multiple locations become multiple
 * connections keyed by externalAccountId = locationId.
 */
export const HIGHLEVEL_VERSION = "2021-07-28";
export const HIGHLEVEL_SCOPES = [
  "contacts.readonly",
  "conversations.readonly",
  "conversations/message.readonly",
  "opportunities.readonly",
  "calendars.readonly",
  "calendars/events.readonly",
  "locations.readonly",
  "users.readonly",
];

export interface HighLevelSecret extends SecretBundle {
  kind: "oauth_tokens";
  access_token: string;
  refresh_token?: string;
  expires_at?: string | null;
  location_id?: string;
}

interface HLTokens extends TokenResponse {
  locationId?: string;
  companyId?: string;
  userType?: string;
  userId?: string;
}

// HighLevel rejects redirect URIs containing "highlevel"/"leadconnector", so the route slug is neutral.
export const HIGHLEVEL_ROUTE_SLUG = "crm";

const config = {
  id: "highlevel",
  routeSlug: HIGHLEVEL_ROUTE_SLUG,
  authorizeUrl: "https://marketplace.gohighlevel.com/oauth/chooselocation",
  tokenUrl: "https://services.leadconnectorhq.com/oauth/token",
  scopes: HIGHLEVEL_SCOPES,
  pkce: false,
  tokenAuth: "body" as const,
  clientIdEnv: "HIGHLEVEL_CLIENT_ID",
  clientSecretEnv: "HIGHLEVEL_CLIENT_SECRET",
};

export async function highlevelAccessToken(secret: HighLevelSecret) {
  const expired = secret.expires_at ? Date.parse(secret.expires_at) - 60_000 < Date.now() : false;
  if (!expired) return { token: secret.access_token };
  if (!secret.refresh_token) throw new Error("highlevel_refresh_token_missing");
  const t = (await refreshAccessToken(config, secret.refresh_token)) as HLTokens;
  if (!t.access_token) throw new Error("highlevel_refresh_failed");
  const refreshed: HighLevelSecret = {
    ...secret,
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? secret.refresh_token,
    expires_at: expiresAtFrom(t.expires_in),
  };
  return { token: t.access_token, refreshed };
}

export const highlevelAdapter: OAuthProviderAdapter = {
  id: "highlevel",
  config,
  // HighLevel requires user_type on the token request.
  async exchange(code) {
    const clientId = requireEnv(config.clientIdEnv);
    const clientSecret = requireEnv(config.clientSecretEnv);
    const res = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
        user_type: "Location",
        redirect_uri: `${publicEnv().appUrl.replace(/\/$/, "")}/api/oauth/${HIGHLEVEL_ROUTE_SLUG}/callback`,
      }),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`token_exchange_failed:${res.status}`);
    return (await res.json()) as HLTokens;
  },
  async onCallback(tokens: HLTokens) {
    if (!tokens.access_token) throw new Error("highlevel_no_access_token");
    return {
      secret: {
        kind: "oauth_tokens",
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: expiresAtFrom(tokens.expires_in),
        location_id: tokens.locationId,
      } satisfies HighLevelSecret,
      accountIdentifier: tokens.locationId ? `Location ${tokens.locationId}` : null,
      externalAccountId: tokens.locationId ?? tokens.companyId ?? null,
      scopes: typeof tokens.scope === "string" ? tokens.scope.split(" ") : HIGHLEVEL_SCOPES,
      capabilities: ["contacts", "conversations", "opportunities", "calendars"],
      expiresAt: expiresAtFrom(tokens.expires_in),
      metadata: { locationId: tokens.locationId, companyId: tokens.companyId, userType: tokens.userType },
      displayName: "HighLevel",
    };
  },
  async test(secret): Promise<TestResult> {
    const s = secret as HighLevelSecret;
    if (!s.location_id) return { ok: false, error: "highlevel_location_missing" };
    const { token } = await highlevelAccessToken(s);
    const { status, body } = await fetchJson<{ location?: { name?: string; id?: string } }>(
      `https://services.leadconnectorhq.com/locations/${encodeURIComponent(s.location_id)}`,
      { headers: { Authorization: `Bearer ${token}`, Version: HIGHLEVEL_VERSION, Accept: "application/json" } },
    );
    if (status !== 200) return { ok: false, error: `highlevel_location_failed:${status}` };
    return { ok: true, accountIdentifier: body?.location?.name ?? `Location ${s.location_id}` };
  },
};
