import { describe, expect, it, vi, beforeEach } from "vitest";
import { fakeSupabase, jsonReq, OWNER_ID, OTHER_ID, req, type Claims } from "../helpers";

let claims: Claims = null;
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeSupabase(claims) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/gomez/budget", () => ({ budgetStatus: vi.fn(async () => ({ spentUsd: 0, budgetUsd: 2, exhausted: false })), recordUsage: vi.fn(async () => 0) }));
// Never touch the network: interpretation runs deterministically (no client).
vi.mock("@/lib/env", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/env")>();
  return { ...mod, hasEnv: (name: string) => (name === "ANTHROPIC_API_KEY" ? false : mod.hasEnv(name)) };
});

/** In-memory service-role stand-in covering the query shapes used by lib/gomez/goals/*. */
interface Row extends Record<string, unknown> {
  id: string;
}
const db: Record<string, Row[]> = {};
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function table(name: string) {
  const rows = () => (db[name] ??= []);
  let filters: ((r: Row) => boolean)[] = [];
  let pendingInsert: Row[] | null = null;
  let pendingUpdate: Record<string, unknown> | null = null;
  let pendingDelete = false;
  let single = false;
  let limitN: number | null = null;
  let order: { col: string; asc: boolean } | null = null;
  const apply = () => {
    let hit = rows().filter((r) => filters.every((f) => f(r)));
    if (order) hit = [...hit].sort((a, b) => (String(a[order!.col] ?? "") < String(b[order!.col] ?? "") ? (order!.asc ? -1 : 1) : String(a[order!.col] ?? "") > String(b[order!.col] ?? "") ? (order!.asc ? 1 : -1) : 0));
    if (limitN != null) hit = hit.slice(0, limitN);
    return hit;
  };
  const q: Record<string, unknown> = {};
  const chain = () => q;
  q.select = () => chain();
  q.order = (col: string, opts?: { ascending?: boolean }) => {
    order = { col, asc: opts?.ascending !== false };
    return chain();
  };
  q.limit = (n: number) => {
    limitN = n;
    return chain();
  };
  q.eq = (k: string, v: unknown) => {
    filters.push((r) => r[k] === v);
    return chain();
  };
  q.in = (k: string, vs: unknown[]) => {
    filters.push((r) => vs.includes(r[k]));
    return chain();
  };
  q.gte = () => chain();
  q.or = () => chain();
  q.not = () => chain();
  q.insert = (v: Row | Row[]) => {
    pendingInsert = (Array.isArray(v) ? v : [v]).map((r) => ({ created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...r, id: (r.id as string) ?? uuid() }));
    return chain();
  };
  q.update = (v: Record<string, unknown>) => {
    pendingUpdate = v;
    return chain();
  };
  q.delete = () => {
    pendingDelete = true;
    return chain();
  };
  q.upsert = q.insert;
  q.maybeSingle = () => {
    single = true;
    return q;
  };
  q.single = q.maybeSingle;
  q.then = (resolve: (v: unknown) => void) => {
    let data: unknown;
    if (pendingInsert) {
      rows().push(...pendingInsert);
      data = single ? pendingInsert[0] : pendingInsert;
    } else if (pendingUpdate) {
      const hit = rows().filter((r) => filters.every((f) => f(r)));
      for (const r of hit) Object.assign(r, pendingUpdate, { updated_at: new Date().toISOString() });
      data = single ? (hit[0] ?? null) : hit;
    } else if (pendingDelete) {
      const hit = rows().filter((r) => filters.every((f) => f(r)));
      db[name] = rows().filter((r) => !hit.includes(r));
      resolve({ data: hit, error: null, count: hit.length });
      return;
    } else {
      const hit = apply();
      data = single ? (hit[0] ?? null) : hit;
    }
    filters = [];
    resolve({ data, error: null, count: Array.isArray(data) ? data.length : data ? 1 : 0 });
  };
  return q;
}
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: (name: string) => table(name) }) }));

const goalsRoute = await import("@/app/api/goals/route");
const goalRoute = await import("@/app/api/goals/[id]/route");
const refreshRoute = await import("@/app/api/goals/refresh/route");
const prepareRoute = await import("@/app/api/goals/[id]/recommendations/[recId]/prepare/route");
const { runGoalTool } = await import("@/lib/gomez/goals/tools");
const { refreshGoal } = await import("@/lib/gomez/goals/refresh");
const { getGoal } = await import("@/lib/gomez/goals/store");

const SENTENCE = "Onboard 10 new clients in the next 60 days with a CAC under $1000 and a sign date to first payment date in under 14 days.";
const ctx = { params: Promise.resolve({}) };
const P = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

beforeEach(() => {
  claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal2" };
  for (const k of Object.keys(db)) db[k] = [];
  db.connections = [{ id: uuid(), owner_id: OWNER_ID, provider: "highlevel", status: "connected", last_sync_at: new Date().toISOString() }];
  db.source_items = [];
});

describe("route authorization", () => {
  it("rejects anonymous, non-owner and aal1 callers", async () => {
    for (const c of [null, { sub: OTHER_ID, email: "noah@bizgrips.com", aal: "aal2" as const }, { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal1" as const }]) {
      claims = c;
      const expected = c == null ? 401 : 403;
      expect((await goalsRoute.GET(req("/api/goals"), ctx)).status).toBe(expected);
      expect((await goalsRoute.POST(jsonReq("/api/goals", { prompt: SENTENCE }), ctx)).status).toBe(expected);
      expect((await refreshRoute.POST(req("/api/goals/refresh", { method: "POST" }), ctx)).status).toBe(expected);
      expect((await goalRoute.PATCH(jsonReq("/api/goals/x", { action: "pause" }), P({ id: "11111111-1111-4111-8111-111111111111" }))).status).toBe(expected);
      expect((await prepareRoute.POST(req("/api/goals/x/recommendations/y/prepare", { method: "POST" }), P({ id: "11111111-1111-4111-8111-111111111111", recId: "11111111-1111-4111-8111-111111111111" }))).status).toBe(expected);
    }
  });
});

describe("propose → approve", () => {
  it("creates a draft with immutable prompt_text and refuses approval until ambiguities are resolved", async () => {
    const created = await goalsRoute.POST(jsonReq("/api/goals", { prompt: SENTENCE }), ctx);
    expect(created.status).toBe(201);
    const { goal } = (await created.json()) as { goal: { id: string; status: string; prompt_text: string; ambiguities: { field: string }[] } };
    expect(goal.status).toBe("draft");
    expect(goal.prompt_text).toBe(SENTENCE);
    expect(goal.ambiguities.length).toBeGreaterThanOrEqual(3);
    expect(db.goal_metrics!.filter((m) => m.goal_id === goal.id).map((m) => m.key)).toEqual(["clients_onboarded", "cac", "sign_to_first_payment_days"]);
    expect(db.goal_events!.some((e) => e.goal_id === goal.id && e.kind === "created")).toBe(true);

    const early = await goalRoute.PATCH(jsonReq(`/api/goals/${goal.id}`, { approve: { resolutions: {} } }), P({ id: goal.id }));
    expect(early.status).toBe(400);
    expect(await early.json()).toMatchObject({ error: "ambiguities_unresolved" });
    expect((await getGoal(OWNER_ID, goal.id))!.status).toBe("draft");

    const resolutions = Object.fromEntries(goal.ambiguities.map((a) => [a.field, "first option"]));
    const ok = await goalRoute.PATCH(jsonReq(`/api/goals/${goal.id}`, { approve: { resolutions, start_date: "2026-09-12" } }), P({ id: goal.id }));
    expect(ok.status).toBe(200);
    const after = (await getGoal(OWNER_ID, goal.id))!;
    expect(after.status).toBe("active");
    expect(after.start_date).toBe("2026-09-12");
    expect(after.end_date).toBe("2026-11-11"); // +60 days
    expect(after.prompt_text).toBe(SENTENCE);
    expect(after.ambiguities.every((a) => a.resolution)).toBe(true);
    expect(db.goal_events!.some((e) => e.goal_id === goal.id && e.kind === "approved")).toBe(true);
    // refresh on approval wrote a snapshot
    expect(db.goal_snapshots!.filter((s) => s.goal_id === goal.id).length).toBe(1);
  });

  it("only drafts can be deleted; edits after approval are recorded with before/after", async () => {
    const created = await goalsRoute.POST(jsonReq("/api/goals", { prompt: "Sign 4 new clients in the next 30 days" }), ctx);
    const { goal } = (await created.json()) as { goal: { id: string; ambiguities: { field: string }[] } };
    const resolutions = Object.fromEntries(goal.ambiguities.map((a) => [a.field, "x"]));
    await goalRoute.PATCH(jsonReq(`/api/goals/${goal.id}`, { approve: { resolutions } }), P({ id: goal.id }));
    const del = await goalRoute.DELETE(req(`/api/goals/${goal.id}`, { method: "DELETE" }), P({ id: goal.id }));
    expect(del.status).toBe(409);
    const edit = await goalRoute.PATCH(jsonReq(`/api/goals/${goal.id}`, { name: "Four clients (renamed)" }), P({ id: goal.id }));
    expect(edit.status).toBe(200);
    const ev = db.goal_events!.find((e) => e.goal_id === goal.id && e.kind === "edited") as { payload: { before: Record<string, unknown>; after: Record<string, unknown>; approved: boolean } } | undefined;
    expect(ev?.payload.after).toMatchObject({ name: "Four clients (renamed)" });
    expect(ev?.payload.approved).toBe(true);
  });
});

describe("refresh", () => {
  it("writes a snapshot, updates metric values, and emits trajectory_changed when the label changes", async () => {
    const created = await goalsRoute.POST(jsonReq("/api/goals", { prompt: "Sign 10 new clients in the next 60 days" }), ctx);
    const { goal } = (await created.json()) as { goal: { id: string; ambiguities: { field: string }[] } };
    await goalRoute.PATCH(jsonReq(`/api/goals/${goal.id}`, { approve: { resolutions: Object.fromEntries(goal.ambiguities.map((a) => [a.field, "x"])), start_date: "2026-08-01", end_date: "2026-12-31" } }), P({ id: goal.id }));
    const before = db.goal_snapshots!.length;
    // Add won opportunities well inside the window → trajectory should become on_track.
    for (let i = 0; i < 12; i++) {
      db.source_items!.push({ id: uuid(), owner_id: OWNER_ID, is_sample: false, provider: "highlevel", capability: null, resource_type: "opportunity", external_id: `o${i}`, title: null, source_timestamp: "2026-08-15T00:00:00Z", synced_at: new Date().toISOString(), tags: [], metadata: { status: "won", lastStatusChangeAt: "2026-08-15T00:00:00Z" } });
    }
    const g = (await getGoal(OWNER_ID, goal.id))!;
    // Refresh strictly after the approval snapshot so "latest" is unambiguous.
    const r = await refreshGoal(OWNER_ID, g, new Date(Date.now() + 60_000));
    expect(r.trajectory).toBe("on_track");
    expect(r.changed).toBe(true);
    expect(db.goal_snapshots!.length).toBe(before + 1);
    const metric = db.goal_metrics!.find((m) => m.goal_id === goal.id && m.key === "clients_onboarded");
    expect(metric?.current_value).toBe(12);
    expect(db.goal_events!.some((e) => e.goal_id === goal.id && e.kind === "trajectory_changed")).toBe(true);
    const status = (await runGoalTool("get_goal_status", { goal_id: goal.id }, { ownerId: OWNER_ID })) as { trajectory: { label: string }; metrics: { key: string; source: string; freshness: string }[] };
    expect(status.trajectory.label).toBe("On track");
    expect(status.metrics[0]).toMatchObject({ key: "clients_onboarded", freshness: "fresh" });
  });

  it("recommendations can be prepared into a sandbox mission linked to the goal", async () => {
    const created = await goalsRoute.POST(jsonReq("/api/goals", { prompt: "Sign 10 new clients in the next 60 days with a CAC under $500" }), ctx);
    const { goal } = (await created.json()) as { goal: { id: string; ambiguities: { field: string }[] } };
    await goalRoute.PATCH(jsonReq(`/api/goals/${goal.id}`, { approve: { resolutions: Object.fromEntries(goal.ambiguities.map((a) => [a.field, "x"])) } }), P({ id: goal.id }));
    // Meta is not connected → a "connect" recommendation exists.
    const rec = db.goal_recommendations!.find((r) => r.goal_id === goal.id);
    expect(rec).toBeTruthy();
    const res = await prepareRoute.POST(req(`/api/goals/${goal.id}/recommendations/${rec!.id}/prepare`, { method: "POST" }), P({ id: goal.id, recId: rec!.id as string }));
    expect(res.status).toBe(201);
    const mission = db.missions!.find((m) => m.goal_id === goal.id);
    expect(mission).toMatchObject({ environment: "sandbox", status: "draft" });
    expect(db.goal_recommendations!.find((r) => r.id === rec!.id)).toMatchObject({ status: "prepared", mission_id: mission!.id });
  });

  it("propose_goal tool creates a draft and reports ambiguities without claiming tracking", async () => {
    const out = (await runGoalTool("propose_goal", { sentence: SENTENCE }, { ownerId: OWNER_ID })) as { draft_goal_id: string; ambiguities: unknown[]; next_step: string };
    expect(out.draft_goal_id).toBeTruthy();
    expect(out.ambiguities.length).toBeGreaterThanOrEqual(3);
    expect(out.next_step).toMatch(/Do not claim the goal is being tracked/);
    const list = (await runGoalTool("list_goals", {}, { ownerId: OWNER_ID })) as { goals: { status: string }[] };
    expect(list.goals[0]!.status).toBe("draft");
  });
});
