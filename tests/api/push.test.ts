import { describe, expect, it, vi, beforeEach } from "vitest";
import { fakeSupabase, jsonReq, req, OWNER_ID, type Claims } from "../helpers";

let claims: Claims = null;
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeSupabase(claims) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

const upserted: Record<string, unknown>[] = [];
const deleted: string[] = [];
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      upsert: async (row: Record<string, unknown>) => {
        upserted.push(row);
        return { error: null };
      },
      delete: () => ({ eq: () => ({ eq: async (_c: string, v: string) => (deleted.push(v), { error: null }) }) }),
      select: () => ({ eq: async () => ({ data: [{ endpoint: "https://push.example/1", device_label: "iPhone", created_at: "2026-09-12T00:00:00Z", last_used_at: null, disabled_at: null }] }) }),
    }),
  }),
}));
const sendPush = vi.fn(async () => ({ attempted: 1, delivered: 1, disabled: 0, failed: 0 }));
vi.mock("@/lib/gomez/push/send", () => ({ sendPush, pushConfigured: () => true }));

const subscribe = await import("@/app/api/push/subscribe/route");
const status = await import("@/app/api/push/status/route");
const test = await import("@/app/api/push/test/route");
const ctx = { params: Promise.resolve({}) };

const validSub = { endpoint: "https://push.example/1", keys: { p256dh: "p".repeat(40), auth: "a".repeat(16) }, expirationTime: null };

describe("push routes", () => {
  beforeEach(() => {
    claims = null;
    upserted.length = 0;
    deleted.length = 0;
  });
  it("reject unauthenticated and aal1 callers", async () => {
    expect((await subscribe.POST(jsonReq("/api/push/subscribe", { subscription: validSub }), ctx)).status).toBe(401);
    claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal1" };
    expect((await subscribe.POST(jsonReq("/api/push/subscribe", { subscription: validSub }), ctx)).status).toBe(403);
    expect((await status.GET(req("/api/push/status"), ctx)).status).toBe(403);
    expect((await test.POST(jsonReq("/api/push/test", {}), ctx)).status).toBe(403);
    expect(upserted).toHaveLength(0);
  });
  it("owner subscribes (upsert by endpoint), reads status, tests, and unsubscribes", async () => {
    claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal2" };
    const r = await subscribe.POST(jsonReq("/api/push/subscribe", { subscription: validSub, deviceLabel: "iPhone" }), ctx);
    expect(r.status).toBe(200);
    expect(upserted[0]).toMatchObject({ owner_id: OWNER_ID, endpoint: validSub.endpoint, p256dh: validSub.keys.p256dh, device_label: "iPhone", disabled_at: null });
    const s = await status.GET(req(`/api/push/status?endpoint=${encodeURIComponent(validSub.endpoint)}`), ctx);
    const body = (await s.json()) as { devices: number; thisDevice: boolean; list: unknown[] };
    expect(body).toMatchObject({ devices: 1, thisDevice: true });
    expect(JSON.stringify(body)).not.toContain("p256dh");
    const t = await test.POST(jsonReq("/api/push/test", { endpoint: validSub.endpoint }), ctx);
    expect(t.status).toBe(200);
    expect(sendPush).toHaveBeenCalledWith(OWNER_ID, expect.objectContaining({ url: "/settings" }), { endpoint: validSub.endpoint });
    const d = await subscribe.DELETE(jsonReq("/api/push/subscribe", { endpoint: validSub.endpoint }, { method: "DELETE" }), ctx);
    expect(d.status).toBe(200);
    expect(deleted).toEqual([validSub.endpoint]);
  });
  it("rejects non-https endpoints and malformed keys", async () => {
    claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal2" };
    expect((await subscribe.POST(jsonReq("/api/push/subscribe", { subscription: { ...validSub, endpoint: "http://push.example/1" } }), ctx)).status).toBe(400);
    expect((await subscribe.POST(jsonReq("/api/push/subscribe", { subscription: { endpoint: validSub.endpoint, keys: { p256dh: "x", auth: "y" } } }), ctx)).status).toBe(400);
    expect(upserted).toHaveLength(0);
  });
});
