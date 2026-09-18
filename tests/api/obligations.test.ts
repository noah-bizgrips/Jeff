import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, jsonReq, OWNER_ID, OTHER_ID, req, type Claims } from "../helpers";
import { FakeDb } from "../fake-db";

let claims: Claims = null;
let db = new FakeDb();
const audit = vi.fn(async () => {});

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeSupabase(claims) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => db.client() }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...(a as [])) }));
vi.mock("@/lib/gomez/settings-store", () => ({ getSettings: async () => ({ timezone: "America/Denver", quiet_hours_start: "21:00", quiet_hours_end: "07:00" }) }));

const list = await import("@/app/api/obligations/route");
const detail = await import("@/app/api/obligations/[id]/route");

const params = (p: Record<string, string> = {}) => ({ params: Promise.resolve(p) });
const owner = () => (claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal2" });
const ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  claims = null;
  db = new FakeDb();
  audit.mockClear();
});

describe("auth: every obligations route requires the owner at aal2", () => {
  const calls: [string, () => Promise<Response>][] = [
    ["GET /api/obligations", () => list.GET(req("/api/obligations"), params())],
    ["POST /api/obligations", () => list.POST(jsonReq("/api/obligations", { text: "remind me to call Sam tomorrow" }), params())],
    ["GET /api/obligations/id", () => detail.GET(req(`/api/obligations/${ID}`), params({ id: ID }))],
    ["PATCH /api/obligations/id", () => detail.PATCH(jsonReq(`/api/obligations/${ID}`, { action: "complete" }, { method: "PATCH" }), params({ id: ID }))],
  ];
  it("returns 401 anonymous, 403 for another user, 403 at aal1", async () => {
    for (const [name, call] of calls) {
      claims = null;
      expect((await call()).status, `${name} anonymous`).toBe(401);
      claims = { sub: OTHER_ID, email: "other@example.com", aal: "aal2" };
      expect((await call()).status, `${name} other user`).toBe(403);
      claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal1" };
      expect((await call()).status, `${name} aal1`).toBe(403);
    }
    expect(db.rows("obligations")).toHaveLength(0);
  });
});

describe("POST /api/obligations", () => {
  it("creates from natural language, returns the interpretation, and dedupes a repeat", async () => {
    owner();
    const res = await list.POST(jsonReq("/api/obligations", { text: "Remind me to send Sam the proposal tomorrow" }), params());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { created: boolean; obligation: { title: string; bucket: string; status: string; tracking_mode: string }; interpretation: { due_at: string | null; completion_strategy: { kind: string } } };
    expect(body.created).toBe(true);
    expect(body.obligation).toMatchObject({ title: "Send Sam the proposal", status: "open", bucket: "waiting_on_me", tracking_mode: "once" });
    expect(body.interpretation.completion_strategy.kind).toBe("outbound_message");
    expect(body.interpretation.due_at).not.toBeNull();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: "obligation_created" }));
  });

  it("honours explicit scope/tracking overrides and rejects sensitive content", async () => {
    owner();
    const res = await list.POST(jsonReq("/api/obligations", { text: "Pay the Brightline invoice by Friday", tracking_mode: "critical", scope: "financial" }), params());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { obligation: { scope: string; tracking_mode: string } };
    expect(body.obligation).toMatchObject({ scope: "financial", tracking_mode: "critical" });
    const bad = await list.POST(jsonReq("/api/obligations", { text: `Remind me to rotate the key sk_live_${"a".repeat(28)} tomorrow` }), params());
    expect(bad.status).toBe(400);
    expect(await list.POST(jsonReq("/api/obligations", { text: "no" }), params()).then((r) => r.status)).toBe(400);
  });

  it("accepts a structured obligation and lists it with bucket counts", async () => {
    owner();
    const res = await list.POST(jsonReq("/api/obligations", { title: "Signed SOW from Dana", origin: "owner", assigned_to: "other", waiting_on: "Dana", due_at: "2026-09-10T15:00:00.000Z", completion_strategy: {} }), params());
    expect(res.status).toBe(201);
    const got = await list.GET(req("/api/obligations"), params());
    const body = (await got.json()) as { counts: { live: number; waiting_on_other: number }; obligations: { bucket: string }[] };
    expect(body.counts).toMatchObject({ live: 1, waiting_on_other: 1 });
    expect(body.obligations[0]!.bucket).toBe("waiting_on_other");
  });
});

describe("GET/PATCH /api/obligations/[id]", () => {
  it("validates ids, returns detail with timeline, and applies lifecycle actions", async () => {
    owner();
    expect((await detail.GET(req("/api/obligations/nope"), params({ id: "nope" }))).status).toBe(400);
    expect((await detail.GET(req(`/api/obligations/${ID}`), params({ id: ID }))).status).toBe(404);
    const created = (await (await list.POST(jsonReq("/api/obligations", { text: "Cancel the Acme subscription today" }), params())).json()) as { obligation: { id: string } };
    const id = created.obligation.id;
    const got = (await (await detail.GET(req(`/api/obligations/${id}`), params({ id }))).json()) as { obligation: { status: string }; events: { kind: string }[]; explanation: string };
    expect(got.events.map((e) => e.kind)).toEqual(["created"]);
    expect(got.explanation).toMatch(/not completed/);

    const snooze = await detail.PATCH(jsonReq(`/api/obligations/${id}`, { action: "snooze", until: "2026-09-20T15:00:00.000Z" }, { method: "PATCH" }), params({ id }));
    expect(((await snooze.json()) as { obligation: { status: string } }).obligation.status).toBe("snoozed");
    const bad = await detail.PATCH(jsonReq(`/api/obligations/${id}`, { action: "snooze" }, { method: "PATCH" }), params({ id }));
    expect(bad.status).toBe(400);
    const dismiss = await detail.PATCH(jsonReq(`/api/obligations/${id}`, { action: "dismiss" }, { method: "PATCH" }), params({ id }));
    expect(((await dismiss.json()) as { obligation: { status: string; bucket: string } }).obligation).toMatchObject({ status: "dismissed", bucket: "done" });
    const done = (await (await list.GET(req("/api/obligations?view=done"), params())).json()) as { obligations: unknown[]; counts: { live: number } };
    expect(done.obligations).toHaveLength(1);
    expect(done.counts.live).toBe(0);
    expect(db.rows("obligation_events").map((e) => e.kind)).toEqual(["created", "snoozed", "dismissed"]);
  });
});
