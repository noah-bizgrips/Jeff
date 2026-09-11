import type { OAuthProviderConfig, TokenResponse } from "@/lib/integrations/oauth";
import type { SecretBundle } from "@/lib/integrations/store";

export interface CallbackResult {
  secret: SecretBundle;
  accountIdentifier: string | null;
  externalAccountId: string | null;
  scopes: string[];
  capabilities: string[];
  expiresAt: string | null;
  metadata?: Record<string, unknown>;
  displayName?: string;
}

export interface TestResult {
  ok: boolean;
  /** Non-secret identifier to show in the UI (email, workspace name, ...). */
  accountIdentifier?: string | null;
  /** Non-secret details safe to show. */
  details?: Record<string, unknown>;
  error?: string;
  /** Some scopes worked, some did not. */
  limited?: boolean;
}

export interface OAuthProviderAdapter {
  id: string;
  config: OAuthProviderConfig;
  /** Custom code exchange when the provider deviates from RFC form posts. */
  exchange?: (code: string, verifier?: string) => Promise<TokenResponse>;
  onCallback(tokens: TokenResponse): Promise<CallbackResult>;
  test(secret: SecretBundle, connectionId: string): Promise<TestResult>;
}

export function expiresAtFrom(expiresIn: unknown): string | null {
  const n = typeof expiresIn === "number" ? expiresIn : Number(expiresIn);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(Date.now() + n * 1000).toISOString();
}

export async function fetchJson<T = Record<string, unknown>>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ status: number; body: T | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 10000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    let body: T | null = null;
    try {
      body = (await res.json()) as T;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}
