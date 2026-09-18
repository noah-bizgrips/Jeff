import { describe, expect, it, vi } from "vitest";
import { clientByName, entityKeyForAlert, groupKeyOf, issueOfCategory, issueOfText, slug } from "@/lib/gomez/grouping/keys";
import { MIN_GROUP_SIZE, planGroups, type GroupableAlert, type GroupableFinding, type GroupableObligation, type GroupingInput } from "@/lib/gomez/grouping/engine";
import { buildSummary, computeFacts, type SummaryMember } from "@/lib/gomez/grouping/summary";
import { reconcileAlerts, type AlertCandidate, type ExistingAlert } from "@/lib/gomez/alerts/engine";
import { shouldPushAlert, GROUP_REPUSH_GROWTH } from "@/lib/gomez/push/decide";
import { alertEmoji } from "@/lib/gomez/push/emoji";
import { computeBrainState, attentionCountOf } from "@/lib/gomez/brain/state";
import { rankAttention, buildTemplate, type BriefingBundle } from "@/lib/gomez/briefings/bundle";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: () => ({}) }) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

const NOW = new Date("2026-09-14T16:00:00Z");
const CLIENTS = [
  { portal_client_id: "c1", name: "Pure Bath of Michigan", slug: "pure-bath" },
  { portal_client_id: "c2", name: "Northwind Roofing", slug: "northwind" },
];

function alert(over: Partial<GroupableAlert> & { id: string; fingerprint: string; kind: string }): GroupableAlert {
  return { ref_id: null, category: null, importance: "important", scope: "business", status: "open", title: over.fingerprint, summary: null, first_seen: NOW.toISOString(), last_seen: NOW.toISOString(), group_id: null, ...over };
}
function finding(over: Partial<GroupableFinding> & { id: string; category: string }): GroupableFinding {
  return { title: over.category, goal_id: null, severity: "medium", metrics: {}, observed_facts: [], items: [], ...over };
}
function obligation(over: Partial<GroupableObligation> & { id: string; title: string }): GroupableObligation {
  return { description: null, status: "overdue", scope: "business", priority: "normal", due_at: "2026-09-10T00:00:00Z", assigned_to: "me", waiting_on: null, counterparty: null, related_client_id: null, related_goal_id: null, related_mission_id: null, source_provider: null, origin: "gomez", metadata: {}, ...over };
}
function input(over: Partial<GroupingInput> = {}): GroupingInput {
  return { now: NOW, alerts: [], findings: [], obligations: [], commitments: [], clients: CLIENTS, ...over };
}

/* ------------------------------------------------------------------ */
/* Keys                                                                 */
/* ------------------------------------------------------------------ */
describe("grouping keys", () => {
  it("client-keyed finding fingerprints resolve to the portal client (structured)", () => {
    const k = entityKeyForAlert({ kind: "finding", fingerprint: "portal_task_overdue:c1", category: "portal_task_overdue", title: "x", ref_id: "f1" }, CLIENTS);
    expect(k).toEqual({ kind: "client", id: "c1", name: "Pure Bath of Michigan", source: "structured" });
    expect(entityKeyForAlert({ kind: "finding", fingerprint: "client_unpaid_invoice:c2", category: "client_unpaid_invoice", title: "x", ref_id: "f2" }, CLIENTS)?.id).toBe("c2");
    expect(entityKeyForAlert({ kind: "finding", fingerprint: "lead_not_contacted:unknown", category: "lead_not_contacted", title: "Unknown client: 3 leads", ref_id: "f3" }, CLIENTS)).toBeNull();
  });
  it("goal, workflow and ad-account keys are structured; stage findings fall back to the client named in the title", () => {
    expect(entityKeyForAlert({ kind: "goal", fingerprint: "goal:g1", category: "goal_trajectory", title: "Onboard 10 clients: at risk", ref_id: "g1" }, CLIENTS, new Map([["g1", "Onboard 10 clients"]]))).toEqual({ kind: "goal", id: "g1", name: "Onboard 10 clients", source: "structured" });
    expect(entityKeyForAlert({ kind: "finding", fingerprint: "automation_failure:lead-router", category: "automation_failure", title: "x", ref_id: "f4" }, CLIENTS)).toMatchObject({ kind: "workflow", id: "lead-router" });
    expect(entityKeyForAlert({ kind: "finding", fingerprint: "ad_spend_change:meta:act_9:weekly", category: "ad_spend_change", title: "x", ref_id: "f5" }, CLIENTS)).toMatchObject({ kind: "campaign", id: "meta:act_9" });
    expect(entityKeyForAlert({ kind: "finding", fingerprint: "portal_stage_stalled:stage-7", category: "portal_stage_stalled", title: 'Pure Bath of Michigan: stage "Design" has been in progress 20 days', ref_id: "f6" }, CLIENTS)).toEqual({ kind: "client", id: "c1", name: "Pure Bath of Michigan", source: "semantic" });
    expect(entityKeyForAlert({ kind: "finding", fingerprint: "cashflow_change:stripe:30d", category: "cashflow_change", title: "Cash inflow down 20%", ref_id: "f7" }, CLIENTS)).toBeNull();
  });
  it("obligations prefer structured ids, then a client name, then the counterparty as a contact", () => {
    expect(entityKeyForAlert({ kind: "obligation", fingerprint: "obligation:o1", category: "obligation_waiting_on_me", title: "Send timeline", ref_id: "o1", related_client_id: "c2" }, CLIENTS)).toMatchObject({ kind: "client", id: "c2", source: "structured" });
    expect(entityKeyForAlert({ kind: "obligation", fingerprint: "obligation:o2", category: null, title: "Get CRM access from Pure Bath of Michigan", ref_id: "o2" }, CLIENTS)).toMatchObject({ kind: "client", id: "c1", source: "semantic" });
    expect(entityKeyForAlert({ kind: "obligation", fingerprint: "obligation:o3", category: null, title: "Call back about the estimate", ref_id: "o3", counterparty: "Sam Rivera" }, CLIENTS)).toEqual({ kind: "contact", id: "sam-rivera", name: "Sam Rivera", source: "structured" });
    expect(entityKeyForAlert({ kind: "obligation", fingerprint: "obligation:o4", category: null, title: "Renew passport", ref_id: "o4" }, CLIENTS)).toBeNull();
  });
  it("issue families and keyword tie-breaker", () => {
    expect(issueOfCategory("portal_task_overdue")).toBe("delivery");
    expect(issueOfCategory("client_unpaid_invoice")).toBe("money");
    expect(issueOfCategory("nonsense")).toBe("mixed");
    expect(issueOfText("Chase the unpaid invoice")).toBe("money");
    expect(issueOfText("Get CRM access so onboarding can start")).toBe("delivery");
    expect(issueOfText("Follow up on the ad campaign form")).toBe("acquisition");
    expect(issueOfText("Send the thing")).toBe("follow_through");
    expect(groupKeyOf({ kind: "client", id: "c1", name: "x", source: "structured" }, "delivery")).toBe("client:c1:delivery");
    expect(groupKeyOf({ kind: "goal", id: "g1", name: "x", source: "structured" }, "goal")).toBe("goal:g1:all");
    expect(slug("Sam  Rivera (Acme)")).toBe("sam-rivera-acme");
    expect(clientByName("Pure Bath", CLIENTS)).toBeNull(); // partial names never match
  });
});

/* ------------------------------------------------------------------ */
/* Engine                                                               */
/* ------------------------------------------------------------------ */
describe("grouping engine", () => {
  it("bundles a client's overdue-tasks finding, a stalled stage and a CRM-access obligation into ONE delivery group; unrelated clients stay apart", () => {
    const plans = planGroups(
      input({
        alerts: [
          alert({ id: "a1", fingerprint: "portal_task_overdue:c1", kind: "finding", ref_id: "f1", category: "portal_task_overdue", title: "Pure Bath of Michigan: 6 overdue tasks (4 owed by BizGrips)", importance: "important" }),
          alert({ id: "a2", fingerprint: "portal_stage_stalled:s7", kind: "finding", ref_id: "f2", category: "portal_stage_stalled", title: 'Pure Bath of Michigan: stage "Design" has been in progress 20 days', importance: "briefing" }),
          alert({ id: "a3", fingerprint: "obligation:o1", kind: "obligation", ref_id: "o1", category: "obligation_waiting_on_other", title: "Waiting on Pure Bath: CRM access", importance: "important" }),
          alert({ id: "a4", fingerprint: "client_unpaid_invoice:c2", kind: "finding", ref_id: "f3", category: "client_unpaid_invoice", title: "Northwind Roofing: 1 unpaid invoice", importance: "urgent" }),
          alert({ id: "a5", fingerprint: "cashflow_change:stripe:30d", kind: "finding", ref_id: "f4", category: "cashflow_change", title: "Cash down", importance: "important" }),
        ],
        findings: [
          finding({ id: "f1", category: "portal_task_overdue", metrics: { overdue_total: 6, owed_by_bizgrips: 4, owed_by_client: 2, blocking: 1, oldest_overdue_days: 19 }, items: [{ title: "Provide CRM login", due_at: "2026-08-26T00:00:00Z", days_overdue: 19, owner: "Client", priority: "blocking", status: "pending", notes: null, blocking: true, stage: "Setup", url: null }, { title: "Build homepage", due_at: "2026-09-05T00:00:00Z", days_overdue: 9, owner: "BizGrips", priority: null, status: "in_progress", notes: null, blocking: false, stage: "Design", url: null }] }),
          finding({ id: "f2", category: "portal_stage_stalled", metrics: { age_days: 20 } }),
          finding({ id: "f3", category: "client_unpaid_invoice", metrics: { invoices: 1 } }),
          finding({ id: "f4", category: "cashflow_change" }),
        ],
        obligations: [obligation({ id: "o1", title: "Get CRM access from Pure Bath of Michigan", assigned_to: "other", waiting_on: "Pure Bath of Michigan", related_client_id: "c1", status: "waiting_on_other" })],
      }),
    );
    expect(plans).toHaveLength(1);
    const g = plans[0]!;
    expect(g.group_key).toBe("client:c1:delivery");
    expect(g.entity_name).toBe("Pure Bath of Michigan");
    expect(g.members.map((m) => `${m.member_kind}:${m.member_id}`).sort()).toEqual(["alert:a1", "alert:a2", "obligation:o1"]);
    expect(g.members.find((m) => m.member_id === "o1")?.alert_id).toBe("a3");
    expect(g.importance).toBe("important");
    expect(g.title).toBe("Pure Bath of Michigan — 6 overdue portal tasks · 1 stalled stage +1 more");
    expect(g.facts.oldest_overdue_days).toBe(19);
    expect(g.facts.primary_blocker).toBe("Provide CRM login");
    expect(g.facts.owner_split).toMatchObject({ bizgrips: 1, client: 1 });
    expect(g.summary).toContain("Primary blocker: Provide CRM login");
    expect(g.summary).toContain("Oldest item is 19 days overdue");
  });
  it("needs at least MIN_GROUP_SIZE members; the same client's billing and delivery issues form separate groups", () => {
    expect(MIN_GROUP_SIZE).toBe(2);
    const plans = planGroups(
      input({
        alerts: [
          alert({ id: "a1", fingerprint: "portal_task_overdue:c1", kind: "finding", ref_id: "f1", category: "portal_task_overdue", title: "Pure Bath of Michigan: 2 overdue tasks" }),
          alert({ id: "a2", fingerprint: "client_unpaid_invoice:c1", kind: "finding", ref_id: "f2", category: "client_unpaid_invoice", title: "Pure Bath of Michigan: 1 unpaid invoice" }),
          alert({ id: "a3", fingerprint: "failed_payment:c1", kind: "finding", ref_id: "f3", category: "failed_payment", title: "Pure Bath of Michigan payment failed" }),
        ],
        findings: [finding({ id: "f1", category: "portal_task_overdue" }), finding({ id: "f2", category: "client_unpaid_invoice" }), finding({ id: "f3", category: "failed_payment" })],
      }),
    );
    expect(plans.map((p) => p.group_key)).toEqual(["client:c1:money"]);
    expect(plans[0]!.members).toHaveLength(2);
  });
  it("free-text obligations join the client's dominant categorized family (tie-breaker), marked semantic", () => {
    const plans = planGroups(
      input({
        alerts: [alert({ id: "a1", fingerprint: "portal_task_overdue:c2", kind: "finding", ref_id: "f1", category: "portal_task_overdue", title: "Northwind Roofing: 3 overdue tasks" })],
        findings: [finding({ id: "f1", category: "portal_task_overdue" })],
        obligations: [obligation({ id: "o1", title: "Send Northwind Roofing the revised timeline" }), obligation({ id: "o2", title: "Buy milk", scope: "personal" })],
      }),
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]!.group_key).toBe("client:c2:delivery");
    const ob = plans[0]!.members.find((m) => m.member_kind === "obligation");
    expect(ob?.member_id).toBe("o1");
    expect(ob?.key_source).toBe("semantic");
    expect(ob?.detail.days_overdue).toBe(4);
  });
  it("goal alerts, goal findings and goal-linked obligations group per goal; snoozed/grouped members still count, resolved ones do not", () => {
    const plans = planGroups(
      input({
        alerts: [
          alert({ id: "a1", fingerprint: "goal:g1", kind: "goal", ref_id: "g1", category: "goal_trajectory", title: "Onboard 10 clients: at risk", status: "grouped" }),
          alert({ id: "a2", fingerprint: "goal_coach:g1", kind: "finding", ref_id: "f1", category: "goal_coach", title: "Coach", status: "snoozed" }),
          alert({ id: "a3", fingerprint: "goal:g2", kind: "goal", ref_id: "g2", category: "goal_trajectory", title: "MRR", status: "resolved" }),
        ],
        findings: [finding({ id: "f1", category: "goal_coach", goal_id: "g1" })],
        obligations: [obligation({ id: "o1", title: "Book 3 discovery calls", related_goal_id: "g1" })],
        goalNames: new Map([["g1", "Onboard 10 clients"]]),
      }),
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]!.group_key).toBe("goal:g1:all");
    expect(plans[0]!.entity_name).toBe("Onboard 10 clients");
    expect(plans[0]!.members).toHaveLength(3);
    expect(plans[0]!.member_hash).toMatch(/^[0-9a-f]{8}$/);
  });
  it("member hash is stable across ordering and changes when the member set changes", () => {
    const base = input({
      alerts: [alert({ id: "a1", fingerprint: "automation_failure:wf1", kind: "finding", ref_id: "f1", category: "automation_failure", title: "wf1 failing" }), alert({ id: "a2", fingerprint: "repeated_error:wf1", kind: "finding", ref_id: "f2", category: "repeated_error", title: "wf1 errors" })],
      findings: [finding({ id: "f1", category: "automation_failure" }), finding({ id: "f2", category: "repeated_error" })],
    });
    const h1 = planGroups(base)[0]!.member_hash;
    const h2 = planGroups({ ...base, alerts: [...base.alerts].reverse() })[0]!.member_hash;
    const h3 = planGroups({ ...base, alerts: [...base.alerts, alert({ id: "a3", fingerprint: "webhook_broken:wf1", kind: "finding", ref_id: "f3", category: "webhook_broken", title: "hook" })], findings: [...base.findings, finding({ id: "f3", category: "webhook_broken" })] })[0]!.member_hash;
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(planGroups(base)[0]!.group_key).toBe("workflow:wf1:all");
  });
  it("skips group parents, system alerts and blind spots", () => {
    const plans = planGroups(
      input({
        alerts: [
          alert({ id: "a1", fingerprint: "group:client:c1:delivery", kind: "group", ref_id: "grp", category: "delivery", title: "Pure Bath of Michigan — 6 overdue portal tasks" }),
          alert({ id: "a2", fingerprint: "blindspot:x", kind: "finding", ref_id: "f1", category: "blind_spot", title: "Pure Bath of Michigan: blind spot" }),
          alert({ id: "a3", fingerprint: "system:x", kind: "system", title: "Pure Bath of Michigan sync" }),
        ],
        findings: [finding({ id: "f1", category: "blind_spot" })],
      }),
    );
    expect(plans).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Summary                                                              */
/* ------------------------------------------------------------------ */
describe("grouping summary", () => {
  const members: SummaryMember[] = [
    { member_kind: "alert", title: "Tasks", importance: "important", detail: { kind: "finding", category: "portal_task_overdue", due_at: null, days_overdue: 12, owner: "BizGrips", priority: "high", status: "open", notes: null, blocking: false, source: "finding", href: "/insights", count: 4 } },
    { member_kind: "obligation", title: "Get CRM access", importance: "urgent", detail: { kind: "obligation", category: null, due_at: "2026-09-01T00:00:00Z", days_overdue: 13, owner: "Pure Bath", priority: "critical", status: "waiting_on_other", notes: null, blocking: false, source: "portal", href: "/follow-through" } },
  ];
  it("counts records, picks the oldest overdue and a primary blocker, and splits owners", () => {
    const f = computeFacts(members);
    expect(f.member_count).toBe(2);
    expect(f.record_count).toBe(5);
    expect(f.oldest_overdue_days).toBe(13);
    expect(f.primary_blocker).toBe("Get CRM access");
    expect(f.owner_split).toEqual({ bizgrips: 1, client: 0, you: 0, other: 1 });
    expect(f.urgent).toBe(1);
    expect(f.sources).toEqual(["finding", "portal"]);
  });
  it("titles read '<entity> — <headline>' and summaries stay deterministic", () => {
    const { title, summary } = buildSummary({ entity: { kind: "client", id: "c1", name: "Pure Bath of Michigan", source: "structured" }, issue: "delivery", members, now: NOW });
    expect(title).toBe("Pure Bath of Michigan — 4 overdue portal tasks · 1 open follow-through item");
    expect(summary).toContain("2 related signals across finding, portal point at one delivery situation for Pure Bath of Michigan.");
    expect(summary).toContain("Owner split: 1 owed by BizGrips, 1 waiting on others.");
    expect(summary).toContain("1 of these is urgent.");
  });
});

/* ------------------------------------------------------------------ */
/* Alert engine / push / brain / briefing integration (pure parts)      */
/* ------------------------------------------------------------------ */
describe("grouping integration (pure)", () => {
  it("reconcileAlerts leaves group parents to the grouping engine and resolves grouped members whose condition cleared", () => {
    const existing: ExistingAlert[] = [
      { id: "p", fingerprint: "group:client:c1:delivery", status: "open", importance: "important", occurrences: 3, snoozed_until: null, cooldown_until: null, resolved_at: null, last_seen: NOW.toISOString() },
      { id: "m", fingerprint: "portal_task_overdue:c1", status: "grouped", importance: "important", occurrences: 2, snoozed_until: null, cooldown_until: null, resolved_at: null, last_seen: NOW.toISOString() },
      { id: "k", fingerprint: "portal_stage_stalled:s7", status: "grouped", importance: "briefing", occurrences: 1, snoozed_until: null, cooldown_until: null, resolved_at: null, last_seen: NOW.toISOString() },
    ];
    const still: AlertCandidate = { fingerprint: "portal_task_overdue:c1", kind: "finding", ref_id: "f1", category: "portal_task_overdue", scope: "business", title: "t", summary: "s", evidence: [], importance: "important", surfaced: true, deferred_until: null, trace: { base: "", rules: [], settings: [] } };
    const plan = reconcileAlerts(existing, [still], NOW);
    expect(plan.resolve).toEqual(["k"]); // the parent is never touched here; the seen member is patched, not re-opened
    expect(plan.update.map((u) => u.id)).toEqual(["m"]);
    expect(plan.update[0]!.patch.status).toBeUndefined();
  });
  it("groups push once per importance and again only after growing by 3+ members", () => {
    const settings = { push_alerts: true, push_goal_alerts: true, push_opportunity_alerts: true, timezone: "America/Denver", quiet_hours_start: "21:00", quiet_hours_end: "07:00" };
    const DAY = new Date("2026-09-12T20:00:00Z");
    const g = { id: "p", kind: "group", category: "delivery", status: "open", importance: "important" as const, deferred_until: null, pushed_at: null, pushed_importance: null, member_count: 6, member_count_pushed: 0 };
    expect(shouldPushAlert(g, settings, DAY)).toBe(true);
    const pushed = { ...g, pushed_at: DAY.toISOString(), pushed_importance: "important", member_count_pushed: 6 };
    expect(shouldPushAlert({ ...pushed, member_count: 7 }, settings, DAY)).toBe(false);
    expect(shouldPushAlert({ ...pushed, member_count: 6 + GROUP_REPUSH_GROWTH }, settings, DAY)).toBe(true);
    expect(shouldPushAlert({ ...pushed, member_count: 7, importance: "urgent" }, settings, DAY)).toBe(true);
    expect(alertEmoji({ kind: "group", category: "delivery", importance: "important" })).toBe("🗂️");
  });
  it("brain state counts a group as ONE attention item and collapses its member obligations", () => {
    const s = computeBrainState({
      now: NOW,
      alerts: [{ id: "p", kind: "group", category: "delivery", importance: "important", status: "open", title: "Pure Bath of Michigan — 6 overdue portal tasks", summary: "…", ref_id: "grp1", evidence: [], member_count: 6 }],
      findings: [],
      goals: [],
      obligations: [
        { id: "o1", title: "CRM access", status: "overdue", bucket: "overdue", priority: "high", scope: "business", due_at: "2026-09-01T00:00:00Z", related_goal_id: null, related_client_id: "c1", has_money: false, group_id: "grp1", group_title: "Pure Bath of Michigan — 6 overdue portal tasks" },
        { id: "o2", title: "Timeline", status: "overdue", bucket: "overdue", priority: "high", scope: "business", due_at: "2026-09-02T00:00:00Z", related_goal_id: null, related_client_id: "c1", has_money: false, group_id: "grp1", group_title: "Pure Bath of Michigan — 6 overdue portal tasks" },
        { id: "o3", title: "Northwind estimate", status: "overdue", bucket: "overdue", priority: "high", scope: "business", due_at: "2026-09-02T00:00:00Z", related_goal_id: null, related_client_id: "c2", has_money: true, group_id: "grp2", group_title: "Northwind Roofing — 2 open follow-through items" },
        { id: "o4", title: "Northwind contract", status: "overdue", bucket: "overdue", priority: "high", scope: "business", due_at: "2026-09-03T00:00:00Z", related_goal_id: null, related_client_id: "c2", has_money: true, group_id: "grp2", group_title: "Northwind Roofing — 2 open follow-through items" },
      ],
      connections: [],
      jobRuns: [],
    });
    expect(s.reasons.attention).toHaveLength(1);
    expect(s.reasons.attention[0]).toMatchObject({ id: "group:grp1", kind: "group", detail: "6 related signals · one situation" });
    // grp1 members vanish (already counted); grp2 collapses into one follow-through row.
    expect(s.reasons.followThrough).toHaveLength(1);
    expect(s.reasons.followThrough[0]).toMatchObject({ id: "group:grp2", kind: "group", title: "Northwind Roofing — 2 open follow-through items" });
    expect(s.reasons.followThrough[0]!.detail).toMatch(/^2 items · \d+ days overdue$/);
    expect(attentionCountOf(s.reasons)).toBe(2);
  });
  it("briefing attention ranks a group as one item and skips obligations it already covers", () => {
    const items = rankAttention([{ id: "p", kind: "group", category: "delivery", importance: "important", title: "Pure Bath of Michigan — 6 overdue portal tasks", summary: "Oldest 19 days.", ref_id: "grp1", occurrences: 6, status: "open" }], []);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ ref_kind: "alert", ref_id: "p", detail: "6 related signals. Oldest 19 days." });
    const bundle: BriefingBundle = {
      kind: "daily",
      period_start: "2026-09-14",
      period_end: "2026-09-14",
      timezone: "America/Denver",
      owner_first_name: "Noah",
      now: NOW,
      alerts: [{ id: "p", kind: "group", category: "delivery", importance: "important", title: "Pure Bath of Michigan — 6 overdue portal tasks", summary: null, ref_id: "grp1", occurrences: 6, status: "open" }],
      goals: [],
      events_today: [],
      commitments: [],
      obligations: [
        { id: "o1", group_id: "grp1", title: "CRM access", bucket: "overdue", due_at: "2026-09-01T00:00:00Z", priority: "high", tracking_mode: "persistent", waiting_on: null, related_goal_id: null, scope: "business", amount_label: null, briefing_only: false, question: null },
        { id: "o2", group_id: null, title: "Send Sam the estimate", bucket: "overdue", due_at: "2026-09-10T00:00:00Z", priority: "normal", tracking_mode: "persistent", waiting_on: null, related_goal_id: null, scope: "business", amount_label: null, briefing_only: false, question: null },
      ],
      findings: [],
      finance: null,
      missions: [],
      outcomes: [],
      freshness: [],
      memories: [],
      briefing_rules: [],
      max_items: 3,
    };
    const t = buildTemplate(bundle);
    expect(t.today.map((i) => i.ref_id)).toEqual(["o2"]);
    expect(t.top_attention.map((i) => i.title)).toEqual(["Pure Bath of Michigan — 6 overdue portal tasks"]);
  });
});
