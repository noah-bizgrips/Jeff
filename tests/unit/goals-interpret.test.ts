import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/gomez/budget", () => ({ budgetStatus: vi.fn(async () => ({ spentUsd: 0, budgetUsd: 2, exhausted: false })), recordUsage: vi.fn(async () => 0) }));

const { preParseGoal, preParseCoverage, interpretGoal, mergeInterpretations } = await import("@/lib/gomez/goals/interpret");
const { GoalInterpretationSchema } = await import("@/lib/gomez/goals/schema");

const SENTENCE = "Onboard 10 new clients in the next 60 days with a CAC under $1000 and a sign date to first payment date in under 14 days.";
const NOW = new Date("2026-09-12T12:00:00Z");

describe("§49 goal acceptance — deterministic pre-parse", () => {
  const pre = preParseGoal(SENTENCE, NOW);
  const interp = GoalInterpretationSchema.parse(pre.interpretation);
  const byKey = Object.fromEntries(interp.metrics.map((m) => [m.key, m]));

  it("identifies 10 clients over a 60-day window as the primary metric", () => {
    expect(interp.timeframe.days).toBe(60);
    expect(byKey.clients_onboarded).toMatchObject({ kind: "count", target: 10, comparator: "gte", is_primary: true });
    expect(byKey.clients_onboarded!.inputs.value).toMatchObject({ provider: "highlevel", resource_type: "opportunity", filter: { status_in: ["won"] } });
  });

  it("identifies CAC < $1,000 sourced from Meta spend and HighLevel wins", () => {
    expect(byKey.cac).toMatchObject({ kind: "currency", target: 100000, comparator: "lte", is_constraint: true });
    expect(byKey.cac!.formula).toBe("ad_spend / clients_acquired");
    expect(byKey.cac!.inputs.ad_spend).toMatchObject({ provider: "meta", resource_type: "ad_insight", field: "spend" });
    expect(byKey.cac!.inputs.clients_acquired).toMatchObject({ provider: "highlevel" });
  });

  it("identifies sign→payment < 14 days sourced from HighLevel and Stripe", () => {
    expect(byKey.sign_to_first_payment_days).toMatchObject({ kind: "duration_days", target: 14, comparator: "lte", is_constraint: true });
    expect(byKey.sign_to_first_payment_days!.inputs.signed).toMatchObject({ provider: "highlevel" });
    expect(byKey.sign_to_first_payment_days!.inputs.paid).toMatchObject({ provider: "stripe", resource_type: "charge" });
    expect(byKey.sign_to_first_payment_days!.duration).toMatchObject({ start: "signed", end: "paid" });
  });

  it("surfaces the three required ambiguities", () => {
    const fields = interp.ambiguities.map((a) => a.field);
    expect(fields).toContain("cac.definition");
    expect(fields).toContain("sign_to_first_payment_days.sign_date");
    expect(fields).toContain("sign_to_first_payment_days.aggregation");
    const agg = interp.ambiguities.find((a) => a.field === "sign_to_first_payment_days.aggregation")!;
    expect(agg.options.join(" ")).toMatch(/median/i);
    expect(agg.options.join(" ")).toMatch(/average/i);
    expect(agg.options.join(" ")).toMatch(/every client/i);
  });

  it("records the client-definition assumption and funnel drivers", () => {
    expect(interp.assumptions.join(" ")).toMatch(/won/i);
    expect(interp.drivers.map((d) => d.key)).toEqual(["qualified_leads", "booked_appointments", "signed"]);
  });

  it("covers most of the sentence deterministically", () => {
    expect(preParseCoverage(SENTENCE, pre.matched)).toBeGreaterThan(0.6);
  });
});

describe("other goal shapes", () => {
  it("parses MRR with a month deadline and asks about the month boundary", () => {
    const i = GoalInterpretationSchema.parse(preParseGoal("Reach $150k MRR by June while maintaining at least 70% gross margin", NOW).interpretation);
    expect(i.metrics.find((m) => m.key === "mrr")).toMatchObject({ target: 15000000, comparator: "gte", is_primary: true });
    expect(i.metrics.find((m) => m.key === "gross_margin_pct")).toMatchObject({ target: 70, is_constraint: true });
    expect(i.timeframe.end).toBe("2027-06-30");
    expect(i.ambiguities.some((a) => a.field === "timeframe.end")).toBe(true);
    expect(i.scope).toBe("financial");
  });

  it("parses an operating reserve", () => {
    const i = GoalInterpretationSchema.parse(preParseGoal("Build a $200,000 operating reserve by June.", NOW).interpretation);
    expect(i.metrics.find((m) => m.key === "cash_reserve")).toMatchObject({ target: 20000000, comparator: "gte" });
    expect(i.metrics[0]!.inputs.value).toMatchObject({ provider: "plaid", resource_type: "account" });
  });

  it("parses lead response time in minutes", () => {
    const i = GoalInterpretationSchema.parse(preParseGoal("Reduce average lead response time below 3 minutes.", NOW).interpretation);
    expect(i.metrics.find((m) => m.key === "lead_response_minutes")).toMatchObject({ target: 3, unit: "minutes", comparator: "lte" });
  });

  it("asks for a timeframe when none is given", () => {
    const i = GoalInterpretationSchema.parse(preParseGoal("Sign 5 new clients", NOW).interpretation);
    expect(i.ambiguities.some((a) => a.field === "timeframe")).toBe(true);
  });
});

describe("interpretGoal with the model", () => {
  it("returns the deterministic parse without calling the model when coverage is high", async () => {
    const create = vi.fn();
    const r = await interpretGoal("owner", SENTENCE, { client: { create } as never, now: NOW });
    expect(create).not.toHaveBeenCalled();
    expect(r.usedModel).toBe(false);
    expect(r.interpretation.metrics.map((m) => m.key)).toEqual(["clients_onboarded", "cac", "sign_to_first_payment_days"]);
  });

  it("merges a validated model interpretation for unrecognised sentences and keeps pre-parsed metrics", async () => {
    const create = vi.fn(async () => ({
      model: "claude-test",
      usage: { input_tokens: 10, output_tokens: 10 },
      content: [
        {
          type: "tool_use",
          id: "t1",
          name: "goal_interpretation",
          input: {
            name: "Referral partners",
            outcome: "Sign three referral partners",
            timeframe: { start: null, end: null, days: 90 },
            metrics: [{ key: "partners_signed", name: "Referral partners signed", kind: "count", target: 3, comparator: "gte", unit: "partners", formula: "", inputs: { value: { provider: "highlevel", resource_type: "contact", filter: { tags_any: ["partner"] }, aggregation: "count" } }, time_range: { kind: "goal_window" }, is_primary: true, is_constraint: false }],
            assumptions: ["Partners are HighLevel contacts tagged 'partner'."],
            ambiguities: [{ field: "partner.definition", question: "What makes a contact a referral partner?", options: ["Tag 'partner'", "A specific pipeline"] }],
            scope: "business",
            confidence: 0.6,
          },
        },
      ],
    }));
    const r = await interpretGoal("owner", "Line up three referral partnerships with local realtors this quarter", { client: { create } as never, now: NOW });
    expect(create).toHaveBeenCalledTimes(1);
    expect(r.usedModel).toBe(true);
    expect(r.interpretation.metrics[0]!.key).toBe("partners_signed");
    expect(r.interpretation.ambiguities[0]!.field).toBe("partner.definition");
  });

  it("falls back to the deterministic parse when the model output fails validation", async () => {
    const create = vi.fn(async () => ({ model: "claude-test", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", id: "t", name: "goal_interpretation", input: { name: "x" } }] }));
    const r = await interpretGoal("owner", "Get 4 new clients and also do some stuff that is hard to parse and unrelated words here everywhere", { client: { create } as never, now: NOW });
    expect(r.interpretation.metrics[0]!.key).toBe("clients_onboarded");
    expect(r.notes.join(" ")).toMatch(/did not validate/);
  });

  it("never calls the network when no client is available", async () => {
    const r = await interpretGoal("owner", "Something entirely unmeasurable", { client: null, now: NOW });
    expect(r.usedModel).toBe(false);
    expect(r.interpretation.metrics[0]!.key).toBe("progress");
    expect(r.interpretation.ambiguities.length).toBeGreaterThan(0);
  });
});

describe("mergeInterpretations", () => {
  it("keeps pre-parsed metrics authoritative and adds model extras", () => {
    const pre = GoalInterpretationSchema.parse(preParseGoal(SENTENCE, NOW).interpretation);
    const ai = GoalInterpretationSchema.parse({ ...pre, metrics: [{ ...pre.metrics[0]!, target: 99 }, { ...pre.metrics[0]!, key: "extra_metric", is_primary: false }], ambiguities: [{ field: "new.one", question: "?", options: ["a"] }] });
    const merged = mergeInterpretations(pre, ai);
    expect(merged.metrics.find((m) => m.key === "clients_onboarded")!.target).toBe(10);
    expect(merged.metrics.some((m) => m.key === "extra_metric")).toBe(true);
    expect(merged.ambiguities.some((a) => a.field === "new.one")).toBe(true);
  });
});
