import "server-only";
import type { OAuthProviderAdapter, TestResult } from "./base";
import { fetchJson } from "./base";
import type { TokenResponse } from "@/lib/integrations/oauth";
import type { SecretBundle } from "@/lib/integrations/store";

export const NOTION_VERSION = "2022-06-28";

export interface NotionSecret extends SecretBundle {
  kind: "oauth_tokens";
  access_token: string;
}

interface NotionTokens extends TokenResponse {
  workspace_name?: string;
  workspace_id?: string;
  bot_id?: string;
}

export const notionAdapter: OAuthProviderAdapter = {
  id: "notion",
  config: {
    id: "notion",
    authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    scopes: [],
    pkce: false,
    tokenAuth: "basic",
    tokenBody: "json",
    extraAuthorizeParams: { owner: "user" },
    clientIdEnv: "NOTION_CLIENT_ID",
    clientSecretEnv: "NOTION_CLIENT_SECRET",
  },
  async onCallback(tokens: NotionTokens) {
    if (!tokens.access_token) throw new Error("notion_no_access_token");
    return {
      secret: { kind: "oauth_tokens", access_token: tokens.access_token } satisfies NotionSecret,
      accountIdentifier: tokens.workspace_name ?? null,
      externalAccountId: tokens.workspace_id ?? null,
      scopes: ["read_content"],
      capabilities: ["pages"],
      expiresAt: null,
      metadata: { bot_id: tokens.bot_id },
      displayName: tokens.workspace_name ? `Notion · ${tokens.workspace_name}` : "Notion",
    };
  },
  async test(secret): Promise<TestResult> {
    const s = secret as NotionSecret;
    const { status, body } = await fetchJson<{ name?: string; bot?: { workspace_name?: string } }>(
      "https://api.notion.com/v1/users/me",
      { headers: { Authorization: `Bearer ${s.access_token}`, "Notion-Version": NOTION_VERSION } },
    );
    if (status !== 200) return { ok: false, error: `notion_users_me_failed:${status}` };
    return { ok: true, accountIdentifier: body?.bot?.workspace_name ?? body?.name ?? null };
  },
};
