import { describe, expect, it, vi, beforeEach } from "vitest";
import { fakeSupabase, jsonReq, OWNER_ID, req, type Claims } from "../helpers";

let claims: Claims = null;
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeSupabase(claims) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { user_id: OWNER_ID } }) }) }) }) }) }));

const GROUP_ID = "33333333-3333-4333-8333-333333333333";
const group = { id: GROUP_ID, group_key: "client:c1:delivery", entity_kind: "client", entity_name: "Pure Bath of Michigan", issue_kind: "delivery", title: "Pure Bath of Michigan — 6 overdue portal tasks", status: "open", importance: "important", alert_id: "a-parent", member_count: 3, members: [{ id: "m1", member_kind: "obligation", member_id: "o1", title: "CRM access", detail: { days_overdue: 19, owner: "Client", status: "waiting_on_other" } }] };
const listAlertGroups = vi.fn(async () => [group]);
const getAlertGroup = vi.fn(async (_o: string, id: string) => (id === GROUP_ID ? group : null));
const updateAlertGroup = vi.fn(async (_o: string, id: string, a: { action: string; until?: string }) => ({ ...group, id, status: a.action === "snooze" ? "snoozed" : a.action === "dismiss" ? "dismissed" : a.action === "reopen" ? "open" : "acknowledged", snoozed_until: a.until ?? null }));
const draftGroupMission = vi.fn(async (_o: string, g: typeof group, kind: string) => ({ id: "m-1", code: "M-0007", title: kind === "remind_client" ? `Draft reminder for ${g.entity_name}` : `Prepare action: ${g.title}` }));
const syncAlertGroups = vi.fn(async () => ({ groups: 1, created: 0, updated: 1, reopened: 0, resolved: 0, membersGrouped: 0, interpreted: 0 }));
vi.mock("@/lib/jeff/grouping/store", () => ({ listAlertGroups, getAlertGroup, updateAlertGroup, draftGroupMission, syncAlertGroups }));

const listAlerts = vi.fn(async () => [{ id: "a-parent", kind: "group", importance: "important", status: "open", title: group.title, ref_id: GROUP_ID, occurrences: 3 }]);
vi.mock("@/lib/jeff/alerts/store", () => ({ listAlerts, runAlertsForOwner: vi.fn(async () => ({})), updateAlert: vi.fn(), getAlert: vi.fn(), surfacedAlerts: vi.fn(async () => []) }));

const list = await import("@/app/api/alert-groups/route");
const byId = await import("@/app/api/alert-groups/[id]/route");
const alerts = await import("@/app/api/alerts/route");

const ctx = { params: Promise.resolve({ id: GROUP_ID }) };

describe("alert-groups routes", () => {
  beforeEach(() => {
    claims = null;
    updateAlertGroup.mockClear();
    draftGroupMission.mockClear();
  });
  it("reject unauthenticated and aal1", async () => {
    expect((await list.GET(req("/api/alert-groups"), ctx)).status).toBe(401);
    expect((await byId.PATCH(jsonReq("/api/alert-groups/x", { action: "dismiss" }, { method: "PATCH" }), ctx)).status).toBe(401);
    claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal1" };
    expect((await list.GET(req("/api/alert-groups"), ctx)).status).toBe(403);
    expect((await byId.GET(req(`/api/alert-groups/${GROUP_ID}`), ctx)).status).toBe(403);
    expect(updateAlertGroup).not.toHaveBeenCalled();
  });
  it("owner at aal2: lists groups with members, filters by status, rejects bad filters", async () => {
    claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal2" };
    const r = await list.GET(req("/api/alert-groups?status=open,acknowledged"), ctx);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { groups: (typeof group)[] };
    expect(body.groups[0]!.members[0]!.detail).toMatchObject({ days_overdue: 19, owner: "Client" });
    expect(listAlertGroups).toHaveBeenCalledWith(OWNER_ID, expect.objectContaining({ status: ["open", "acknowledged"] }));
    expect((await list.GET(req("/api/alert-groups?status=bogus"), ctx)).status).toBe(400);
    expect((await list.POST(req("/api/alert-groups", { method: "POST" }), ctx)).status).toBe(200);
    expect(syncAlertGroups).toHaveBeenCalledWith(OWNER_ID);
  });
  it("GET by id returns the group; unknown ids 404; malformed ids 400", async () => {
    claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal2" };
    const r = await byId.GET(req(`/api/alert-groups/${GROUP_ID}`), ctx);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { group: { title: string } }).group.title).toBe(group.title);
    expect((await byId.GET(req("/api/alert-groups/x"), { params: Promise.resolve({ id: "44444444-4444-4444-8444-444444444444" }) })).status).toBe(404);
    expect((await byId.GET(req("/api/alert-groups/x"), { params: Promise.resolve({ id: "nope" }) })).status).toBe(400);
  });
  it("lifecycle actions go through updateAlertGroup with a computed snooze time", async () => {
    claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal2" };
    const s = await byId.PATCH(jsonReq("/api/alert-groups/x", { action: "snooze", hours: 4 }, { method: "PATCH" }), ctx);
    expect(s.status).toBe(200);
    expect(updateAlertGroup).toHaveBeenCalledWith(OWNER_ID, GROUP_ID, expect.objectContaining({ action: "snooze", until: expect.any(String) }), expect.any(Date));
    expect(((await s.json()) as { group: { status: string } }).group.status).toBe("snoozed");
    for (const action of ["acknowledge", "dismiss", "reopen"]) expect((await byId.PATCH(jsonReq("/api/alert-groups/x", { action }, { method: "PATCH" }), ctx)).status).toBe(200);
    expect((await byId.PATCH(jsonReq("/api/alert-groups/x", { action: "explode" }, { method: "PATCH" }), ctx)).status).toBe(400);
  });
  it("remind_client and prepare_action only create draft missions (nothing is sent) and never change the group's status", async () => {
    claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal2" };
    const r = await byId.PATCH(jsonReq("/api/alert-groups/x", { action: "remind_client" }, { method: "PATCH" }), ctx);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { group: { status: string }; mission: { code: string; title: string } };
    expect(body.mission).toEqual({ id: "m-1", code: "M-0007", title: "Draft reminder for Pure Bath of Michigan" });
    expect(body.group.status).toBe("open");
    expect(draftGroupMission).toHaveBeenCalledWith(OWNER_ID, expect.objectContaining({ id: GROUP_ID }), "remind_client");
    expect(updateAlertGroup).not.toHaveBeenCalled();
    const p = await byId.PATCH(jsonReq("/api/alert-groups/x", { action: "prepare_action" }, { method: "PATCH" }), ctx);
    expect(((await p.json()) as { mission: { title: string } }).mission.title).toMatch(/^Prepare action: /);
  });
  it("GET /api/alerts accepts the group kind and grouped status filters", async () => {
    claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal2" };
    const r = await alerts.GET(req("/api/alerts?kind=group,obligation&status=grouped,open"), ctx);
    expect(r.status).toBe(200);
    expect(listAlerts).toHaveBeenCalledWith(OWNER_ID, expect.objectContaining({ kind: ["group", "obligation"], status: ["grouped", "open"] }));
  });
});
