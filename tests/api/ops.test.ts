import { describe, expect, it, vi, beforeEach } from "vitest";
import { fakeSupabase, jsonReq, OWNER_ID, req, type Claims } from "../helpers";

let claims: Claims = null;
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeSupabase(claims) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

const listAlerts = vi.fn(async () => [{ id: "a1", importance: "urgent", status: "open", kind: "finding", title: "x" }]);
const runAlertsForOwner = vi.fn(async () => ({ candidates: 1, created: 1, updated: 0, resolved: 0, skippedByCooldown: 0, suppressedByRules: 0 }));
const updateAlert = vi.fn(async (_o: string, id: string, a: { action: string }) => ({ id, status: a.action === "snooze" ? "snoozed" : "acknowledged" }));
const getAlert = vi.fn(async () => ({ id: "11111111-1111-4111-8111-111111111111", kind: "finding", ref_id: "f1", title: "x" }));
vi.mock("@/lib/gomez/alerts/store", () => ({ listAlerts, runAlertsForOwner, updateAlert, getAlert, surfacedAlerts: vi.fn(async () => []) }));

const updateSettings = vi.fn(async (_o: string, raw: unknown) => {
  const r = raw as Record<string, unknown>;
  if ("mfa_required" in r) return { ok: false as const, reason: "unknown key" };
  return { ok: true as const, settings: { timezone: "America/Denver" }, changed: Object.keys(r) };
});
vi.mock("@/lib/gomez/settings-store", () => ({ getSettings: vi.fn(async () => ({ timezone: "America/Denver" })), updateSettings }));

const generateDueBriefings = vi.fn(async () => ({ generated: ["daily"], skipped: [] }));
vi.mock("@/lib/gomez/briefings", () => ({ generateDueBriefings, listBriefings: vi.fn(async () => []), generateBriefing: vi.fn(async () => ({ briefing: { id: "b1" }, created: true, usedModel: false })) }));
vi.mock("@/lib/gomez/outcomes-store", () => ({ measureOutcomes: vi.fn(async () => ({ measured: 0, pending: 0 })) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { user_id: OWNER_ID } }) }) }) }) }) }));

process.env.CRON_SECRET = "test-cron-secret-value";

const alerts = await import("@/app/api/alerts/route");
const alertById = await import("@/app/api/alerts/[id]/route");
const settings = await import("@/app/api/settings/route");
const cron = await import("@/app/api/cron/briefings/route");
const generate = await import("@/app/api/briefings/generate/route");

const ctx = { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) };

describe("alerts / settings / briefings routes", () => {
  beforeEach(() => {
    claims = null;
    updateSettings.mockClear();
  });
  it("reject unauthenticated and aal1", async () => {
    expect((await alerts.GET(req("/api/alerts"), ctx)).status).toBe(401);
    expect((await settings.PATCH(jsonReq("/api/settings", { daily_brief_time: "08:00" }, { method: "PATCH" }), ctx)).status).toBe(401);
    claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal1" };
    expect((await alerts.GET(req("/api/alerts"), ctx)).status).toBe(403);
    expect((await generate.POST(jsonReq("/api/briefings/generate", { kind: "daily" }), ctx)).status).toBe(403);
    expect(updateSettings).not.toHaveBeenCalled();
  });
  it("owner at aal2: lists, filters, and updates alerts", async () => {
    claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal2" };
    const r = await alerts.GET(req("/api/alerts?importance=urgent,important&status=open"), ctx);
    expect(r.status).toBe(200);
    expect(listAlerts).toHaveBeenCalledWith(OWNER_ID, expect.objectContaining({ importance: ["urgent", "important"], status: ["open"] }));
    expect((await alerts.GET(req("/api/alerts?importance=bogus"), ctx)).status).toBe(400);
    const s = await alertById.PATCH(jsonReq("/api/alerts/x", { action: "snooze", hours: 4 }, { method: "PATCH" }), ctx);
    expect(s.status).toBe(200);
    expect(updateAlert).toHaveBeenCalledWith(OWNER_ID, "11111111-1111-4111-8111-111111111111", expect.objectContaining({ action: "snooze" }), expect.any(Date));
    expect((await alertById.PATCH(jsonReq("/api/alerts/x", { action: "explode" }, { method: "PATCH" }), ctx)).status).toBe(400);
  });
  it("settings accept Tier-1 keys and reject anything else", async () => {
    claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal2" };
    const ok = await settings.PATCH(jsonReq("/api/settings", { daily_brief_time: "08:00" }, { method: "PATCH" }), ctx);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ changed: ["daily_brief_time"] });
    const bad = await settings.PATCH(jsonReq("/api/settings", { mfa_required: false }, { method: "PATCH" }), ctx);
    expect(bad.status).toBe(400);
  });
  it("briefings cron requires the bearer secret", async () => {
    expect((await cron.GET(req("/api/cron/briefings", { sameOrigin: false }), ctx)).status).toBe(401);
    expect((await cron.GET(req("/api/cron/briefings", { sameOrigin: false, headers: { authorization: "Bearer nope" } }), ctx)).status).toBe(401);
    const ok = await cron.GET(req("/api/cron/briefings", { sameOrigin: false, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }), ctx);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, briefings: { generated: ["daily"] } });
    expect(generateDueBriefings).toHaveBeenCalledWith(OWNER_ID, expect.any(Date));
  });
});
