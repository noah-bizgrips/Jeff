import "server-only";
import { createHmac, randomBytes, createHash } from "node:crypto";
import { cookies } from "next/headers";
import { safeEqual } from "@/lib/crypto/secrets";
import { publicEnv, requireEnv } from "@/lib/env";

/**
 * OAuth state handling shared by all providers.
 *
 * The state is a random nonce. It is bound to the browser via an HttpOnly,
 * Secure, SameSite=Lax cookie whose payload (provider, nonce, PKCE verifier,
 * issued-at) is HMAC-signed with a key derived from the app encryption key.
 * The callback verifies both the signature and that `state` matches.
 */

const STATE_TTL_SECONDS = 600;

export interface OAuthProviderConfig {
  id: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Query parameter name for scopes and delimiter. */
  scopeParam?: string;
  scopeDelimiter?: string;
  pkce: boolean;
  /** How to send client credentials on token exchange. */
  tokenAuth: "body" | "basic";
  extraAuthorizeParams?: Record<string, string>;
  clientIdEnv: string;
  clientSecretEnv: string;
  /** Extra headers on token exchange (e.g. Notion-Version). */
  tokenHeaders?: Record<string, string>;
  /** Token endpoint content type. */
  tokenBody?: "form" | "json";
}

interface StatePayload {
  p: string; // provider
  n: string; // nonce (state)
  v?: string; // pkce verifier
  t: number; // issued at (epoch seconds)
}

function stateKey(): Buffer {
  // Derive a distinct key for state signing so the encryption key is never used directly.
  const master = Buffer.from(requireEnv("JEFF_CREDENTIAL_ENCRYPTION_KEY").trim(), "base64");
  return createHmac("sha256", master).update("jeff:oauth-state:v1").digest();
}

function sign(payload: string): string {
  return createHmac("sha256", stateKey()).update(payload).digest("base64url");
}

export function b64url(buf: Buffer) {
  return buf.toString("base64url");
}

export function redirectUri(providerId: string): string {
  return `${publicEnv().appUrl.replace(/\/$/, "")}/api/oauth/${providerId}/callback`;
}

function cookieName(providerId: string) {
  return `jeff_oauth_${providerId}`;
}

export interface StartResult {
  url: string;
  cookie: { name: string; value: string; maxAge: number };
}

/** Builds the authorization URL and the signed state cookie. */
export function buildAuthorizationStart(cfg: OAuthProviderConfig): StartResult {
  const nonce = b64url(randomBytes(24));
  const payload: StatePayload = { p: cfg.id, n: nonce, t: Math.floor(Date.now() / 1000) };
  const url = new URL(cfg.authorizeUrl);
  url.searchParams.set("client_id", requireEnv(cfg.clientIdEnv));
  url.searchParams.set("redirect_uri", redirectUri(cfg.id));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", nonce);
  if (cfg.scopes.length) {
    url.searchParams.set(cfg.scopeParam ?? "scope", cfg.scopes.join(cfg.scopeDelimiter ?? " "));
  }
  if (cfg.pkce) {
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    payload.v = verifier;
  }
  for (const [k, v] of Object.entries(cfg.extraAuthorizeParams ?? {})) url.searchParams.set(k, v);

  const encoded = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const value = `${encoded}.${sign(encoded)}`;
  return { url: url.toString(), cookie: { name: cookieName(cfg.id), value, maxAge: STATE_TTL_SECONDS } };
}

export async function setStateCookie(cookie: StartResult["cookie"]) {
  const store = await cookies();
  store.set(cookie.name, cookie.value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/oauth",
    maxAge: cookie.maxAge,
  });
}

export async function clearStateCookie(providerId: string) {
  const store = await cookies();
  store.set(cookieName(providerId), "", { httpOnly: true, path: "/api/oauth", maxAge: 0 });
}

/**
 * Verifies the signed cookie against the `state` query param.
 * Returns the PKCE verifier (if any) on success, or a reason on failure.
 */
export function verifyState(
  providerId: string,
  cookieValue: string | undefined,
  stateParam: string | null,
): { ok: true; verifier?: string } | { ok: false; reason: string } {
  if (!cookieValue || !stateParam) return { ok: false, reason: "missing_state" };
  const [encoded, sig] = cookieValue.split(".");
  if (!encoded || !sig) return { ok: false, reason: "malformed_state" };
  if (!safeEqual(sign(encoded), sig)) return { ok: false, reason: "bad_signature" };
  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed_state" };
  }
  if (payload.p !== providerId) return { ok: false, reason: "provider_mismatch" };
  if (!safeEqual(payload.n, stateParam)) return { ok: false, reason: "state_mismatch" };
  if (Math.floor(Date.now() / 1000) - payload.t > STATE_TTL_SECONDS) return { ok: false, reason: "state_expired" };
  return { ok: true, verifier: payload.v };
}

export interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  [key: string]: unknown;
}

/** Exchanges an authorization code for tokens. Never logs the response. */
export async function exchangeCode(cfg: OAuthProviderConfig, code: string, verifier?: string): Promise<TokenResponse> {
  const clientId = requireEnv(cfg.clientIdEnv);
  const clientSecret = requireEnv(cfg.clientSecretEnv);
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(cfg.id),
  };
  if (verifier) params.code_verifier = verifier;
  const headers: Record<string, string> = { Accept: "application/json", ...(cfg.tokenHeaders ?? {}) };
  if (cfg.tokenAuth === "basic") {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  } else {
    params.client_id = clientId;
    params.client_secret = clientSecret;
  }
  let body: string;
  if (cfg.tokenBody === "json") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(params);
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(params).toString();
  }
  const res = await fetch(cfg.tokenUrl, { method: "POST", headers, body, cache: "no-store" });
  if (!res.ok) throw new Error(`token_exchange_failed:${res.status}`);
  const json = (await res.json()) as TokenResponse;
  if (typeof json.access_token !== "string" && !(json as { ok?: boolean }).ok) {
    throw new Error("token_exchange_invalid_response");
  }
  return json;
}

/** Refreshes an access token using a refresh token (providers that support it). */
export async function refreshAccessToken(cfg: OAuthProviderConfig, refreshToken: string): Promise<TokenResponse> {
  const clientId = requireEnv(cfg.clientIdEnv);
  const clientSecret = requireEnv(cfg.clientSecretEnv);
  const params: Record<string, string> = { grant_type: "refresh_token", refresh_token: refreshToken };
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
    ...(cfg.tokenHeaders ?? {}),
  };
  if (cfg.tokenAuth === "basic") {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  } else {
    params.client_id = clientId;
    params.client_secret = clientSecret;
  }
  const res = await fetch(cfg.tokenUrl, { method: "POST", headers, body: new URLSearchParams(params), cache: "no-store" });
  if (!res.ok) throw new Error(`token_refresh_failed:${res.status}`);
  return (await res.json()) as TokenResponse;
}
