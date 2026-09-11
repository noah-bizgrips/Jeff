import "server-only";
import type { OAuthProviderAdapter } from "./base";
import { googleAdapter } from "./google";
import { slackAdapter } from "./slack";
import { notionAdapter } from "./notion";
import { highlevelAdapter } from "./highlevel";
import { metaAdapter } from "./meta";

const OAUTH_ADAPTERS: Record<string, OAuthProviderAdapter> = {
  google: googleAdapter,
  slack: slackAdapter,
  notion: notionAdapter,
  highlevel: highlevelAdapter,
  meta: metaAdapter,
};

export function getOAuthAdapter(id: string): OAuthProviderAdapter | null {
  return OAUTH_ADAPTERS[id] ?? null;
}

export const OAUTH_PROVIDER_IDS = Object.keys(OAUTH_ADAPTERS);
