import { describe, expect, it, vi, beforeEach } from "vitest";
import { fakeSupabase, jsonReq, OWNER_ID, type Claims } from "../helpers";

let claims: Claims = null;
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeSupabase(claims) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

const upsertConnection = vi.fn(async () => ({ id: "33333333-3333-4333-8333-333333333333", provider: "portal", displayName: "BizGrips Client Portal", status: "testing", accessMode: "read", scopes: [], capabilities: ["clients", "tasks", "leads", "notifications"], accountIdentifier: null, lastTestAt: null, lastTestOk: null, lastError: null, lastSyncAt: null, createdAt: "", updatedAt: "", metadata: {} }));
vi.mock("@/lib/integrations/store", () => ({
  upsertConnection,
  getConnection: vi.fn(async () => ({ id: "33333333-3333-4333-8333-333333333333", provider: "portal", status: "connected", metadata: {} })),
  findConnectionByProvider: vi.fn(async () => null),
  setConnectionStatus: vi.fn(async () => {}),
  readSecret: vi.fn(async () => null),
  writeSecret: vi.fn(async () => {}),
}));
const runConnectionTest = vi.fn(async () => ({ ok: true, accountIdentifier: "portal.bizgrips.com", details: { reachable: true } }));
vi.mock("@/lib/integrations/test", () => ({ runConnectionTest }));

const route = await import("@/app/api/integrations/[provider]/test/route");
const { testPortal, fetchPortalExport } = await import("@/lib/integrations/providers/portal");

describe("POST /api/integrations/portal/test", () => {
  beforeEach(() => {
    claims = null;
    process.env.PORTAL_BASE_URL = "https://portal.bizgrips.com";
    process.env.PORTAL_EXPORT_TOKEN = "portal-test-token";
  });
  it("rejects unauthenticated and aal1", async () => {
    expect((await route.POST(jsonReq("/api/integrations/portal/test", {}), { params: Promise.resolve({ provider: "portal" }) })).status).toBe(401);
    claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal1" };
    expect((await route.POST(jsonReq("/api/integrations/portal/test", {}), { params: Promise.resolve({ provider: "portal" }) })).status).toBe(403);
    expect(upsertConnection).not.toHaveBeenCalled();
  });
  it("creates the env-configured connection on first test for the owner", async () => {
    claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal2" };
    const r = await route.POST(jsonReq("/api/integrations/portal/test", {}), { params: Promise.resolve({ provider: "portal" }) });
    expect(r.status).toBe(200);
    expect(upsertConnection).toHaveBeenCalledTimes(1);
    expect(runConnectionTest).toHaveBeenCalledTimes(1);
    const body = await r.json();
    expect(JSON.stringify(body)).not.toContain("portal-test-token");
  });
  it("refuses when the env is missing", async () => {
    claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal2" };
    delete process.env.PORTAL_EXPORT_TOKEN;
    const r = await route.POST(jsonReq("/api/integrations/portal/test", {}), { params: Promise.resolve({ provider: "portal" }) });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: "provider_not_configured", missingEnv: ["PORTAL_EXPORT_TOKEN"] });
  });
});

describe("portal provider client", () => {
  beforeEach(() => {
    process.env.PORTAL_BASE_URL = "https://portal.bizgrips.com/";
    process.env.PORTAL_EXPORT_TOKEN = "portal-test-token";
  });
  it("sends the token in the header, never the query string, and honours since/limit", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: init?.headers as Record<string, string> });
      return new Response(JSON.stringify({ server_time: "2026-09-12T12:00:00Z", since: "x", clients: { truncated: false, rows: [{ id: 1 }] } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const data = await fetchPortalExport("2026-09-01T00:00:00Z", 25, fetchImpl);
    expect(data.server_time).toBe("2026-09-12T12:00:00Z");
    expect(calls[0]!.url).toBe("https://portal.bizgrips.com/api/hooks/jeff-export?since=2026-09-01T00%3A00%3A00Z&limit=25");
    expect(calls[0]!.headers["x-bg-token"]).toBe("portal-test-token");
    expect(calls[0]!.url).not.toContain("token=");
  });
  it("maps 401/503 to clear errors in test()", async () => {
    const r401 = await testPortal((async () => new Response("{}", { status: 401 })) as unknown as typeof fetch);
    expect(r401).toMatchObject({ ok: false, error: "portal_unauthorised" });
    const r503 = await testPortal((async () => new Response("{}", { status: 503 })) as unknown as typeof fetch);
    expect(r503).toMatchObject({ ok: false, error: "portal_export_not_configured" });
    const ok = await testPortal((async () => new Response(JSON.stringify({ server_time: "t", clients: { rows: [{}] } }), { status: 200 })) as unknown as typeof fetch);
    expect(ok).toMatchObject({ ok: true, accountIdentifier: "portal.bizgrips.com" });
  });
});
