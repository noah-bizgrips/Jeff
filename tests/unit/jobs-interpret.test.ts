import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/jeff/budget", () => ({ budgetStatus: vi.fn(async () => ({ spentUsd: 0, budgetUsd: 2, exhausted: false })), recordUsage: vi.fn(async () => 0) }));

const { preParseJob, interpretJob, JobDefinitionInterpretationSchema } = await import("@/lib/jeff/jobs/interpret");
const { clientScopeCreep } = await import("@/lib/jeff/jobs/detectors");
const { listTemplates, getTemplate } = await import("@/lib/jeff/jobs/templates");

const OWNER = "11111111-1111-4111-8111-111111111111";
const SCOPE_CREEP = "Create a job that checks every Friday for clients we do way more work for than they pay us for.";
const BLIND = "Every week, look for something important I might be missing";

describe("§87 — scope creep sentence (deterministic)", () => {
  it("becomes a weekly Friday custom job using the portal + Stripe with the client_scope_creep detector", () => {
    const pre = preParseJob(SCOPE_CREEP, ["portal", "stripe", "google"]);
    const i = JobDefinitionInterpretationSchema.parse(pre.interpretation);
    expect(i.name).toBe("Client Scope Creep Auditor");
    expect(i.slug).toBe("client-scope-creep-auditor");
    expect(i.schedule_type).toBe("weekly");
    expect(i.schedule_expression).toBe("fri 07:05");
    expect(i.detectors).toEqual(["client_scope_creep"]);
    expect(i.sources.sort()).toEqual(["portal", "stripe"]);
    expect(i.would_need).toEqual([]);
    expect(i.scope).toBe("business");
    expect(i.config).toEqual({ window_days: 30 });
    expect(i.matches_system_job).toBeNull();
    expect(i.safe).toBe(true);
    expect(i.limitations.join(" ")).toMatch(/no time tracking/);
    expect(i.notification_policy).toEqual({ min_importance: "important", push: true, briefing_only: false, max_per_day: 5 });
    expect(pre.matched).toEqual(expect.arrayContaining(["cadence:weekly", "intent:client-scope-creep-auditor"]));
  });
  it("never invents sources: unconnected providers go to would_need and the job is still safe with what is connected", () => {
    const i = preParseJob(SCOPE_CREEP, ["portal"]).interpretation;
    expect(i.sources).toEqual(["portal"]);
    expect(i.would_need).toEqual(["stripe"]);
    expect(i.limitations.join(" ")).toMatch(/Needs stripe/);
  });
});

describe("blind-spot sentence", () => {
  it("maps to the system Blind Spot Scanner weekly instead of creating a duplicate", () => {
    const pre = preParseJob(BLIND, []);
    const i = pre.interpretation;
    expect(i.detectors).toEqual(["blind_spots"]);
    expect(i.matches_system_job).toBe("blind-spot-scanner");
    expect(i.schedule_type).toBe("weekly");
    expect(i.schedule_expression).toBe("mon 07:05");
    expect(i.scope).toBe("all");
    expect(i.notification_policy.max_per_day).toBe(2); // "important" → quieter cap
    expect(i.safe).toBe(true);
  });
});

describe("cadence, policy and ambiguity parsing", () => {
  it("reads times, monthly/hourly/event cadences and briefing-only wording", () => {
    expect(preParseJob("Every month at 6pm check unpaid invoices", ["stripe"]).interpretation).toMatchObject({ schedule_type: "monthly", schedule_expression: "1 18:00", detectors: ["failed_payment", "client_unpaid_invoice"], matches_system_job: "cash-flow-watchdog" });
    expect(preParseJob("Hourly, watch for failed payments", ["stripe"]).interpretation).toMatchObject({ schedule_type: "hourly", schedule_expression: null });
    expect(preParseJob("Whenever a workflow fails, tell me in my morning brief", ["n8n"]).interpretation).toMatchObject({ schedule_type: "event_driven", notification_policy: { push: false, briefing_only: true, min_importance: "important", max_per_day: 5 } });
  });
  it("asks instead of guessing when no detector matches, and is not safe", () => {
    const i = preParseJob("Do the thing with the stuff every Tuesday", ["stripe"]).interpretation;
    expect(i.detectors).toEqual([]);
    expect(i.ambiguities[0]).toMatchObject({ field: "detectors", question: "What should this job look for?" });
    expect(i.ambiguities[0]!.options.length).toBeGreaterThan(0);
    expect(i.safe).toBe(false);
    expect(i.schedule_expression).toBe("tue 07:05");
  });
  it("draft system jobs (relationships, follow-through) resolve to their pending system job with no detectors", () => {
    expect(preParseJob("Tell me when a relationship is going cold", ["google"]).interpretation).toMatchObject({ detectors: [], matches_system_job: "relationship-radar" });
    expect(preParseJob("Keep reminding me until it's actually done", []).interpretation).toMatchObject({ detectors: [], matches_system_job: "follow-through-watchdog" });
  });
});

describe("interpretJob (model fallback with hard guards)", () => {
  it("uses the deterministic parse without calling the model when an intent matched", async () => {
    const create = vi.fn();
    const res = await interpretJob(OWNER, SCOPE_CREEP, ["portal", "stripe"], { client: { create } as never });
    expect(create).not.toHaveBeenCalled();
    expect(res.usedModel).toBe(false);
    expect(res.interpretation.detectors).toEqual(["client_scope_creep"]);
  });
  it("calls the model with a strict schema for unknown requests and strips invented detectors/sources; never marks safe on its own", async () => {
    const create = vi.fn(async () => ({
      model: "claude-test",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [
        {
          type: "tool_use",
          name: "job_definition",
          id: "t1",
          input: {
            name: "Vendor Watch",
            slug: "vendor-watch",
            description: "d",
            purpose: "p",
            scope: "financial",
            schedule_type: "weekly",
            schedule_expression: "mon 07:05",
            detectors: ["recurring_expense_change", "made_up_detector"],
            sources: ["plaid", "quickbooks"],
            would_need: [],
            notification_policy: { min_importance: "important", push: true, briefing_only: false, max_per_day: 3 },
            config: {},
            matches_system_job: null,
            limitations: [],
            ambiguities: [],
            safe: true,
            confidence: 0.9,
          },
        },
      ],
    }));
    const res = await interpretJob(OWNER, "Do the thing with vendors every week", ["plaid"], { client: { create } as never });
    expect(create).toHaveBeenCalledTimes(1);
    const call = (create.mock.calls as unknown as unknown[][])[0]![0] as { tools: { strict: boolean; input_schema: { additionalProperties: boolean } }[]; messages: { content: string }[] };
    expect(call.tools[0]!.strict).toBe(true);
    expect(call.tools[0]!.input_schema.additionalProperties).toBe(false);
    expect(call.messages[0]!.content).toMatch(/untrusted/);
    expect(res.usedModel).toBe(true);
    expect(res.interpretation.detectors).toEqual(["recurring_expense_change"]);
    expect(res.interpretation.sources).toEqual(["plaid"]);
    expect(res.interpretation.would_need).toEqual(["quickbooks"]);
    expect(res.interpretation.safe).toBe(false); // deterministic parse had no intent → not safe regardless of the model
  });
  it("falls back to the deterministic parse when the model output does not validate", async () => {
    const create = vi.fn(async () => ({ model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", name: "job_definition", id: "t", input: { name: "x" } }] }));
    const res = await interpretJob(OWNER, "Do the thing every week", [], { client: { create } as never });
    expect(res.notes.join(" ")).toMatch(/did not validate/);
    expect(res.interpretation.ambiguities).toHaveLength(1);
  });
  it("reports when no model is available", async () => {
    const res = await interpretJob(OWNER, "Do the thing every week", [], { client: null });
    expect(res.usedModel).toBe(false);
    expect(res.notes.join(" ")).toMatch(/unavailable/);
  });
});

describe("client_scope_creep custom detector", () => {
  const NOW = new Date("2026-09-12T18:00:00Z");
  const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
  const task = (client: string, i: number) => ({ id: `t-${client}-${i}`, provider: "portal", capability: null, resource_type: "task", external_id: `t-${client}-${i}`, title: `Task ${i}`, summary: null, author: null, source_url: null, source_timestamp: ago(3), tags: [], metadata: { client_id: client, client_name: client.toUpperCase(), assignee_type: "bizgrips", status: "done" } });
  const client = (id: string, email: string) => ({ id: `c-${id}`, provider: "portal", capability: null, resource_type: "client", external_id: id, title: id.toUpperCase(), summary: null, author: email, source_url: null, source_timestamp: ago(30), tags: [], metadata: { client_id: id, email } });
  // Stripe rows carry client_id once the sync's client map has attributed them.
  const invoice = (clientId: string, amount: number, i: number) => ({ id: `inv-${clientId}-${i}`, provider: "stripe", capability: null, resource_type: "invoice", external_id: `inv-${i}`, title: "Invoice", summary: null, author: null, source_url: null, source_timestamp: ago(5), tags: [], metadata: { status: "paid", amount_paid: amount, client_id: clientId, currency: "usd" } });
  it("flags a client whose share of work far exceeds its share of revenue, and is silent otherwise", () => {
    const rows = [client("acme", "a@acme.com"), client("beta", "b@beta.com"), ...Array.from({ length: 16 }, (_, i) => task("acme", i)), ...Array.from({ length: 4 }, (_, i) => task("beta", i)), invoice("acme", 10000, 1), invoice("beta", 90000, 2)];
    const out = clientScopeCreep(rows as never, NOW, 30);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ category: "client_scope_creep", fingerprint: "client_scope_creep:acme" });
    expect(out[0]!.limitations).toMatch(/no time tracking/i);
    expect(out[0]!.evidence.length).toBeGreaterThan(0);
    // Balanced work/revenue → nothing.
    const balanced = [client("acme", "a@acme.com"), client("beta", "b@beta.com"), ...Array.from({ length: 10 }, (_, i) => task("acme", i)), ...Array.from({ length: 10 }, (_, i) => task("beta", i)), invoice("acme", 50000, 1), invoice("beta", 50000, 2)];
    expect(clientScopeCreep(balanced as never, NOW, 30)).toEqual([]);
    // Too few tasks → not enough evidence.
    expect(clientScopeCreep([client("acme", "a@acme.com"), task("acme", 1), invoice("beta", 90000, 2)] as never, NOW, 30)).toEqual([]);
  });
});

describe("templates catalog", () => {
  it("lists templates by category, including a scope-creep scaffold and a link to the system scanner", () => {
    const all = listTemplates();
    expect(all.length).toBeGreaterThanOrEqual(5);
    const creep = getTemplate("client-scope-creep")!;
    expect(creep.scaffold).toMatchObject({ detectors: ["client_scope_creep"], sources: ["portal", "stripe"], schedule_type: "weekly", schedule_expression: "fri 07:05" });
    expect(getTemplate("weekly-blind-spots")?.system_slug).toBe("blind-spot-scanner");
    expect(getTemplate("nope")).toBeUndefined();
  });
});
