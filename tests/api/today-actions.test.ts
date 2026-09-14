import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, jsonReq, OWNER_ID, OTHER_ID, type Claims } from "../helpers";
import { FakeDb } from "../fake-db";

/**
 * Mission Control → TODAY inline actions. "Done" / "Dismiss" PATCH the
 * Follow-Through obligation when one exists (and the decision is mirrored onto
 * the commitment so TODAY, built from commitments, agrees), otherwise the
 * commitment itself. Nothing is deleted; dismiss never means done.
 */

let claims: Claims = null;
let db = new FakeDb();
const audit = vi.fn(async () => {});

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeSupabase(claims) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => db.client() }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...(a as [])) }));
vi.mock("@/lib/jeff/settings-store", () => ({ getSettings: async () => ({ timezone: "America/Denver", quiet_hours_start: "21:00", quiet_hours_end: "07:00" }) }));

const obligations = await import("@/app/api/obligations/[id]/route");
const commitments = await import("@/app/api/commitments/[id]/route");

const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });
const owner = () => (claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal2" });
const OB = "44444444-4444-4444-8444-444444444444";
const OB_ORPHAN = "44444444-4444-4444-8444-444444444445";
const CM = "55555555-5555-4555-8555-555555555555";
const CM_LONE = "55555555-5555-4555-8555-555555555556";
const PAST = "2026-09-10T00:00:00.000Z";

beforeEach(() => {
  claims = null;
  db = new FakeDb();
  audit.mockClear();
  db.seed("commitments", [
    { id: CM, owner_id: OWNER_ID, fingerprint: "fp-1", action_text: "I'll send the signed contract Thursday.", status: "overdue", direction: "owed_to_me", due_at: PAST, confidence: 0.8 },
    { id: CM_LONE, owner_id: OWNER_ID, fingerprint: "fp-2", action_text: "We'll call you tomorrow.", status: "overdue", direction: "owed_to_me", due_at: PAST, confidence: 0.7 },
  ]);
  db.seed("obligations", [
    { id: OB, owner_id: OWNER_ID, title: "Signed contract", status: "overdue", origin: "commitment", commitment_id: CM, fingerprint: `commitment:${CM}`, metadata: {}, due_at: PAST, assigned_to: "other", scope: "business", priority: "normal", tracking_mode: "persistent", cadence: {}, reminder_count: 0, updated_at: PAST },
    { id: OB_ORPHAN, owner_id: OWNER_ID, title: "Book the venue", status: "open", origin: "manual", commitment_id: null, fingerprint: null, metadata: {}, due_at: null, assigned_to: "me", scope: "personal", priority: "normal", tracking_mode: "once", cadence: {}, reminder_count: 0, updated_at: PAST },
  ]);
});

const commitmentStatus = (id: string) => db.rows("commitments").find((r) => r.id === id)!.status;

describe("TODAY → Done / Dismiss via the Follow-Through obligation", () => {
  it("complete marks the obligation completed and mirrors `done` onto the commitment", async () => {
    owner();
    const res = await obligations.PATCH(jsonReq(`/api/obligations/${OB}`, { action: "complete" }, { method: "PATCH" }), params({ id: OB }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { obligation: { status: string } }).obligation.status).toBe("completed");
    expect(commitmentStatus(CM)).toBe("done");
    expect(commitmentStatus(CM_LONE)).toBe("overdue");
    expect(db.rows("obligation_events").filter((e) => e.obligation_id === OB).map((e) => e.kind)).toEqual(["completed"]);
  });
  it("dismiss stops tracking, mirrors `dismissed` (never `done`), and reopen brings both back", async () => {
    owner();
    await obligations.PATCH(jsonReq(`/api/obligations/${OB}`, { action: "dismiss" }, { method: "PATCH" }), params({ id: OB }));
    expect(db.rows("obligations").find((o) => o.id === OB)!.status).toBe("dismissed");
    expect(commitmentStatus(CM)).toBe("dismissed");
    await obligations.PATCH(jsonReq(`/api/obligations/${OB}`, { action: "reopen" }, { method: "PATCH" }), params({ id: OB }));
    expect(db.rows("obligations").find((o) => o.id === OB)!.status).toBe("waiting_on_other");
    expect(commitmentStatus(CM)).toBe("open");
    expect(db.writesTo("commitments", "delete")).toHaveLength(0);
    expect(db.writesTo("obligations", "delete")).toHaveLength(0);
  });
  it("an obligation without a commitment touches no commitment row", async () => {
    owner();
    await obligations.PATCH(jsonReq(`/api/obligations/${OB_ORPHAN}`, { action: "complete" }, { method: "PATCH" }), params({ id: OB_ORPHAN }));
    expect(db.writesTo("commitments")).toHaveLength(0);
  });
});

describe("TODAY → Done / Dismiss on a commitment with no obligation", () => {
  it("PATCHes the commitment directly and audits it", async () => {
    owner();
    const done = await commitments.PATCH(jsonReq(`/api/commitments/${CM_LONE}`, { status: "done" }, { method: "PATCH" }), params({ id: CM_LONE }));
    expect(done.status).toBe(200);
    expect(commitmentStatus(CM_LONE)).toBe("done");
    const dismissed = await commitments.PATCH(jsonReq(`/api/commitments/${CM}`, { status: "dismissed" }, { method: "PATCH" }), params({ id: CM }));
    expect(dismissed.status).toBe(200);
    expect(commitmentStatus(CM)).toBe("dismissed");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: "commitment_updated", metadata: { status: "dismissed" } }));
  });
  it("requires the owner at aal2 and rejects unknown statuses", async () => {
    expect((await commitments.PATCH(jsonReq(`/api/commitments/${CM}`, { status: "done" }, { method: "PATCH" }), params({ id: CM }))).status).toBe(401);
    claims = { sub: OTHER_ID, email: "other@example.com", aal: "aal2" };
    expect((await commitments.PATCH(jsonReq(`/api/commitments/${CM}`, { status: "done" }, { method: "PATCH" }), params({ id: CM }))).status).toBe(403);
    owner();
    expect((await commitments.PATCH(jsonReq(`/api/commitments/${CM}`, { status: "deleted" }, { method: "PATCH" }), params({ id: CM }))).status).toBe(400);
    expect(commitmentStatus(CM)).toBe("overdue");
  });
});
