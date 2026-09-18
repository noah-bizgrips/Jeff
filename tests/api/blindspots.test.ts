import { describe, expect, it, vi, beforeEach } from "vitest";
import { fakeSupabase, OWNER_ID, req, type Claims } from "../helpers";

let claims: Claims = null;
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeSupabase(claims) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
const recordAttention = vi.fn(async (_owner: string, signals: unknown[]) => signals.length);
vi.mock("@/lib/gomez/attention/store", () => ({ recordAttention, listAttention: vi.fn(async () => []) }));
const runBlindSpotsForOwner = vi.fn(async () => ({ ran: true, candidates: 3, excludedByRules: 1, created: 2, updated: 0, resolved: 1, deferredByCap: 0, usedModel: false, pushed: false, errors: [] }));
vi.mock("@/lib/gomez/blindspots", () => ({ runBlindSpotsForOwner }));

const attention = await import("@/app/api/attention/route");
const run = await import("@/app/api/blindspots/run/route");

function beacon(body: unknown) {
  // sendBeacon-style: text body without a JSON content type
  return req("/api/attention", { method: "POST", body: JSON.stringify(body) });
}

describe("POST /api/attention", () => {
  beforeEach(() => {
    claims = null;
    recordAttention.mockClear();
  });
  it("rejects unauthenticated and aal1", async () => {
    expect((await attention.POST(beacon({ signals: [{ kind: "page_viewed", path: "/goals" }] }), { params: Promise.resolve({}) })).status).toBe(401);
    claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal1" };
    expect((await attention.POST(beacon({ signals: [{ kind: "page_viewed", path: "/goals" }] }), { params: Promise.resolve({}) })).status).toBe(403);
    expect(recordAttention).not.toHaveBeenCalled();
  });
  it("records a valid batch for the aal2 owner and validates kinds/paths", async () => {
    claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal2" };
    const ok = await attention.POST(beacon({ signals: [{ kind: "finding_viewed", ref_id: "f1" }, { kind: "page_viewed", path: "/alerts" }] }), { params: Promise.resolve({}) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, recorded: 2 });
    expect(recordAttention).toHaveBeenCalledWith(OWNER_ID, [{ kind: "finding_viewed", ref_id: "f1" }, { kind: "page_viewed", path: "/alerts" }]);
    expect((await attention.POST(beacon({ signals: [{ kind: "hacked", ref_id: "x" }] }), { params: Promise.resolve({}) })).status).toBe(400);
    expect((await attention.POST(beacon({ signals: [{ kind: "page_viewed", path: "https://evil.example/x" }] }), { params: Promise.resolve({}) })).status).toBe(400);
    expect((await attention.POST(req("/api/attention", { method: "POST", body: "not json" }), { params: Promise.resolve({}) })).status).toBe(400);
  });
});

describe("POST /api/blindspots/run", () => {
  beforeEach(() => {
    claims = null;
    runBlindSpotsForOwner.mockClear();
  });
  it("rejects unauthenticated and aal1", async () => {
    expect((await run.POST(req("/api/blindspots/run", { method: "POST" }), { params: Promise.resolve({}) })).status).toBe(401);
    claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal1" };
    expect((await run.POST(req("/api/blindspots/run", { method: "POST" }), { params: Promise.resolve({}) })).status).toBe(403);
    expect(runBlindSpotsForOwner).not.toHaveBeenCalled();
  });
  it("forces a run for the aal2 owner and returns counts only", async () => {
    claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal2" };
    const r = await run.POST(req("/api/blindspots/run", { method: "POST" }), { params: Promise.resolve({}) });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ran: true, candidates: 3, created: 2 });
    expect(runBlindSpotsForOwner).toHaveBeenCalledWith(OWNER_ID, expect.any(Date), { force: true });
  });
});
