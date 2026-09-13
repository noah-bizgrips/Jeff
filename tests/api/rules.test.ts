import { describe, expect, it, vi, beforeEach } from "vitest";
import { fakeSupabase, jsonReq, OWNER_ID, req, type Claims } from "../helpers";

let claims: Claims = null;
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeSupabase(claims) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

/**
 * Minimal in-memory stand-in for the service-role client covering the query
 * shapes used by lib/jeff/rules/store.ts and apply.ts. Enough to exercise the
 * create → reprocess → undo → delete lifecycle without a database.
 */
interface Row extends Record<string, unknown> {
  id: string;
}
const db: Record<"operating_rules" | "findings" | "source_items" | "rule_events" | "memories" | "finding_feedback", Row[]> & Record<string, Row[]> = { operating_rules: [], findings: [], source_items: [], rule_events: [], memories: [], finding_feedback: [] };
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function table(name: string) {
  const rows = () => (db[name] ??= []);
  let filters: ((r: Row) => boolean)[] = [];
  let pendingInsert: Row[] | null = null;
  let pendingUpdate: Record<string, unknown> | null = null;
  let pendingDelete = false;
  let single = false;
  const apply = () => rows().filter((r) => filters.every((f) => f(r)));
  const q: Record<string, unknown> = {};
  const chain = () => q;
  q.select = () => chain();
  q.order = () => chain();
  q.limit = () => chain();
  q.eq = (k: string, v: unknown) => {
    filters.push((r) => r[k] === v);
    return chain();
  };
  q.in = (k: string, vs: unknown[]) => {
    filters.push((r) => vs.includes(r[k]));
    return chain();
  };
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
      const hit = apply();
      for (const r of hit) Object.assign(r, pendingUpdate, { updated_at: new Date().toISOString() });
      data = single ? (hit[0] ?? null) : hit;
    } else if (pendingDelete) {
      const hit = apply();
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

const rulesRoute = await import("@/app/api/rules/route");
const ruleRoute = await import("@/app/api/rules/[id]/route");
const undoRoute = await import("@/app/api/rules/[id]/undo/route");
const memoriesRoute = await import("@/app/api/memories/route");
const feedbackRoute = await import("@/app/api/findings/[id]/feedback/route");
const { runMemoryRuleTool } = await import("@/lib/jeff/rules/tools");

const GITHUB_ROW = { id: "11111111-1111-4111-8111-aaaaaaaaaaaa", owner_id: OWNER_ID, provider: "google", capability: "gmail", resource_type: "email", external_id: "gh", title: "[BizGrips-Site-Builds/site-bathroom-phoenix-smartchoice] change webhook destination to n8n and structure", summary: "noah pushed 1 commit", author: "noah-bizgrips <notifications@github.com>", source_url: null, source_timestamp: "2026-09-08T12:00:00Z", tags: [], metadata: { threadId: "gh", labelIds: ["INBOX"] } };
const HUMAN_ROW = { id: "11111111-1111-4111-8111-bbbbbbbbbbbb", owner_id: OWNER_ID, provider: "google", capability: "gmail", resource_type: "email", external_id: "cl", title: "Re: Atlas proposal", summary: "I'll send the signed proposal Thursday.", author: "Oliver Chen <oliver@atlasclient.com>", source_url: null, source_timestamp: "2026-09-08T12:00:00Z", tags: [], metadata: { threadId: "cl", labelIds: ["INBOX"] } };

function seedFindings() {
  db.source_items = [GITHUB_ROW, HUMAN_ROW];
  db.findings = [
    { id: "22222222-2222-4222-8222-000000000001", owner_id: OWNER_ID, category: "missed_commitment", title: "Open commitment: [BizGrips-Site-Builds/…] change webhook", status: "open", confidence: 0.5, severity: "low", evidence: [{ source_item_id: GITHUB_ROW.id, provider: "google", external_id: "gh", url: null, title: GITHUB_ROW.title }], metrics: {} },
    { id: "22222222-2222-4222-8222-000000000002", owner_id: OWNER_ID, category: "missed_commitment", title: "Open commitment: I'll send the signed proposal Thursday.", status: "open", confidence: 0.8, severity: "low", evidence: [{ source_item_id: HUMAN_ROW.id, provider: "google", external_id: "cl", url: null, title: HUMAN_ROW.title }], metrics: {} },
  ];
}

beforeEach(() => {
  claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal2" };
  for (const k of Object.keys(db)) db[k] = [];
  seedFindings();
});

describe("route authorization", () => {
  it("rejects anonymous, non-owner and aal1 callers on every memory/rule route", async () => {
    for (const c of [null, { sub: "22222222-2222-4222-8222-222222222222", email: "noah@bizgrips.com", aal: "aal2" as const }, { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal1" as const }]) {
      claims = c;
      const expected = c === null ? 401 : 403;
      expect((await rulesRoute.GET(req("/api/rules"), { params: Promise.resolve({}) })).status).toBe(expected);
      expect((await rulesRoute.POST(jsonReq("/api/rules", { name: "x", conditions: {}, action: { type: "exclude" } }), { params: Promise.resolve({}) })).status).toBe(expected);
      expect((await memoriesRoute.POST(jsonReq("/api/memories", { content: "remember me" }), { params: Promise.resolve({}) })).status).toBe(expected);
      expect((await feedbackRoute.POST(jsonReq("/api/findings/22222222-2222-4222-8222-000000000001/feedback", { verdict: "useful" }), { params: Promise.resolve({ id: "22222222-2222-4222-8222-000000000001" }) })).status).toBe(expected);
    }
  });
});

describe("§50 acceptance: chat feedback → rule → reprocess", () => {
  it("interpret_rule + apply_rule creates a Tier-1 rule and suppresses only the GitHub finding", async () => {
    const text = "In monitors I keep getting open commitments for emails related to git repo changes like this. I don't want these flagged as open commitments. They're polluting the monitors section.";
    const interp = (await runMemoryRuleTool("interpret_rule", { text }, { ownerId: OWNER_ID })) as { interpretation: { kind: string; rule: unknown }; tier: { tier: number } };
    expect(interp.interpretation.kind).toBe("rule");
    expect(interp.tier.tier).toBe(1);
    const applied = (await runMemoryRuleTool("apply_rule", { rule: interp.interpretation.rule, source_quote: text }, { ownerId: OWNER_ID })) as { applied: boolean; reprocessed_findings: number; created: { name: string; target_monitor: string } };
    expect(applied.applied).toBe(true);
    expect(applied.reprocessed_findings).toBe(1);
    expect(applied.created.target_monitor).toBe("Open commitments");
    const gh = db.findings.find((f) => f.id.endsWith("0001"))!;
    const human = db.findings.find((f) => f.id.endsWith("0002"))!;
    expect(gh.status).toBe("suppressed_by_rule");
    expect(gh.suppressed_by_rule_id).toBeTruthy();
    expect(gh.previous_status).toBe("open");
    expect(human.status).toBe("open");
    expect(db.rule_events.filter((e) => e.effect === "suppressed")).toHaveLength(1);
    const explain = (await runMemoryRuleTool("explain_finding_decision", { finding_id: gh.id }, { ownerId: OWNER_ID })) as { suppressedBy: { name: string } | null };
    expect(explain.suppressedBy?.name).toMatch(/GitHub/i);
  });
  it("Tier 2 rules are stored pending confirmation and not applied; Tier 3 is refused", async () => {
    const t2 = (await runMemoryRuleTool("apply_rule", { rule: { name: "Mute failed payments", target_monitor: "failed_payment", conditions: {}, action: { type: "exclude" } } }, { ownerId: OWNER_ID })) as { applied: boolean; needs_confirmation: boolean; created: { id: string } };
    expect(t2.applied).toBe(false);
    expect(t2.needs_confirmation).toBe(true);
    expect(db.operating_rules.find((r) => r.id === t2.created.id)?.enabled).toBe(false);
    const t3 = (await runMemoryRuleTool("apply_rule", { rule: { name: "Skip MFA for me", conditions: { sender_matches: ["x@y.com"] }, action: { type: "exclude" } } }, { ownerId: OWNER_ID })) as { refused: boolean };
    expect(t3.refused).toBe(true);
    expect(db.operating_rules.some((r) => r.name === "Skip MFA for me")).toBe(false);
  });
});

describe("rule lifecycle via API", () => {
  it("create → undo → disable → delete restores findings and audits", async () => {
    const created = await rulesRoute.POST(jsonReq("/api/rules", { name: "Ignore GitHub in Open commitments", target_monitor: "open_commitments", conditions: { source_type: "email", sender_domain: ["github.com"] }, action: { type: "exclude" } }), { params: Promise.resolve({}) });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { rule: { id: string; summary: string }; suppressed: number };
    expect(body.suppressed).toBe(1);
    expect(body.rule.summary).toContain("Open commitments");
    const undo = await undoRoute.POST(req(`/api/rules/${body.rule.id}/undo`, { method: "POST" }), { params: Promise.resolve({ id: body.rule.id }) });
    expect(await undo.json()).toEqual({ restored: 1 });
    expect(db.findings.find((f) => f.id.endsWith("0001"))?.status).toBe("open");
    const disabled = await ruleRoute.PATCH(jsonReq(`/api/rules/${body.rule.id}`, { enabled: false }, { method: "PATCH" }), { params: Promise.resolve({ id: body.rule.id }) });
    expect(((await disabled.json()) as { rule: { enabled: boolean } }).rule.enabled).toBe(false);
    const list = (await (await rulesRoute.GET(req("/api/rules"), { params: Promise.resolve({}) })).json()) as { rules: { id: string }[]; conflicts: unknown[] };
    expect(list.rules.map((r) => r.id)).toContain(body.rule.id);
    const del = await ruleRoute.DELETE(req(`/api/rules/${body.rule.id}`, { method: "DELETE" }), { params: Promise.resolve({ id: body.rule.id }) });
    expect(del.status).toBe(200);
    expect(db.operating_rules).toHaveLength(0);
  });
  it("refuses Tier 3 edits and invalid conditions", async () => {
    const r = await rulesRoute.POST(jsonReq("/api/rules", { name: "Disable audit log", conditions: {}, action: { type: "exclude" } }), { params: Promise.resolve({}) });
    expect(r.status).toBe(403);
    const bad = await rulesRoute.POST(jsonReq("/api/rules", { name: "x", conditions: { regex: ".*" }, action: { type: "exclude" } }), { params: Promise.resolve({}) });
    expect(bad.status).toBe(400);
  });
});

describe("finding feedback", () => {
  it("'Don't show this again' creates a narrow domain rule, never a monitor mute", async () => {
    const r = await feedbackRoute.POST(jsonReq("/api/findings/22222222-2222-4222-8222-000000000001/feedback", { verdict: "dont_show" }), { params: Promise.resolve({ id: "22222222-2222-4222-8222-000000000001" }) });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { rule: { name: string; conditions: { sender_domain?: string[] }; target_monitor: string }; suppressed: number };
    expect(body.rule.conditions.sender_domain).toEqual(["github.com"]);
    expect(body.rule.target_monitor).toBe("missed_commitment");
    expect(body.suppressed).toBe(1);
    expect(db.findings.find((f) => f.id.endsWith("0002"))?.status).toBe("open");
    expect(db.finding_feedback).toHaveLength(1);
  });
  it("'Change rule' only proposes; 'Useful' accepts", async () => {
    const p = await feedbackRoute.POST(jsonReq("/api/findings/22222222-2222-4222-8222-000000000002/feedback", { verdict: "change_rule" }), { params: Promise.resolve({ id: "22222222-2222-4222-8222-000000000002" }) });
    const pb = (await p.json()) as { proposed: { conditions: { sender_matches?: string[] } } | null; rule: unknown };
    expect(pb.proposed?.conditions.sender_matches).toEqual(["oliver@atlasclient.com"]);
    expect(pb.rule).toBeNull();
    expect(db.operating_rules).toHaveLength(0);
    await feedbackRoute.POST(jsonReq("/api/findings/22222222-2222-4222-8222-000000000002/feedback", { verdict: "useful" }), { params: Promise.resolve({ id: "22222222-2222-4222-8222-000000000002" }) });
    expect(db.findings.find((f) => f.id.endsWith("0002"))?.status).toBe("accepted");
  });
  it("'Already knew this' acknowledges quietly, proposes a narrow rule, and stamps the finding's job on the feedback row", async () => {
    db.findings.find((f) => f.id.endsWith("0002"))!.job_id = "job-commitment-watchdog";
    const r = await feedbackRoute.POST(jsonReq("/api/findings/22222222-2222-4222-8222-000000000002/feedback", { verdict: "already_knew" }), { params: Promise.resolve({ id: "22222222-2222-4222-8222-000000000002" }) });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { verdict: string; rule: unknown; proposed: { conditions: { sender_matches?: string[] } } | null };
    expect(body.verdict).toBe("already_knew");
    expect(body.rule).toBeNull();
    expect(body.proposed?.conditions.sender_matches).toEqual(["oliver@atlasclient.com"]);
    expect(db.findings.find((f) => f.id.endsWith("0002"))?.status).toBe("acknowledged");
    expect(db.operating_rules).toHaveLength(0);
    expect(db.finding_feedback.at(-1)).toMatchObject({ verdict: "already_knew", job_id: "job-commitment-watchdog" });
  });
});

describe("memories", () => {
  it("remember → list → forget through tools, de-duplicated by normalized content", async () => {
    await runMemoryRuleTool("remember_preference", { content: "I prefer daily briefs under five items.", category: "communication_style", scope: "all" }, { ownerId: OWNER_ID });
    await runMemoryRuleTool("remember_preference", { content: "I prefer daily briefs under five items" }, { ownerId: OWNER_ID });
    expect(db.memories).toHaveLength(1);
    const list = (await runMemoryRuleTool("list_memories", {}, { ownerId: OWNER_ID })) as { memories: { content: string }[] };
    expect(list.memories[0]!.content).toMatch(/five items/);
    const gone = (await runMemoryRuleTool("forget_memory", { matching: "daily briefs" }, { ownerId: OWNER_ID })) as { removed: number };
    expect(gone.removed).toBe(1);
    expect(db.memories).toHaveLength(0);
  });
  it("API rejects secrets in memory content", async () => {
    const r = await memoriesRoute.POST(jsonReq("/api/memories", { content: "my key is sk-ant-" + "a".repeat(40) }), { params: Promise.resolve({}) });
    expect(r.status).toBe(400);
  });
});
