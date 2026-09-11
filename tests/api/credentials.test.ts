import { describe, expect, it, vi, beforeEach } from "vitest";
import { fakeSupabase, jsonReq, OWNER_ID, type Claims } from "../helpers";

let claims: Claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal2" };
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeSupabase(claims) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

const stored: { secret?: Record<string, unknown> }[] = [];
vi.mock("@/lib/integrations/store", () => ({
  upsertConnection: vi.fn(async (input: { secret?: Record<string, unknown> }) => {
    stored.push({ secret: input.secret });
    return { id: "33333333-3333-4333-8333-333333333333", provider: "x", displayName: "x", status: "testing", accessMode: "read", scopes: [], capabilities: [], accountIdentifier: null, lastTestAt: null, lastTestOk: null, lastError: null, lastSyncAt: null, createdAt: "", updatedAt: "", metadata: {} };
  }),
  setConnectionStatus: vi.fn(async () => {}),
  getConnection: vi.fn(async () => null),
  findConnectionByProvider: vi.fn(async () => null),
}));
vi.mock("@/lib/integrations/providers/plaid", () => ({
  exchangePublicToken: vi.fn(async () => ({ accessToken: "access-sandbox-0123456789abcdef-0123-4567-89ab-cdef01234567", itemId: "item-1" })),
  testPlaid: vi.fn(async () => ({ ok: true, accountIdentifier: "Test Bank", details: { accounts: [{ name: "Checking", mask: "1234" }] } })),
  plaidEnv: () => "sandbox",
  createLinkToken: vi.fn(async () => "link-sandbox-0123456789abcdef-0123-4567-89ab-cdef01234567"),
}));
vi.mock("@/lib/integrations/providers/stripe", () => ({
  isRestrictedKey: (v: string) => /^rk_(live|test)_[A-Za-z0-9]{16,}$/.test(v),
  testStripe: vi.fn(async () => ({ ok: true, accountIdentifier: "Acme", details: { customers: true } })),
}));

const plaidExchange = await import("@/app/api/plaid/exchange/route");
const stripeConnect = await import("@/app/api/integrations/stripe/connect/route");

describe("credential endpoints never return plaintext credentials", () => {
  beforeEach(() => {
    stored.length = 0;
    claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal2" };
  });

  it("Plaid exchange response contains no access token", async () => {
    const r = await plaidExchange.POST(jsonReq("/api/plaid/exchange", { publicToken: "public-sandbox-0123456789abcdef-0123-4567-89ab-cdef01234567", institution: { name: "Test Bank" } }), { params: Promise.resolve({}) });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).not.toMatch(/access-sandbox/);
    expect(text).not.toMatch(/public-sandbox/);
    expect(JSON.parse(text)).toMatchObject({ ok: true });
    expect(stored[0]?.secret).toMatchObject({ kind: "plaid_access_token" });
  });

  it("Stripe connect never echoes the key and refuses secret keys", async () => {
    const key = "rk_test_" + "Q".repeat(24);
    const r = await stripeConnect.POST(jsonReq("/api/integrations/stripe/connect", { restrictedKey: key }), { params: Promise.resolve({}) });
    expect(r.status).toBe(200);
    expect(await r.text()).not.toContain(key);
    const bad = await stripeConnect.POST(jsonReq("/api/integrations/stripe/connect", { restrictedKey: "sk_live_" + "Q".repeat(24) }), { params: Promise.resolve({}) });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "restricted_key_required" });
  });

  it("aal1 owner is rejected by credential endpoints", async () => {
    claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal1" };
    const r = await plaidExchange.POST(jsonReq("/api/plaid/exchange", { publicToken: "public-sandbox-0123456789abcdef-0123-4567-89ab-cdef01234567" }), { params: Promise.resolve({}) });
    expect(r.status).toBe(403);
    expect(stored).toHaveLength(0);
  });

  it("unauthenticated caller is rejected", async () => {
    claims = null;
    const r = await stripeConnect.POST(jsonReq("/api/integrations/stripe/connect", { restrictedKey: "rk_test_" + "Q".repeat(24) }), { params: Promise.resolve({}) });
    expect(r.status).toBe(401);
  });
});
