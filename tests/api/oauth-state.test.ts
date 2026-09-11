import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn(), get: vi.fn(), getAll: vi.fn(() => []) }) }));

const { buildAuthorizationStart, verifyState, exchangeCode } = await import("@/lib/integrations/oauth");

const cfg = {
  id: "google",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes: ["openid", "email"],
  pkce: true,
  tokenAuth: "body" as const,
  clientIdEnv: "GOOGLE_CLIENT_ID",
  clientSecretEnv: "GOOGLE_CLIENT_SECRET",
};

describe("OAuth state", () => {
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";

  it("builds a PKCE authorize URL bound to a signed cookie", () => {
    const start = buildAuthorizationStart(cfg);
    const url = new URL(start.url);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("redirect_uri")).toBe("https://jeff.test/api/oauth/google/callback");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.toString()).not.toContain("test-client-secret");
    const state = url.searchParams.get("state")!;
    const ok = verifyState("google", start.cookie.value, state);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.verifier).toBeTruthy();
  });

  it("rejects a mismatched state", () => {
    const start = buildAuthorizationStart(cfg);
    expect(verifyState("google", start.cookie.value, "not-the-state")).toMatchObject({ ok: false, reason: "state_mismatch" });
  });

  it("rejects a missing cookie / missing state", () => {
    expect(verifyState("google", undefined, "x")).toMatchObject({ ok: false, reason: "missing_state" });
    expect(verifyState("google", "abc.def", null)).toMatchObject({ ok: false, reason: "missing_state" });
  });

  it("rejects a tampered cookie signature", () => {
    const start = buildAuthorizationStart(cfg);
    const [payload] = start.cookie.value.split(".");
    const state = new URL(start.url).searchParams.get("state")!;
    expect(verifyState("google", `${payload}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`, state)).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  it("rejects a cookie issued for another provider", () => {
    const start = buildAuthorizationStart(cfg);
    const state = new URL(start.url).searchParams.get("state")!;
    expect(verifyState("slack", start.cookie.value, state)).toMatchObject({ ok: false, reason: "provider_mismatch" });
  });

  it("never puts the client secret in the URL and sends it only in the token POST body", async () => {
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return new Response(JSON.stringify({ access_token: "ya29.test" }), { status: 200, headers: { "content-type": "application/json" } });
    });
    await exchangeCode(cfg, "the-code", "verifier");
    expect(calls[0]!.url).toBe(cfg.tokenUrl);
    expect(calls[0]!.body).toContain("client_secret=test-client-secret");
    expect(calls[0]!.body).toContain("code_verifier=verifier");
    vi.unstubAllGlobals();
  });
});
