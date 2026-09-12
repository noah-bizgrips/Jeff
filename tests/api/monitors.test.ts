import { describe, expect, it, vi, beforeEach } from "vitest";
import { fakeSupabase, OWNER_ID, req, type Claims } from "../helpers";

let claims: Claims = null;
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeSupabase(claims) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
const runMonitorsForOwner = vi.fn(async () => ({ rows: 10, candidates: 2, created: 1, updated: 1, resolved: 0, errors: [] }));
vi.mock("@/lib/jeff/monitors", () => ({ runMonitorsForOwner, MONITORS: [] }));

const route = await import("@/app/api/monitors/run/route");

describe("POST /api/monitors/run", () => {
  beforeEach(() => {
    claims = null;
    runMonitorsForOwner.mockClear();
  });
  it("rejects unauthenticated", async () => {
    const r = await route.POST(req("/api/monitors/run", { method: "POST" }), { params: Promise.resolve({}) });
    expect(r.status).toBe(401);
    expect(runMonitorsForOwner).not.toHaveBeenCalled();
  });
  it("rejects owner at aal1", async () => {
    claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal1" };
    const r = await route.POST(req("/api/monitors/run", { method: "POST" }), { params: Promise.resolve({}) });
    expect(r.status).toBe(403);
  });
  it("runs for the aal2 owner and returns counts only", async () => {
    claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal2" };
    const r = await route.POST(req("/api/monitors/run", { method: "POST" }), { params: Promise.resolve({}) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ rows: 10, candidates: 2, created: 1, updated: 1, resolved: 0, errors: [] });
    expect(runMonitorsForOwner).toHaveBeenCalledWith(OWNER_ID);
  });
});
