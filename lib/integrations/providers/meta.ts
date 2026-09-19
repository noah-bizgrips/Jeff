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

/**
 * Facebook Login for Business (Business-type apps) replaces `scope` with a
 * `config_id` created in the app dashboard (user-token configuration listing
 * the same read-only permissions). When META_LOGIN_CONFIG_ID is set we send it
 * and omit `scope`, per Meta's guidance; otherwise the classic scope flow is used.
 */
/** Permissions actually requested: META_SCOPES (comma list) narrows the default set to what the app has been granted. */
export function metaRequestedScopes(): string[] {
  const raw = process.env.META_SCOPES?.trim();
  if (!raw) return META_PERMISSIONS;
  const allowed = new Set([...META_PERMISSIONS, "email", "public_profile"]);
  return raw.split(",").map((s) => s.trim()).filter((s) => allowed.has(s));
}

function authorizeExtras(): { extra: Record<string, string>; scopes: string[] } {
  const configId = process.env.META_LOGIN_CONFIG_ID?.trim();
  if (configId) return { extra: { config_id: configId, response_type: "code", override_default_response_type: "true" }, scopes: [] };
  return { extra: {}, scopes: metaRequestedScopes() };
}

export const metaAdapter: OAuthProviderAdapter = {
  id: "meta",
  get config() {
    const { extra, scopes } = authorizeExtras();
    return {
      id: "meta",
      authorizeUrl: `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`,
      tokenUrl: `${GRAPH}/oauth/access_token`,
      scopes,
      scopeDelimiter: ",",
      pkce: false,
      tokenAuth: "body" as const,
      extraAuthorizeParams: extra,
      clientIdEnv: "META_APP_ID",
      clientSecretEnv: "META_APP_SECRET",
    };
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
    let granted = (perms.body?.data ?? []).filter((p) => p.status === "granted").map((p) => p.permission);
    // System user tokens do not always expose /me/permissions; prove ads access with a harmless read instead.
    if (!granted.length) {
      const ads = await fetchJson<{ data?: { id: string }[] }>(`${GRAPH}/me/adaccounts?fields=id&limit=1&${q}`);
      if (ads.status === 200) granted = ["ads_read"];
    }
    const missing = metaRequestedScopes().filter((p) => !granted.includes(p));
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

/* ------------------------------------------------------------------ */
/* Business-wide ad account discovery ("every account BizGrips can access") */
/* ------------------------------------------------------------------ */

export interface DiscoveredAdAccount {
  id: string; // act_…
  name: string;
  businessId: string | null;
  /** owned by the business, or shared by a client (partner access). */
  relation: "owned" | "client" | "direct";
  /** The token can already read this account. */
  accessible: boolean;
}

/**
 * Every ad account the business can see: accounts directly assigned to the
 * token's user plus the business's owned and client (partner-shared)
 * accounts. Needs business_management for the business edges; without it
 * only the directly assigned accounts are returned.
 */
export async function discoverAdAccounts(secret: MetaSecret): Promise<{ accounts: DiscoveredAdAccount[]; businessIds: string[]; limitations: string[] }> {
  const q = `access_token=${encodeURIComponent(secret.user_token)}`;
  const limitations: string[] = [];
  const direct = await fetchJson<{ data?: { id: string; name?: string; account_id?: string }[] }>(`${GRAPH}/me/adaccounts?fields=id,name,account_id&limit=200&${q}`);
  const byId = new Map<string, DiscoveredAdAccount>();
  for (const a of direct.body?.data ?? []) byId.set(a.id, { id: a.id, name: a.name ?? a.account_id ?? a.id, businessId: null, relation: "direct", accessible: true });

  const biz = await fetchJson<{ data?: { id: string; name?: string }[] }>(`${GRAPH}/me/businesses?fields=id,name&limit=50&${q}`);
  const businessIds = (biz.body?.data ?? []).map((b) => b.id);
  if (biz.status !== 200) limitations.push("business_management permission missing: only directly assigned ad accounts are visible; new client accounts will not be discovered automatically.");
  for (const b of businessIds) {
    for (const [edge, relation] of [["owned_ad_accounts", "owned"], ["client_ad_accounts", "client"]] as const) {
      const res = await fetchJson<{ data?: { id: string; name?: string; account_id?: string }[] }>(`${GRAPH}/${b}/${edge}?fields=id,name,account_id&limit=200&${q}`);
      if (res.status !== 200) {
        limitations.push(`Could not list ${relation} ad accounts for business ${b}.`);
        continue;
      }
      for (const a of res.body?.data ?? []) {
        const existing = byId.get(a.id);
        if (existing) {
          if (!existing.businessId) existing.businessId = b;
          if (existing.relation === "direct") existing.relation = relation;
        } else byId.set(a.id, { id: a.id, name: a.name ?? a.account_id ?? a.id, businessId: b, relation, accessible: false });
      }
    }
  }
  return { accounts: Array.from(byId.values()), businessIds, limitations };
}

/**
 * Gives the token's own (system) user the ANALYZE task on an ad account so
 * insights become readable. Self-provisioning only — never grants anyone
 * else access, never more than read/analyze. Requires an Admin system user
 * with business_management. Returns false (with a reason) when Meta refuses.
 */
export async function ensureAnalyzeAccess(secret: MetaSecret, account: DiscoveredAdAccount): Promise<{ ok: boolean; reason?: string }> {
  if (!account.businessId) return { ok: false, reason: "no_business" };
  const q = `access_token=${encodeURIComponent(secret.user_token)}`;
  const me = await fetchJson<{ id?: string }>(`${GRAPH}/me?fields=id&${q}`);
  if (!me.body?.id) return { ok: false, reason: "me_failed" };
  const res = await fetch(`${GRAPH}/${account.id}/assigned_users`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ user: me.body.id, tasks: JSON.stringify(["ANALYZE"]), business: account.businessId, access_token: secret.user_token }),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => null)) as { success?: boolean; error?: { code?: number; message?: string } } | null;
  if (res.ok && body?.success !== false) return { ok: true };
  return { ok: false, reason: `assign_failed:${res.status}:${body?.error?.code ?? ""}` };
}
