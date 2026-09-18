import { describe, expect, it, vi, beforeEach } from "vitest";
import { fakeSupabase, jsonReq, OWNER_ID, req, type Claims } from "../helpers";

let claims: Claims = null;
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeSupabase(claims) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

const syncConnection = vi.fn(async () => ({ connectionId: "c1", provider: "google", results: [{ capability: "gmail", seen: 3, upserted: 3 }] }));
const syncAllForOwner = vi.fn(async () => []);
vi.mock("@/lib/integrations/sync/runner", () => ({
  hasSyncAdapter: (p: string) => p === "google",
  syncConnection,
  syncAllForOwner,
}));
vi.mock("@/lib/integrations/store", () => ({
  getConnection: vi.fn(async () => null),
  findConnectionByProvider: vi.fn(async (_o: string, provider: string) =>
    provider === "google"
      ? { id: "33333333-3333-4333-8333-333333333333", provider: "google", displayName: "Google", status: "connected", accessMode: "read", scopes: [], capabilities: ["gmail"], accountIdentifier: null, lastTestAt: null, lastTestOk: true, lastError: null, lastSyncAt: null, createdAt: "", updatedAt: "", metadata: {} }
      : null,
  ),
}));
vi.mock("@/lib/gomez/blindspots", () => ({ runBlindSpotsForOwner: vi.fn(async () => ({ ran: false, reason: "not_due", candidates: 0, excludedByRules: 0, created: 0, updated: 0, resolved: 0, deferredByCap: 0, usedModel: false, pushed: false, errors: [] })) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { user_id: OWNER_ID } }) }) }) }) }),
}));

const syncRoute = await import("@/app/api/sync/[provider]/route");
const cronRoute = await import("@/app/api/cron/sync/route");

describe("POST /api/sync/{provider}", () => {
  beforeEach(() => (claims = null));
  it("rejects unauthenticated", async () => {
    const r = await syncRoute.POST(jsonReq("/api/sync/google", {}), { params: Promise.resolve({ provider: "google" }) });
    expect(r.status).toBe(401);
    expect(syncConnection).not.toHaveBeenCalled();
  });
  it("rejects owner at aal1", async () => {
    claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal1" };
    const r = await syncRoute.POST(jsonReq("/api/sync/google", {}), { params: Promise.resolve({ provider: "google" }) });
    expect(r.status).toBe(403);
  });
  it("rejects providers without an adapter", async () => {
    claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal2" };
    const r = await syncRoute.POST(jsonReq("/api/sync/slack", {}), { params: Promise.resolve({ provider: "slack" }) });
    expect(r.status).toBe(404);
  });
  it("runs a sync for the owner at aal2 and returns counts only", async () => {
    claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal2" };
    const r = await syncRoute.POST(jsonReq("/api/sync/google", {}), { params: Promise.resolve({ provider: "google" }) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.results[0]).toEqual({ capability: "gmail", seen: 3, upserted: 3 });
    expect(JSON.stringify(body)).not.toMatch(/token/i);
  });
});

describe("GET /api/cron/sync", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "cron-test-secret-value";
    syncAllForOwner.mockClear();
  });
  it("rejects a missing bearer", async () => {
    const r = await cronRoute.GET(req("/api/cron/sync"), { params: Promise.resolve({}) });
    expect(r.status).toBe(401);
    expect(syncAllForOwner).not.toHaveBeenCalled();
  });
  it("rejects a wrong bearer", async () => {
    const r = await cronRoute.GET(req("/api/cron/sync", { headers: { authorization: "Bearer nope" } }), { params: Promise.resolve({}) });
    expect(r.status).toBe(401);
  });
  it("runs with the correct bearer", async () => {
    const r = await cronRoute.GET(req("/api/cron/sync", { headers: { authorization: "Bearer cron-test-secret-value" } }), { params: Promise.resolve({}) });
    expect(r.status).toBe(200);
    expect(syncAllForOwner).toHaveBeenCalledWith(OWNER_ID, "schedule");
  });
  it("is 503 when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    const r = await cronRoute.GET(req("/api/cron/sync", { headers: { authorization: "Bearer x" } }), { params: Promise.resolve({}) });
    expect(r.status).toBe(503);
  });
});
