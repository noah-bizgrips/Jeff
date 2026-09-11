import "server-only";
import type { OAuthProviderAdapter, TestResult } from "./base";
import { expiresAtFrom, fetchJson } from "./base";
import type { TokenResponse } from "@/lib/integrations/oauth";
import type { SecretBundle } from "@/lib/integrations/store";
import { requireEnv, publicEnv } from "@/lib/env";

/**
 * Meta: one app authorization exposing Ads, Pages and Instagram as separate
 * Jeff capabilities. Read-only permissions verified against the current
 * permissions reference (Graph API v26.0).
 */
export const META_GRAPH_VERSION = "v26.0";
export const META_PERMISSIONS = [
  "ads_read",
  "pages_show_list",
  "pages_read_engagement",
  "read_insights",
  "instagram_basic",
  "instagram_manage_insights",
  "business_management",
];

export interface MetaSecret extends SecretBundle {
  kind: "oauth_tokens";
  user_token: string; // long-lived user token
  expires_at?: string | null;
}

const GRAPH = `https://graph.facebook.com/${META_GRAPH_VERSION}`;

export const metaAdapter: OAuthProviderAdapter = {
  id: "meta",
  config: {
    id: "meta",
    authorizeUrl: `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`,
    tokenUrl: `${GRAPH}/oauth/access_token`,
    scopes: META_PERMISSIONS,
    scopeDelimiter: ",",
    pkce: false,
    tokenAuth: "body",
    clientIdEnv: "META_APP_ID",
    clientSecretEnv: "META_APP_SECRET",
  },
  // Meta's token endpoint is a GET with query params; then upgrade to a long-lived token.
  async exchange(code) {
    const appId = requireEnv("META_APP_ID");
    const appSecret = requireEnv("META_APP_SECRET");
    const redirect = `${publicEnv().appUrl.replace(/\/$/, "")}/api/oauth/meta/callback`;
    const u = new URL(`${GRAPH}/oauth/access_token`);
    u.searchParams.set("client_id", appId);
    u.searchParams.set("client_secret", appSecret);
    u.searchParams.set("redirect_uri", redirect);
    u.searchParams.set("code", code);
    const short = await fetchJson<TokenResponse>(u.toString());
    if (short.status !== 200 || !short.body?.access_token) throw new Error(`token_exchange_failed:${short.status}`);
    const ll = new URL(`${GRAPH}/oauth/access_token`);
    ll.searchParams.set("grant_type", "fb_exchange_token");
    ll.searchParams.set("client_id", appId);
    ll.searchParams.set("client_secret", appSecret);
    ll.searchParams.set("fb_exchange_token", short.body.access_token);
    const long = await fetchJson<TokenResponse>(ll.toString());
    return long.status === 200 && long.body?.access_token ? long.body : short.body;
  },
  async onCallback(tokens: TokenResponse) {
    if (!tokens.access_token) throw new Error("meta_no_access_token");
    const me = await fetchJson<{ id?: string; name?: string }>(`${GRAPH}/me?fields=id,name&access_token=${encodeURIComponent(tokens.access_token)}`);
    return {
      secret: { kind: "oauth_tokens", user_token: tokens.access_token, expires_at: expiresAtFrom(tokens.expires_in) } satisfies MetaSecret,
      accountIdentifier: me.body?.name ?? null,
      externalAccountId: me.body?.id ?? null,
      scopes: META_PERMISSIONS,
      capabilities: ["ads", "pages", "instagram"],
      expiresAt: expiresAtFrom(tokens.expires_in),
      metadata: { selected_ad_accounts: [], selected_pages: [], selected_instagram_accounts: [] },
      displayName: me.body?.name ? `Meta · ${me.body.name}` : "Meta",
    };
  },
  async test(secret): Promise<TestResult> {
    const s = secret as MetaSecret;
    const q = `access_token=${encodeURIComponent(s.user_token)}`;
    const me = await fetchJson<{ id?: string; name?: string }>(`${GRAPH}/me?fields=id,name&${q}`);
    if (me.status !== 200 || !me.body?.id) return { ok: false, error: `meta_me_failed:${me.status}` };
    const perms = await fetchJson<{ data?: { permission: string; status: string }[] }>(`${GRAPH}/me/permissions?${q}`);
    const granted = (perms.body?.data ?? []).filter((p) => p.status === "granted").map((p) => p.permission);
    const missing = META_PERMISSIONS.filter((p) => !granted.includes(p));
    return {
      ok: true,
      limited: missing.length > 0,
      accountIdentifier: me.body.name ?? null,
      details: { granted, missing },
    };
  },
};

/** Lists assets the owner may select for analysis. Non-secret ids/names only. */
export async function listMetaAssets(secret: MetaSecret) {
  const q = `access_token=${encodeURIComponent(secret.user_token)}`;
  const [ads, pages] = await Promise.all([
    fetchJson<{ data?: { id: string; name?: string; account_id?: string }[] }>(`${GRAPH}/me/adaccounts?fields=id,name,account_id&limit=50&${q}`),
    fetchJson<{ data?: { id: string; name?: string; instagram_business_account?: { id: string; username?: string } }[] }>(
      `${GRAPH}/me/accounts?fields=id,name,instagram_business_account{id,username}&limit=50&${q}`,
    ),
  ]);
  return {
    adAccounts: (ads.body?.data ?? []).map((a) => ({ id: a.id, name: a.name ?? a.account_id ?? a.id })),
    pages: (pages.body?.data ?? []).map((p) => ({ id: p.id, name: p.name ?? p.id })),
    instagramAccounts: (pages.body?.data ?? [])
      .filter((p) => p.instagram_business_account)
      .map((p) => ({ id: p.instagram_business_account!.id, name: p.instagram_business_account!.username ?? p.instagram_business_account!.id, pageId: p.id })),
  };
}
