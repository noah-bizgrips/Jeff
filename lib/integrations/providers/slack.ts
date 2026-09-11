import "server-only";
import type { OAuthProviderAdapter, TestResult } from "./base";
import { fetchJson } from "./base";
import type { TokenResponse } from "@/lib/integrations/oauth";
import type { SecretBundle } from "@/lib/integrations/store";

/**
 * Slack: user token limited to search + public channel read.
 * No chat:write, no im:/groups: history, no admin scopes.
 */
export const SLACK_USER_SCOPES = ["search:read", "channels:read", "channels:history", "users:read"];

export interface SlackSecret extends SecretBundle {
  kind: "oauth_tokens";
  user_token: string;
}

interface SlackAuthed extends TokenResponse {
  ok?: boolean;
  authed_user?: { id?: string; access_token?: string; scope?: string };
  team?: { id?: string; name?: string };
}

export const slackAdapter: OAuthProviderAdapter = {
  id: "slack",
  config: {
    id: "slack",
    authorizeUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    scopes: SLACK_USER_SCOPES,
    scopeParam: "user_scope",
    scopeDelimiter: ",",
    pkce: false,
    tokenAuth: "body",
    clientIdEnv: "SLACK_CLIENT_ID",
    clientSecretEnv: "SLACK_CLIENT_SECRET",
  },
  async onCallback(tokens: SlackAuthed) {
    const userToken = tokens.authed_user?.access_token;
    if (!tokens.ok || !userToken) throw new Error("slack_no_user_token");
    return {
      secret: { kind: "oauth_tokens", user_token: userToken } satisfies SlackSecret,
      accountIdentifier: tokens.team?.name ?? null,
      externalAccountId: tokens.team?.id ?? null,
      scopes: (tokens.authed_user?.scope ?? "").split(",").filter(Boolean),
      capabilities: ["search"],
      expiresAt: null,
      metadata: { team_id: tokens.team?.id, user_id: tokens.authed_user?.id },
      displayName: tokens.team?.name ? `Slack · ${tokens.team.name}` : "Slack",
    };
  },
  async test(secret): Promise<TestResult> {
    const s = secret as SlackSecret;
    const { status, body } = await fetchJson<{ ok?: boolean; team?: string; user?: string; error?: string }>(
      "https://slack.com/api/auth.test",
      { method: "POST", headers: { Authorization: `Bearer ${s.user_token}` } },
    );
    if (status !== 200 || !body?.ok) return { ok: false, error: `slack_auth_test_failed:${body?.error ?? status}` };
    return { ok: true, accountIdentifier: body.team ?? null, details: { user: body.user } };
  },
};
