import { describe, expect, it } from "vitest";
import { buildTemplate, maxItemsFromMemories, rankAttention, type BriefingBundle } from "@/lib/jeff/briefings/bundle";
import { BriefingSummarySchema, BRIEFING_JSON_SCHEMA } from "@/lib/jeff/briefings/schema";
import { guardAgainstAdditions } from "@/lib/jeff/briefings/compose";
import { dueBriefings, localMidnight, periodFor, periodInstants } from "@/lib/jeff/briefings/schedule";
import { DEFAULT_SETTINGS } from "@/lib/jeff/settings";
import { computeFreshness } from "@/lib/jeff/freshness";

const NOW = new Date("2026-09-16T14:00:00.000Z"); // 08:00 Denver (MDT)

function bundle(over: Partial<BriefingBundle> = {}): BriefingBundle {
  return {
    kind: "daily",
    period_start: "2026-09-16",
    period_end: "2026-09-16",
    timezone: "America/Denver",
    owner_first_name: "Noah",
    now: NOW,
    alerts: [
      { id: "a-follow", kind: "finding", category: "lead_followup_gap", importance: "important", title: "8 lead follow-up gap findings", summary: "Eight qualified opportunities have no meaningful follow-up.", ref_id: null, occurrences: 2, status: "open" },
      { id: "a-inv", kind: "finding", category: "failed_payment", importance: "important", title: "Invoice #1001 failed ($2,750)", summary: "A $2,750 Stripe invoice failed yesterday.", ref_id: "f-inv", occurrences: 1, status: "open" },
      { id: "a-low", kind: "finding", category: "operational_bottleneck", importance: "briefing", title: "Thursday is heavily booked", summary: "7 events.", ref_id: "f-low", occurrences: 1, status: "open" },
    ],
    goals: [{ id: "g1", name: "10 clients in 60 days", trajectory: "slightly_at_risk", trajectory_label: "Slightly at risk", primary: "6 of ≥ 10", constraint: "booked_calls", days_remaining: 31, change: null }],
    events_today: [{ title: "Atlas scope alignment", start: "2026-09-16T16:00:00.000Z", location: null, attendees: 3 }],
    commitments: [{ id: "c1", action_text: "I'll send the proposal Thursday", context_text: "Sam's $8,400 estimate was sent four days ago and no follow-up is logged.", due_at: "2026-09-16T23:59:59.000Z", direction: "owed_by_me", status: "open" }],
    findings: [{ id: "f-low", category: "operational_bottleneck", title: "Thursday is heavily booked", severity: "low", status: "open", created_at: NOW.toISOString(), proposed_mission: { title: "Protect focus time", goal: "Block two mornings." } }],
    finance: { stripe_inflow: 1_250_000, stripe_prev_inflow: 1_000_000, plaid_inflow: null, plaid_outflow: null, plaid_prev_inflow: null, plaid_prev_outflow: null, open_invoices_count: 1, open_invoices_minor: 275_000, failed_charges_count: 1, mrr_minor: 400_000 },
    missions: [],
    outcomes: [],
    freshness: ["Stripe data is 3h old"],
    memories: [],
    briefing_rules: [],
    max_items: 3,
    ...over,
  };
}

describe("daily brief (§55)", () => {
  it("orders attention: goal behind pace → follow-up gaps → failed invoice", () => {
    const t = buildTemplate(bundle());
    expect(t.top_attention.map((i) => i.title)).toEqual(["10 clients in 60 days: slightly at risk", "8 lead follow-up gap findings", "Invoice #1001 failed ($2,750)"]);
    expect(t.omitted_count).toBe(1);
    expect(t.greeting).toBe("Good morning, Noah.");
    expect(t.today[0]!.title).toContain("Atlas scope alignment");
    expect(t.today[1]!.detail).toContain("$8,400");
    expect(t.financial.find((m) => m.label.startsWith("Collected"))!.change).toBe("+25% vs prior period");
    expect(t.recommends[0]!.ref_kind).toBe("goal");
    expect(BriefingSummarySchema.safeParse(t).success).toBe(true);
  });
  it("urgent alerts jump ahead of important ones but goals stay first", () => {
    const b = bundle({ alerts: [...bundle().alerts, { id: "a-urg", kind: "finding", category: "automation_failure", importance: "urgent", title: "Lead intake workflow failing", summary: "", ref_id: "f-u", occurrences: 3, status: "open" }] });
    const ranked = rankAttention(b.alerts, b.goals);
    expect(ranked[0]!.ref_kind).toBe("goal");
    expect(ranked[1]!.title).toBe("Lead intake workflow failing");
  });
  it("honours a 'no more than five items' memory (§52) and never exceeds the cap", () => {
    expect(maxItemsFromMemories(["I prefer daily briefs to be very short. Give me no more than five main items."], 3)).toBe(5);
    expect(maxItemsFromMemories(["keep it to 2 bullets"], 3)).toBe(2);
    expect(maxItemsFromMemories(["I like concise reports"], 3)).toBe(3);
    const many = bundle({ max_items: 2 });
    const t = buildTemplate(many);
    expect(t.top_attention).toHaveLength(2);
    expect(t.applied_preferences).toContain("Attention items capped at 2");
  });
  it("weekly/monthly emphasise change and monthly says insufficient data without finance", () => {
    const w = buildTemplate(
      bundle({
        kind: "weekly",
        period_start: "2026-09-09",
        period_end: "2026-09-15",
        findings: [{ id: "r1", category: "failed_payment", title: "Old failure", severity: "high", status: "resolved", created_at: NOW.toISOString(), proposed_mission: null }],
        commitments: [{ id: "c1", action_text: "I'll send the proposal Thursday", context_text: null, due_at: "2026-09-10T23:59:59.000Z", direction: "owed_by_me", status: "overdue" }],
      }),
    );
    expect(w.today).toHaveLength(0);
    expect(w.changes.some((c) => c.title.includes("resolved"))).toBe(true);
    expect(w.misses[0]).toContain("Overdue");
    const m = buildTemplate(bundle({ kind: "monthly", finance: null, period_start: "2026-08-01", period_end: "2026-08-31" }));
    expect(m.financial[0]!.value).toBe("insufficient data");
  });
  it("the model cannot add items, refs or numbers (guard)", () => {
    const t = buildTemplate(bundle());
    const ai = { ...t, top_attention: [...t.top_attention, { title: "Invented", detail: "", ref_kind: "finding" as const, ref_id: "nope", importance: "urgent" as const }], financial: [{ label: "Revenue", value: "$1,000,000", change: null, note: null }] };
    const g = guardAgainstAdditions(t, ai, 3);
    expect(g.top_attention.find((i) => i.ref_id === "nope")).toBeUndefined();
    expect(g.top_attention).toHaveLength(3);
    expect(g.financial).toEqual(t.financial);
  });
  it("JSON schema and Zod schema agree on required keys", () => {
    const keys = Object.keys(BriefingSummarySchema.shape).sort();
    expect([...BRIEFING_JSON_SCHEMA.required].sort()).toEqual(keys);
  });
});

describe("schedule (America/Denver, DST-safe)", () => {
  it("daily brief is due after 07:30 local and not before", () => {
    expect(dueBriefings(new Date("2026-09-16T13:29:00.000Z"), DEFAULT_SETTINGS).map((d) => d.kind)).toEqual([]); // 07:29 MDT
    expect(dueBriefings(new Date("2026-09-16T13:30:00.000Z"), DEFAULT_SETTINGS).map((d) => d.kind)).toEqual(["daily"]);
    // Winter (MST): 07:30 local = 14:30Z.
    expect(dueBriefings(new Date("2026-12-10T14:29:00.000Z"), DEFAULT_SETTINGS)).toEqual([]);
    expect(dueBriefings(new Date("2026-12-10T14:30:00.000Z"), DEFAULT_SETTINGS)[0]).toMatchObject({ kind: "daily", period_start: "2026-12-10" });
  });
  it("weekly review on Monday covers the prior 7 days; monthly on the 1st covers last month", () => {
    const mon = new Date("2026-09-14T14:00:00.000Z"); // Monday 08:00 MDT
    const due = dueBriefings(mon, DEFAULT_SETTINGS);
    expect(due.find((d) => d.kind === "weekly")).toMatchObject({ period_start: "2026-09-07", period_end: "2026-09-13" });
    const first = new Date("2026-10-01T14:00:00.000Z");
    expect(dueBriefings(first, DEFAULT_SETTINGS).find((d) => d.kind === "monthly")).toMatchObject({ period_start: "2026-09-01", period_end: "2026-09-30" });
    expect(periodFor("monthly", new Date("2026-01-05T14:00:00.000Z"), "America/Denver")).toEqual({ period_start: "2025-12-01", period_end: "2025-12-31" });
  });
  it("local midnight and period instants respect the offset", () => {
    expect(localMidnight("2026-09-16", "America/Denver").toISOString()).toBe("2026-09-16T06:00:00.000Z");
    expect(localMidnight("2026-12-10", "America/Denver").toISOString()).toBe("2026-12-10T07:00:00.000Z");
    const p = periodInstants("2026-09-16", "2026-09-16", "America/Denver");
    expect(p.end.getTime() - p.start.getTime()).toBe(86_400_000 - 1);
  });
});

describe("data freshness", () => {
  it("classifies fresh / aging / stale / error / never", () => {
    const now = new Date("2026-09-16T12:00:00.000Z");
    const conns = [
      { id: "c1", provider: "stripe", display_name: "Stripe", status: "connected", last_sync_at: "2026-09-16T09:00:00.000Z", last_error: null },
      { id: "c2", provider: "google", display_name: "Google · noah@bizgrips.com", status: "connected", last_sync_at: "2026-09-13T09:00:00.000Z", last_error: null },
      { id: "c3", provider: "highlevel", display_name: "HighLevel", status: "connected", last_sync_at: "2026-09-16T11:30:00.000Z", last_error: null },
      { id: "c4", provider: "plaid", display_name: "Financial Accounts", status: "connected", last_sync_at: null, last_error: null },
    ];
    const runs = [{ connection_id: "c3", provider: "highlevel", status: "failed" as const, started_at: "2026-09-16T11:45:00.000Z", finished_at: "2026-09-16T11:46:00.000Z", created_at: "2026-09-16T11:45:00.000Z", error: "401" }];
    const f = computeFreshness(conns, runs, now);
    expect(f.map((x) => x.level)).toEqual(["aging", "stale", "error", "never"]);
    expect(f[0]!.text).toBe("Stripe data is 3h old");
    expect(f[1]!.text).toContain("stale");
    expect(f[2]!.last_error).toBe("401");
  });
});
