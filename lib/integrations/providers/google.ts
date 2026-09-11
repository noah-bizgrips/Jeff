import "server-only";
import type { OAuthProviderAdapter, TestResult } from "./base";
import { expiresAtFrom, fetchJson } from "./base";
import { refreshAccessToken, type TokenResponse } from "@/lib/integrations/oauth";
import type { SecretBundle } from "@/lib/integrations/store";

/**
 * Google Workspace: one OAuth grant covering Gmail, Drive and Calendar.
 * Read-only scopes only. Refresh token stored encrypted.
 */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
];

export interface GoogleSecret extends SecretBundle {
  kind: "oauth_tokens";
  access_token: string;
  refresh_token?: string;
  expires_at?: string | null;
}

const config = {
  id: "google",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes: GOOGLE_SCOPES,
  pkce: true,
  tokenAuth: "body" as const,
  extraAuthorizeParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
  clientIdEnv: "GOOGLE_CLIENT_ID",
  clientSecretEnv: "GOOGLE_CLIENT_SECRET",
};

async function userinfo(accessToken: string) {
  return fetchJson<{ email?: string; sub?: string }>("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/** Returns a usable access token, refreshing when expired. Never exported to the client. */
export async function googleAccessToken(secret: GoogleSecret): Promise<{ token: string; refreshed?: GoogleSecret }> {
  const expired = secret.expires_at ? Date.parse(secret.expires_at) - 60_000 < Date.now() : false;
  if (!expired) return { token: secret.access_token };
  if (!secret.refresh_token) throw new Error("google_refresh_token_missing");
  const t = await refreshAccessToken(config, secret.refresh_token);
  if (!t.access_token) throw new Error("google_refresh_failed");
  const refreshed: GoogleSecret = {
    ...secret,
    access_token: t.access_token,
    expires_at: expiresAtFrom(t.expires_in),
  };
  return { token: t.access_token, refreshed };
}

export const googleAdapter: OAuthProviderAdapter = {
  id: "google",
  config,
  async onCallback(tokens: TokenResponse) {
    if (!tokens.access_token) throw new Error("google_no_access_token");
    const { body } = await userinfo(tokens.access_token);
    const granted = typeof tokens.scope === "string" ? tokens.scope.split(" ") : GOOGLE_SCOPES;
    const caps: string[] = [];
    if (granted.some((s) => s.includes("gmail"))) caps.push("gmail");
    if (granted.some((s) => s.includes("drive"))) caps.push("drive");
    if (granted.some((s) => s.includes("calendar"))) caps.push("calendar");
    return {
      secret: {
        kind: "oauth_tokens",
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: expiresAtFrom(tokens.expires_in),
      } satisfies GoogleSecret,
      accountIdentifier: body?.email ?? null,
      externalAccountId: body?.sub ?? null,
      scopes: granted,
      capabilities: caps,
      expiresAt: expiresAtFrom(tokens.expires_in),
      displayName: body?.email ? `Google · ${body.email}` : "Google Workspace",
    };
  },
  async test(secret): Promise<TestResult> {
    const s = secret as GoogleSecret;
    const { token } = await googleAccessToken(s);
    const checks: Record<string, boolean> = {};
    const me = await userinfo(token);
    checks.identity = me.status === 200 && !!me.body?.email;
    const gmail = await fetchJson<{ emailAddress?: string }>("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: `Bearer ${token}` },
    });
    checks.gmail = gmail.status === 200;
    const drive = await fetchJson("https://www.googleapis.com/drive/v3/about?fields=user", {
      headers: { Authorization: `Bearer ${token}` },
    });
    checks.drive = drive.status === 200;
    const cal = await fetchJson("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1", {
      headers: { Authorization: `Bearer ${token}` },
    });
    checks.calendar = cal.status === 200;
    const passed = Object.values(checks).filter(Boolean).length;
    return {
      ok: checks.identity && passed >= 2,
      limited: checks.identity && passed < 4,
      accountIdentifier: me.body?.email ?? null,
      details: checks,
      error: checks.identity ? undefined : `google_identity_check_failed:${me.status}`,
    };
  },
};
