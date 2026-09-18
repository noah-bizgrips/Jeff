import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Lifecycle rules of alert groups (store-level, with a recording fake admin
 * client): reopen within 7 days keeps the same group, later reappearance starts
 * fresh, dismissed groups only reopen on new members / urgent escalation, owner
 * actions mirror onto the parent alert and (for dismiss) the hidden members.
 */

interface Op {
  table: string;
  op: "select" | "update" | "insert" | "upsert";
  payload?: unknown;
  filters: Record<string, unknown>[];
}
const ops: Op[] = [];
let groupRow: Record<string, unknown> | null = null;
let memberRows: Record<string, unknown>[] = [];

function chain(table: string) {
  const state: Op = { table, op: "select", filters: [] };
  const c: Record<string, unknown> = {};
  const self = () => c;
  const filter = (k: string) => (col: string, v: unknown) => {
    state.filters.push({ [k]: [col, v] });
    return c;
  };
  c.select = vi.fn(() => c);
  c.eq = vi.fn(filter("eq"));
  c.in = vi.fn(filter("in"));
  c.order = vi.fn(self);
  c.limit = vi.fn(self);
  c.update = vi.fn((payload: unknown) => {
    state.op = "update";
    state.payload = payload;
    return c;
  });
  c.insert = vi.fn((payload: unknown) => {
    state.op = "insert";
    state.payload = payload;
    return c;
  });
  c.upsert = vi.fn((payload: unknown) => {
    state.op = "upsert";
    state.payload = payload;
    return c;
  });
  c.maybeSingle = vi.fn(async () => {
    ops.push(state);
    return { data: table === "alert_groups" ? groupRow : null, error: null };
  });
  c.single = vi.fn(async () => {
    ops.push(state);
    return { data: null, error: null };
  });
  c.then = (resolve: (v: unknown) => void) => {
    ops.push(state);
    resolve({ data: table === "alert_group_members" ? memberRows : [], error: null });
  };
  return c;
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: (table: string) => chain(table) }) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/gomez/clients/map", () => ({ loadClientMap: vi.fn(async () => []) }));
vi.mock("@/lib/gomez/obligations/store", () => ({ listObligations: vi.fn(async () => []) }));
vi.mock("@/lib/gomez/commitments/store", () => ({ listCommitments: vi.fn(async () => []) }));
vi.mock("@/lib/gomez/goals/store", () => ({ listGoals: vi.fn(async () => []) }));

const { nextGroupStatus, updateAlertGroup, REOPEN_DAYS } = await import("@/lib/gomez/grouping/store");

const NOW = new Date("2026-09-14T16:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const base = { status: "open" as const, snoozed_until: null, resolved_at: null, importance: "important" as const };

describe("nextGroupStatus", () => {
  it("resolved groups reopen into the same group within REOPEN_DAYS, and start fresh after", () => {
    expect(REOPEN_DAYS).toBe(7);
    expect(nextGroupStatus({ ...base, status: "resolved", resolved_at: daysAgo(3) }, { importance: "important" }, { added: 1 }, NOW)).toEqual({ status: "open", reopened: true, fresh: false });
    expect(nextGroupStatus({ ...base, status: "resolved", resolved_at: daysAgo(9) }, { importance: "important" }, { added: 1 }, NOW)).toEqual({ status: "open", reopened: false, fresh: true });
  });
  it("dismissed groups stay dismissed until a new member arrives or the situation turns urgent", () => {
    expect(nextGroupStatus({ ...base, status: "dismissed" }, { importance: "important" }, { added: 0 }, NOW).status).toBe("dismissed");
    expect(nextGroupStatus({ ...base, status: "dismissed" }, { importance: "important" }, { added: 1 }, NOW)).toMatchObject({ status: "open", reopened: true });
    expect(nextGroupStatus({ ...base, status: "dismissed" }, { importance: "urgent" }, { added: 0 }, NOW).status).toBe("open");
  });
  it("snoozed groups wake when the snooze lapses or the situation becomes urgent; acknowledged reopens on growth or escalation", () => {
    expect(nextGroupStatus({ ...base, status: "snoozed", snoozed_until: daysAgo(-1) }, { importance: "important" }, { added: 2 }, NOW).status).toBe("snoozed");
    expect(nextGroupStatus({ ...base, status: "snoozed", snoozed_until: daysAgo(-1) }, { importance: "urgent" }, { added: 0 }, NOW).status).toBe("open");
    expect(nextGroupStatus({ ...base, status: "snoozed", snoozed_until: daysAgo(1) }, { importance: "important" }, { added: 0 }, NOW).status).toBe("open");
    expect(nextGroupStatus({ ...base, status: "acknowledged" }, { importance: "important" }, { added: 0 }, NOW).status).toBe("acknowledged");
    expect(nextGroupStatus({ ...base, status: "acknowledged" }, { importance: "important" }, { added: 1 }, NOW).status).toBe("open");
    expect(nextGroupStatus({ ...base, status: "acknowledged", importance: "briefing" }, { importance: "important" }, { added: 0 }, NOW).status).toBe("open");
    expect(nextGroupStatus({ ...base }, { importance: "important" }, { added: 0 }, NOW).status).toBe("open");
  });
});

describe("updateAlertGroup", () => {
  beforeEach(() => {
    ops.length = 0;
    groupRow = { id: "g1", status: "open", alert_id: "p1", member_count: 3, title: "Pure Bath of Michigan — 3 signals" };
    memberRows = [{ id: "m1", group_id: "g1", member_kind: "obligation", member_id: "o1", status: "live", detail: {} }];
  });
  it("dismiss marks the group, its parent alert AND the hidden member alerts as dismissed — member records stay", async () => {
    const out = await updateAlertGroup("owner", "g1", { action: "dismiss" }, NOW);
    expect(out?.id).toBe("g1");
    const updates = ops.filter((o) => o.op === "update");
    expect(updates.find((u) => u.table === "alert_groups")?.payload).toMatchObject({ status: "dismissed", dismissed_at: NOW.toISOString() });
    const alertUpdates = updates.filter((u) => u.table === "alerts");
    expect(alertUpdates[0]!.payload).toEqual({ status: "dismissed" });
    expect(alertUpdates[0]!.filters).toContainEqual({ eq: ["id", "p1"] });
    expect(alertUpdates[1]!.payload).toEqual({ status: "dismissed" });
    expect(alertUpdates[1]!.filters).toContainEqual({ eq: ["group_id", "g1"] });
    expect(alertUpdates[1]!.filters).toContainEqual({ eq: ["status", "grouped"] });
    expect(ops.some((o) => o.table === "alert_group_members" && o.op !== "select")).toBe(false);
  });
  it("snooze carries the until time to the parent alert; acknowledge stamps acknowledged_at; reopen re-hides dismissed members", async () => {
    await updateAlertGroup("owner", "g1", { action: "snooze", until: "2026-09-15T16:00:00Z" }, NOW);
    expect(ops.filter((o) => o.op === "update" && o.table === "alerts")[0]!.payload).toEqual({ status: "snoozed", snoozed_until: "2026-09-15T16:00:00Z" });
    ops.length = 0;
    await updateAlertGroup("owner", "g1", { action: "acknowledge" }, NOW);
    expect(ops.find((o) => o.op === "update" && o.table === "alert_groups")?.payload).toEqual({ status: "acknowledged", acknowledged_at: NOW.toISOString() });
    ops.length = 0;
    await updateAlertGroup("owner", "g1", { action: "reopen" }, NOW);
    const alertUpdates = ops.filter((o) => o.op === "update" && o.table === "alerts");
    expect(alertUpdates[1]!.payload).toEqual({ status: "grouped" });
    expect(alertUpdates[1]!.filters).toContainEqual({ eq: ["status", "dismissed"] });
  });
  it("returns null for an unknown group without writing", async () => {
    groupRow = null;
    expect(await updateAlertGroup("owner", "nope", { action: "dismiss" }, NOW)).toBeNull();
    expect(ops.some((o) => o.op === "update")).toBe(false);
  });
});
