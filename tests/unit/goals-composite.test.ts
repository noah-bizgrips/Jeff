import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/jeff/budget", () => ({ budgetStatus: vi.fn(async () => ({ spentUsd: 0, budgetUsd: 2, exhausted: false })), recordUsage: vi.fn(async () => 0) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => { throw new Error("no db in unit tests"); } }));

const { computeMetric, emailHashOf, buildIdentityIndex, identityKeys } = await import("@/lib/jeff/goals/metrics");
const { GoalMetricSchema, GoalInterpretationSchema, GOAL_INTERPRETATION_JSON_SCHEMA, fromToolInput } = await import("@/lib/jeff/goals/schema");
const { preParseAnchor, preParseBaseline, preParseGoal, isDetailedBrief, interpretGoal, applyAnchorResolution, GOAL_PROMPT_MAX_CHARS } = await import("@/lib/jeff/goals/interpret");
const { applyDefinitionResolutions } = await import("@/lib/jeff/goals/store");
const { rankAnchorCandidates } = await import("@/lib/jeff/goals/anchor");
const { inventoryOf } = await import("@/lib/integrations/sync/portal");
const { describeInput } = await import("@/lib/jeff/goals/format");

type Row = import("@/lib/jeff/goals/metrics").MetricRow;

const NOW = new Date("2026-10-01T12:00:00Z");
const WINDOW = { start: "2026-08-20T00:00:00Z", end: "2026-10-19T00:00:00Z" };
const CONNECTED = ["portal", "google", "highlevel", "stripe", "meta"].map((provider) => ({ provider, status: "connected", last_sync_at: "2026-10-01T11:00:00Z" }));

function row(p: Partial<Row> & { provider: string; resource_type: string; external_id: string }): Row {
  return { id: `id-${p.provider}-${p.external_id}`, capability: null, title: null, source_timestamp: "2026-09-15T00:00:00Z", synced_at: "2026-10-01T11:00:00Z", tags: [], metadata: {}, ...p };
}

const steve = "steve@seaverbaths.com";
const dana = "dana@danakitchens.com";
const test1 = "qa@bizgrips.com";
const pat = "pat@patroofing.com";

// Portal: four accounts. Steve (validated), Dana (no Right Fit Call), a test account (tagged), Pat (churned).
const ROWS: Row[] = [
  row({ provider: "portal", resource_type: "client", external_id: "1", title: "Seaver Baths", metadata: { status: "active_setup", created_at: "2026-08-20T10:00:00Z", client_users: [{ email_hash: emailHashOf(steve) }] } }),
  row({ provider: "portal", resource_type: "client", external_id: "2", title: "Dana Kitchens", metadata: { status: "active_setup", created_at: "2026-09-01T10:00:00Z", client_users: [] } }),
  row({ provider: "portal", resource_type: "client_user", external_id: "u2", metadata: { client_id: "2", email_hash: emailHashOf(dana), status: "active" } }),
  row({ provider: "portal", resource_type: "client", external_id: "3", title: "QA Test Co", tags: ["portal", "client", "test"], metadata: { status: "active_setup", created_at: "2026-09-02T10:00:00Z", client_users: [{ email_hash: emailHashOf(test1) }] } }),
  row({ provider: "portal", resource_type: "client", external_id: "4", title: "Pat Roofing", metadata: { status: "churned", created_at: "2026-09-03T10:00:00Z", client_users: [{ email_hash: emailHashOf(pat) }] } }),
  // Google Calendar: Right Fit Calls for Steve and the test account; Dana only had a "Coffee chat".
  row({ provider: "google", resource_type: "event", external_id: "ev1", title: "Right Fit Call — Steve", source_timestamp: "2026-08-25T15:00:00Z", metadata: { attendees: ["noah@bizgrips.com", "Steve@SeaverBaths.com"] } }),
  row({ provider: "google", resource_type: "event", external_id: "ev2", title: "Coffee chat", source_timestamp: "2026-09-05T15:00:00Z", metadata: { attendees: [dana] } }),
  row({ provider: "google", resource_type: "event", external_id: "ev3", title: "Right Fit Call — QA", source_timestamp: "2026-09-06T15:00:00Z", metadata: { attendees: [test1] } }),
  row({ provider: "google", resource_type: "event", external_id: "ev4", title: "Right Fit Call — Pat", source_timestamp: "2026-09-07T15:00:00Z", metadata: { attendees: [pat] } }),
  // HighLevel: contacts + conversations (message rows point at contactId).
  row({ provider: "highlevel", resource_type: "contact", external_id: "c-steve", metadata: { email_hash: emailHashOf(steve) } }),
  row({ provider: "highlevel", resource_type: "contact", external_id: "c-dana", metadata: { email_hash: emailHashOf(dana) } }),
  row({ provider: "highlevel", resource_type: "contact", external_id: "c-pat", metadata: { email_hash: emailHashOf(pat) } }),
  row({ provider: "highlevel", resource_type: "message", external_id: "m1", metadata: { contactId: "c-steve", lastMessageDate: "2026-07-01T00:00:00Z" }, source_timestamp: "2026-07-01T00:00:00Z" }),
  row({ provider: "highlevel", resource_type: "message", external_id: "m2", metadata: { contactId: "c-dana", lastMessageDate: "2026-09-02T00:00:00Z" }, source_timestamp: "2026-09-02T00:00:00Z" }),
  row({ provider: "highlevel", resource_type: "message", external_id: "m3", metadata: { contactId: "c-pat" } }),
  // Gmail: contract sent to Steve (Aug 21) and Dana (Sep 2).
  row({ provider: "google", resource_type: "email", external_id: "g1", title: "Your BizGrips agreement — please sign", source_timestamp: "2026-08-21T12:00:00Z", metadata: { to: [steve] } }),
  row({ provider: "google", resource_type: "email", external_id: "g2", title: "Contract for Dana Kitchens", source_timestamp: "2026-09-02T12:00:00Z", metadata: { to: [dana] } }),
  // Stripe: Steve paid 9 days after the contract; Dana paid 20 days after.
  row({ provider: "stripe", resource_type: "customer", external_id: "cus_s", metadata: { email_hash: emailHashOf(steve) } }),
  row({ provider: "stripe", resource_type: "customer", external_id: "cus_d", metadata: { email_hash: emailHashOf(dana) } }),
  row({ provider: "stripe", resource_type: "invoice", external_id: "in_s", title: "INV-1 · paid · $1,500.00 · Seaver", source_timestamp: "2026-08-30T12:00:00Z", metadata: { status: "paid", paid: true, amount_paid: 150000, customerId: "cus_s", number: "INV-1" } }),
  row({ provider: "stripe", resource_type: "invoice", external_id: "in_d", title: "INV-2 · paid", source_timestamp: "2026-09-22T12:00:00Z", metadata: { status: "paid", paid: true, amount_paid: 150000, customerId: "cus_d" } }),
  // Meta: two campaign-days, one not a BizGrips ad set.
  row({ provider: "meta", resource_type: "ad_insight", external_id: "a1", title: "BizGrips — Bath Pros · 2026-09-01", source_timestamp: "2026-09-01T00:00:00Z", metadata: { spend: 60000, campaign_name: "BizGrips — Bath Pros" } }),
  row({ provider: "meta", resource_type: "ad_insight", external_id: "a2", title: "BizGrips — Roofers · 2026-09-02", source_timestamp: "2026-09-02T00:00:00Z", metadata: { spend: 40000, campaign_name: "BizGrips — Roofers" } }),
  row({ provider: "meta", resource_type: "ad_insight", external_id: "a3", title: "Client: Pure Bath · 2026-09-02", source_timestamp: "2026-09-02T00:00:00Z", metadata: { spend: 999900, campaign_name: "Client: Pure Bath" } }),
];

const VALIDATED_CLIENT_INPUT = {
  provider: "portal",
  resource_type: "client",
  filter: { status_not_in: ["churned"], tags_none: ["test"] },
  aggregation: "count",
  distinct_by: "client_id",
  timestamp_field: "created_at",
  require_match: [
    { provider: "google", resource_type: "event", filter: { title_contains: ["Right Fit Call"] }, via: "email_hash", in_window: true, label: "a Right Fit Call on the calendar" },
    { provider: "highlevel", resource_type: "message", filter: {}, via: "email_hash", in_window: false, label: "a HighLevel conversation" },
  ],
};

describe("identity resolution", () => {
  it("reduces records from every source to the same hashed email", () => {
    const idx = buildIdentityIndex(ROWS);
    const h = emailHashOf(steve)!;
    expect(identityKeys(ROWS[0]!, "email_hash", idx)).toEqual([h]); // portal client via its users
    expect(identityKeys(ROWS.find((r) => r.external_id === "ev1")!, "email_hash", idx)).toContain(h); // attendee, case-insensitive
    expect(identityKeys(ROWS.find((r) => r.external_id === "m1")!, "email_hash", idx)).toEqual([h]); // contactId → contact
    expect(identityKeys(ROWS.find((r) => r.external_id === "in_s")!, "email_hash", idx)).toEqual([h]); // customerId → customer
    expect(identityKeys(ROWS.find((r) => r.external_id === "g1")!, "email_hash", idx)).toEqual([h]); // recipient
    expect(identityKeys(ROWS.find((r) => r.external_id === "u2")!, "client_id", idx)).toEqual(["2"]);
    expect(identityKeys(ROWS.find((r) => r.external_id === "m2")!, "client_id", idx)).toEqual(["2"]); // message → contact email → portal client
  });
});

describe("validated clients (portal + calendar + CRM, exclusions hard)", () => {
  const metric = GoalMetricSchema.parse({ key: "validated_clients", name: "Validated clients", kind: "count", target: 10, comparator: "gte", unit: "clients", formula: "", inputs: { value: VALIDATED_CLIENT_INPUT }, time_range: { kind: "goal_window" }, is_primary: true, is_constraint: false });

  it("counts only accounts with a Right Fit Call in the window and a HighLevel conversation, never test or churned accounts", () => {
    const r = computeMetric(metric, ROWS, CONNECTED, WINDOW, NOW);
    expect(r.value).toBe(1); // Steve only: Dana had no Right Fit Call; QA is a test account; Pat churned
    expect(r.sample_size).toBe(1);
    expect(r.freshness).toBe("fresh");
    expect(r.limitations.join(" ")).toMatch(/1 client did not meet every condition/);
    expect(r.source).toMatch(/Client Portal clients \(excluding churned; not tagged test\) with a Right Fit Call on the calendar and a HighLevel conversation · distinct clients/);
  });

  it("reports a missing source as unknown, not zero", () => {
    const r = computeMetric(metric, ROWS, CONNECTED.filter((c) => c.provider !== "google"), WINDOW, NOW);
    expect(r.freshness).toBe("missing");
    expect(r.limitations.join(" ")).toMatch(/Google not connected/);
  });

  it("drives CAC from Meta spend on the named ad sets only", () => {
    const cac = GoalMetricSchema.parse({
      key: "cac",
      name: "CAC",
      kind: "currency",
      target: 100000,
      comparator: "lte",
      unit: "usd",
      formula: "ad_spend / clients",
      inputs: { ad_spend: { provider: "meta", resource_type: "ad_insight", filter: { title_contains: ["BizGrips"] }, aggregation: "sum", field: "spend" }, clients: VALIDATED_CLIENT_INPUT },
      time_range: { kind: "goal_window" },
      is_primary: false,
      is_constraint: true,
    });
    const r = computeMetric(cac, ROWS, CONNECTED, WINDOW, NOW);
    expect(r.value).toBe(100000); // $1,000 spend / 1 validated client
    expect(r.meets_target).toBe(true);
  });

  it("measures sign→first payment per client through email identity and reports the slowest when every client must be under target", () => {
    const cycle = GoalMetricSchema.parse({
      key: "sign_to_payment",
      name: "Sign to first payment",
      kind: "duration_days",
      target: 14,
      comparator: "lte",
      unit: "days",
      formula: "",
      inputs: {
        signed: { provider: "google", resource_type: "email", filter: { title_contains: ["contract", "agreement"] }, aggregation: "count" },
        paid: { provider: "stripe", resource_type: "invoice", filter: { status_in: ["paid"] }, aggregation: "count" },
      },
      duration: { start: "signed", end: "paid", join: { via: "email_hash", aggregation: "max" } },
      time_range: { kind: "goal_window" },
      is_primary: false,
      is_constraint: true,
    });
    const r = computeMetric(cycle, ROWS, CONNECTED, WINDOW, NOW);
    expect(r.value).toBe(20); // Dana: Sep 2 → Sep 22; Steve: 9 days
    expect(r.sample_size).toBe(2);
    expect(r.meets_target).toBe(false);
    expect(r.limitations.join(" ")).toMatch(/1 of 2 matched pairs meet the target individually \(metric reports the slowest\)/);
  });
});

describe("anchored timeframes", () => {
  it("recognises 'starting from <name>'s sign date'", () => {
    const a = preParseAnchor("Onboard 10 new clients in 60 days, starting from Steve Seaver's sign date (Steve = client #1).");
    expect(a?.anchor).toEqual({ description: "Steve Seaver's sign date", search_terms: ["Steve Seaver", "Seaver", "Steve"], event: "signed" });
    expect(preParseAnchor("measured from Acme Corp's first payment date")?.anchor.event).toBe("first_payment");
    expect(preParseAnchor("in the next 60 days")).toBeNull();
  });

  it("ranks candidate dates by the kind of moment and asks the owner to confirm", () => {
    const res = rankAnchorCandidates(
      [
        { provider: "stripe", resource_type: "invoice", title: "INV-1 · paid · Seaver", author: null, source_timestamp: "2026-08-30T12:00:00Z", metadata: { paid: true, number: "INV-1" } },
        { provider: "google", resource_type: "email", title: "Your BizGrips agreement — please sign", author: "Noah", source_timestamp: "2026-08-21T12:00:00Z", metadata: { to: ["steve@seaverbaths.com"] } },
        { provider: "portal", resource_type: "client", title: "Seaver Baths", author: null, source_timestamp: null, metadata: { created_at: "2026-08-20T10:00:00Z" } },
        { provider: "google", resource_type: "email", title: "Re: lunch?", author: "Steve", source_timestamp: "2026-08-01T12:00:00Z", metadata: { to: ["noah@bizgrips.com"] } },
      ],
      { description: "Steve Seaver's sign date", search_terms: ["Steve Seaver"], event: "signed" },
    );
    expect(res.best?.date).toBe("2026-08-21");
    expect(res.best?.label).toMatch(/^Email: Your BizGrips agreement/);
    expect(res.candidates.map((c) => c.date)).toEqual(["2026-08-20", "2026-08-21", "2026-08-30"]); // lunch email ignored
    const interp = applyAnchorResolution(GoalInterpretationSchema.parse({ name: "g", outcome: "o", timeframe: { start: null, end: null, days: 60, anchor: { description: "Steve Seaver's sign date", search_terms: ["Steve Seaver"], event: "signed" } }, metrics: [{ key: "kk", name: "k", kind: "count", target: 1, comparator: "gte", unit: "", formula: "", inputs: {}, time_range: { kind: "goal_window" }, is_primary: true, is_constraint: false }] }), res);
    expect(interp.timeframe.start).toBe("2026-08-21");
    const amb = interp.ambiguities.find((a) => a.field === "timeframe.start")!;
    expect(amb.options).toHaveLength(4);
    expect(amb.options[3]).toMatch(/Another date/);
  });

  it("prefers records that name the person (fuzzy surname) over first-name-only hits", () => {
    const anchor = { description: "Steve Seaver's sign date", search_terms: ["Steve Seaver", "Seaver", "Steve"], event: "signed" as const };
    const res = rankAnchorCandidates(
      [
        { provider: "stripe", resource_type: "invoice", title: "4D201999-0019 · paid · Steve Davlin", author: "Steve Davlin", source_timestamp: "2026-06-25T00:00:00Z", metadata: { paid: true, number: "4D201999-0019" } },
        { provider: "highlevel", resource_type: "contact", title: "steve's towing", author: null, source_timestamp: "2026-05-06T00:00:00Z", metadata: { dateAdded: "2026-05-06T00:00:00Z" } },
        { provider: "highlevel", resource_type: "contact", title: "steve seever", author: null, source_timestamp: "2026-08-16T00:00:00Z", metadata: { dateAdded: "2026-08-16T00:00:00Z" } },
        { provider: "stripe", resource_type: "invoice", title: "JPXDV9KH-0001 · paid · 1,500.00 USD · Steve Seever", author: "Steve Seever", source_timestamp: "2026-09-09T00:00:00Z", metadata: { paid: true, number: "JPXDV9KH-0001" } },
      ],
      anchor,
    );
    expect(res.candidates.map((c) => c.date)).toEqual(["2026-08-16", "2026-09-09"]); // other Steves dropped
    expect(res.best?.date).toBe("2026-09-09"); // both name Seever; a paid invoice fits "signed" better than contact creation
  });

  it("still asks when nothing matches", () => {
    const interp = applyAnchorResolution(GoalInterpretationSchema.parse({ name: "g", outcome: "o", timeframe: { start: null, end: null, days: 60, anchor: { description: "X's sign date", search_terms: ["X Y"], event: "signed" } }, metrics: [{ key: "kk", name: "k", kind: "count", target: 1, comparator: "gte", unit: "", formula: "", inputs: {}, time_range: { kind: "goal_window" }, is_primary: true, is_constraint: false }] }), { best: null, candidates: [] });
    expect(interp.timeframe.start).toBeNull();
    expect(interp.ambiguities[0]!.options).toEqual(["Type the date (YYYY-MM-DD)"]);
  });
});

const BRIEF = `GOAL: Onboard 10 new clients in 60 days, starting from Steve Seaver's sign date (Steve = client #1, so 9 more needed).

METRIC 1 — Validated client count (target ≥10): count only active accounts in the BizGrips Client Portal where a "Right Fit Call" exists for the same contact email within the window and GoHighLevel conversation history exists with that contact. Removed/test accounts must NOT count and must not appear anywhere.

METRIC 2 — CAC (target ≤ $1,000 per client): Meta ad spend (BizGrips ad sets) ÷ validated clients. Open question: total Meta spend or only spend attributable to validated clients?

METRIC 3 — Sign-to-first-payment cycle time (target <14 days): Stripe invoice paid matched by email to the portal, contract-sent email matched by recipient.`;

const AI_OUTPUT = {
  name: "10 new validated clients in 60 days",
  outcome: "Onboard 10 validated clients within 60 days of Steve Seaver's sign date",
  timeframe: { start: null, end: null, days: 60, anchor: { description: "Steve Seaver's sign date", search_terms: ["Steve Seaver", "Seaver"], event: "signed" } },
  metrics: [
    { key: "validated_clients", name: "Validated clients", kind: "count", target: 10, comparator: "gte", unit: "clients", formula: "", inputs: { value: VALIDATED_CLIENT_INPUT }, time_range: { kind: "goal_window" }, is_primary: true, is_constraint: false },
    { key: "cac", name: "CAC", kind: "currency", target: 100000, comparator: "lte", unit: "usd", formula: "ad_spend / clients", inputs: { ad_spend: { provider: "meta", resource_type: "ad_insight", filter: { title_contains: ["BizGrips"] }, aggregation: "sum", field: "spend" }, clients: VALIDATED_CLIENT_INPUT }, time_range: { kind: "goal_window" }, is_primary: false, is_constraint: true },
  ],
  assumptions: ["Active = portal status other than churned."],
  ambiguities: [{ field: "cac", question: "CAC denominator: total Meta spend in the window, or only spend attributable to validated clients?", options: ["Total Meta spend on BizGrips ad sets", "Only spend attributable to validated clients"] }],
  scope: "business",
  confidence: 0.7,
};

describe("interpretGoal with a detailed brief", () => {
  it("treats a multi-line brief as detailed and caps input length", () => {
    expect(isDetailedBrief(BRIEF)).toBe(true);
    expect(isDetailedBrief("Onboard 10 new clients in 60 days")).toBe(false);
    expect(GOAL_PROMPT_MAX_CHARS).toBeGreaterThanOrEqual(BRIEF.length);
  });

  it("lets the model's reading win over the regex shapes, keeps the owner's open question, and resolves the anchor", async () => {
    const create = vi.fn(async () => ({ model: "claude-test", usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: "tool_use", id: "t1", name: "goal_interpretation", input: AI_OUTPUT }] }));
    const anchorResolver = vi.fn(async () => ({ best: { date: "2026-08-21", label: "Email: Your BizGrips agreement", provider: "google", resource_type: "email", score: 5 }, candidates: [{ date: "2026-08-21", label: "Email: Your BizGrips agreement", provider: "google", resource_type: "email", score: 5 }] }));
    const r = await interpretGoal("owner", BRIEF, { client: { create } as never, now: NOW, anchorResolver });
    expect(create).toHaveBeenCalledTimes(1);
    const sent = (create.mock.calls[0] as unknown as [{ messages: { content: string }[] }])[0].messages[0]!.content;
    expect(sent).toContain("METRIC 3"); // nothing truncated
    expect(sent).toMatch(/only a hint/);
    expect(r.interpretation.metrics.map((m) => m.key)).toEqual(["validated_clients", "cac"]); // no HighLevel-won default
    expect(r.interpretation.metrics[0]!.inputs.value!.require_match).toHaveLength(2);
    expect(r.interpretation.ambiguities.map((a) => a.field)).toEqual(["cac", "timeframe.start"]);
    expect(r.interpretation.timeframe.start).toBe("2026-08-21");
    expect(r.interpretation.timeframe.days).toBe(60);
    expect(anchorResolver).toHaveBeenCalledWith("owner", expect.objectContaining({ search_terms: ["Steve Seaver", "Seaver"] }));
  });

  it("falls back to the regex parse (with a visible note) when the model output does not validate", async () => {
    const create = vi.fn(async () => ({ model: "claude-test", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", id: "t", name: "goal_interpretation", input: { name: "x" } }] }));
    const anchorResolver = vi.fn(async () => ({ best: null, candidates: [] }));
    const r = await interpretGoal("owner", BRIEF, { client: { create } as never, now: NOW, anchorResolver });
    expect(r.interpretation.metrics[0]!.key).toBe("clients_onboarded");
    expect(r.notes.join(" ")).toMatch(/did not validate/);
    expect(r.notes.join(" ")).toMatch(/Could not find a record for Steve Seaver's sign date/);
  });
});

describe("portal client inventory", () => {
  it("lists the ids to retain and refuses to reconcile from a full page", () => {
    expect(inventoryOf({ clients: { rows: [{ id: 1 }, { id: "2" }] }, client_users: { rows: [{ id: 9 }] } } as never)).toEqual([
      { resource_type: "client", external_ids: ["1", "2"] },
      { resource_type: "client_user", external_ids: ["9"] },
    ]);
    const full = { clients: { rows: Array.from({ length: 1000 }, (_, i) => ({ id: i })) }, client_users: { rows: [] } } as never;
    expect(inventoryOf(full)).toBeUndefined();
  });
});

describe("describeInput", () => {
  it("explains exclusions and cross-source conditions in plain words", () => {
    expect(describeInput({ provider: "stripe", resource_type: "invoice", filter: { status_in: ["paid"] }, aggregation: "sum", field: "amount_paid" })).toBe("Stripe invoices (status paid) · sum(amount_paid)");
    expect(describeInput({ provider: "portal", resource_type: "client", filter: { status_not_in: ["churned"] }, require_match: [{ provider: "google", resource_type: "event", filter: { title_contains: ["Right Fit Call"] } }] })).toBe('Client Portal clients (excluding churned) with Google event (titled "Right Fit Call") · count');
  });
});

describe("strict tool schema", () => {
  it("only uses the JSON-schema subset strict tool use accepts, with at most 24 optional parameters", () => {
    const problems: string[] = [];
    let optional = 0;
    let unions = 0;
    const walk = (node: unknown, path: string) => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`));
      if (!node || typeof node !== "object") return;
      const o = node as Record<string, unknown>;
      if (Array.isArray(o.type)) problems.push(`${path}: type array`);
      if (Array.isArray(o.anyOf)) unions++;
      if (o.type === "object") {
        if (o.additionalProperties !== false) problems.push(`${path}: additionalProperties must be false`);
        const props = Object.keys((o.properties as object) ?? {});
        const req = (o.required as string[]) ?? [];
        for (const r of req) if (!props.includes(r)) problems.push(`${path}: required '${r}' not a property`);
        optional += props.filter((k) => !req.includes(k)).length;
      }
      for (const k of ["minLength", "maxLength", "minimum", "maximum", "pattern"]) if (k in o) problems.push(`${path}: ${k} unsupported`);
      for (const [k, v] of Object.entries(o)) if (k !== "enum" && k !== "required") walk(v, `${path}.${k}`);
    };
    walk(GOAL_INTERPRETATION_JSON_SCHEMA, "$");
    expect(problems).toEqual([]);
    expect(optional).toBeLessThanOrEqual(24); // API limit: "Schemas contains too many optional parameters"
    expect(unions).toBeLessThanOrEqual(16); // API limit: "too many parameters with union types"
  });

  it("treats empty filter arrays and nulls from the model as no constraint", () => {
    const full = { status_in: [], status_not_in: ["churned"], stage_contains: [], tags_any: [], tags_none: [], title_contains: [], metadata_equals: [], metadata_truthy: [], metadata_falsy: [], metadata_min: [{ key: "amount_paid", value: 100000 }] };
    const raw = { name: "g", outcome: "o", timeframe: { start: null, end: null, days: null, anchor: null }, metrics: [{ key: "clients", name: "c", kind: "count", target: 10, comparator: "gte", target_upper: null, unit: "", formula: "", baseline: 1, inputs: [{ key: "value", provider: "stripe", resource_type: "invoice", filter: full, aggregation: "count", field: "", timestamp_field: "", require_match: [], distinct_by: "email_hash" }], time_range: { kind: "goal_window", days: 0, since: "" }, is_primary: true, is_constraint: false, constraint_strength: "soft", limitations: [] }], constraints: [], milestones: [], drivers: [], assumptions: [], ambiguities: [], scope: "business", confidence: 0.5 };
    const parsed = GoalInterpretationSchema.parse(fromToolInput(raw));
    const input = parsed.metrics[0]!.inputs.value!;
    expect(input.filter).toEqual({ status_not_in: ["churned"], metadata_min: { amount_paid: 100000 } });
    expect(input.require_match).toBeUndefined();
    expect(input.field).toBeUndefined();
    expect(parsed.metrics[0]!.baseline).toBe(1);
  });

  it("converts keyed-input arrays and metadata_equals pairs into the internal map shape", () => {
    const raw = {
      name: "g",
      outcome: "o",
      timeframe: { start: null, end: null, days: 60, anchor: null },
      metrics: [
        {
          key: "cac",
          name: "CAC",
          kind: "currency",
          target: 100000,
          comparator: "lte",
          target_upper: null,
          unit: "usd",
          formula: "ad_spend / clients",
          inputs: [
            { key: "ad_spend", provider: "meta", resource_type: "ad_insight", filter: { title_contains: ["BizGrips"], metadata_equals: [{ key: "account_id", value: "123" }] }, aggregation: "sum", field: "spend", timestamp_field: null, require_match: null, distinct_by: null },
            { key: "clients", provider: "portal", resource_type: "client", filter: {}, aggregation: "count", distinct_by: "client_id", require_match: [{ provider: "highlevel", resource_type: "message", filter: {}, via: "email_hash", in_window: false, label: "a conversation" }] },
          ],
          duration: null,
          time_range: { kind: "goal_window", days: null, since: null },
          is_primary: true,
          is_constraint: false,
          constraint_strength: "soft",
          limitations: [],
        },
      ],
      constraints: [],
      milestones: [],
      drivers: [{ key: "leads", name: "Leads", input: { provider: "highlevel", resource_type: "contact", filter: {}, aggregation: "count" }, implied_target: null, assumption: "x" }],
      assumptions: [],
      ambiguities: [],
      scope: "business",
      confidence: 0.6,
    };
    const parsed = GoalInterpretationSchema.parse(fromToolInput(raw));
    expect(Object.keys(parsed.metrics[0]!.inputs)).toEqual(["ad_spend", "clients"]);
    expect(parsed.metrics[0]!.inputs.ad_spend!.filter.metadata_equals).toEqual({ account_id: "123" });
    expect(parsed.metrics[0]!.inputs.clients!.require_match![0]!.label).toBe("a conversation");
    expect(parsed.metrics[0]!.duration).toBeUndefined();
    expect(parsed.drivers[0]!.input.provider).toBe("highlevel");
  });
});

describe("already-signed clients and definition resolutions", () => {
  it("reads 'already signed counts as #1' as a baseline and an anchor", () => {
    const text = "Onboard 10 new clients in the next 60 days (Steve Seaver already signed counts as #1, so 9 more needed), with CAC under $1,000 per client.";
    expect(preParseBaseline(text)).toBe(1);
    expect(preParseBaseline("Onboard 10 new clients in 60 days")).toBe(0);
    expect(preParseAnchor(text)?.anchor).toMatchObject({ search_terms: ["Steve Seaver", "Seaver", "Steve"], event: "signed" });
    const pre = preParseGoal(text, NOW);
    expect(pre.interpretation.metrics[0]).toMatchObject({ key: "clients_onboarded", target: 10, baseline: 1 });
    expect((pre.interpretation.assumptions ?? []).join(" ")).toMatch(/1 client signed before tracking started/);
  });

  it("adds the baseline to the computed count", () => {
    const metric = GoalMetricSchema.parse({ key: "clients", name: "Clients", kind: "count", target: 10, comparator: "gte", unit: "clients", formula: "", baseline: 1, inputs: { value: VALIDATED_CLIENT_INPUT }, time_range: { kind: "goal_window" }, is_primary: true, is_constraint: false });
    const r = computeMetric(metric, ROWS, CONNECTED, WINDOW, NOW);
    expect(r.value).toBe(2);
    expect(r.limitations.join(" ")).toMatch(/Includes 1 counted before tracking started/);
  });

  it("rewrites the client metric when the owner resolves it as a Stripe first payment over $1,000", () => {
    const pre = preParseGoal("Onboard 10 new clients in the next 60 days", NOW);
    const { metrics, changed } = applyDefinitionResolutions(pre.interpretation.metrics, [{ field: "clients_onboarded.definition", resolution: "First payment received in stripe that is greater than $1000." }]);
    expect(changed).toBe(true);
    const input = metrics[0]!.inputs.value!;
    expect(input).toMatchObject({ provider: "stripe", resource_type: "invoice", distinct_by: "email_hash", filter: { status_in: ["paid"], metadata_min: { amount_paid: 100000 } } });
    const r = computeMetric(metrics[0]!, ROWS, CONNECTED, WINDOW, NOW);
    expect(r.value).toBe(2); // Steve and Dana each paid $1,500 in the window
    expect(applyDefinitionResolutions(pre.interpretation.metrics, [{ field: "clients_onboarded.definition", resolution: "Opportunity marked won in HighLevel" }]).changed).toBe(false);
  });
});
