import { beforeEach, describe, expect, it, vi } from "vitest";
import { OWNER_ID } from "../helpers";
import { FakeDb } from "../fake-db";
import { emailHash } from "@/lib/jeff/clients/client-leads";

let db = new FakeDb();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => db.client() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

const { ensureSystemRules, CLIENT_LEAD_RULE_NAME, GITHUB_NOTIFICATION_RULE_NAME, reprocessFindingsForRule, undoRuleSuppression } = await import("@/lib/jeff/rules/apply");
const { listRules } = await import("@/lib/jeff/rules/store");

const NOW = new Date("2026-09-14T12:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const LEAD_OPP = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const AGENCY_OPP = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";

function seed() {
  const base = { owner_id: OWNER_ID, is_sample: false, summary: null, author: null, source_url: null, tags: [] as string[] };
  db.seed("source_items", [
    { ...base, provider: "portal", capability: "clients", resource_type: "client", external_id: "7", title: "Austin Bath Co", source_timestamp: ago(30), metadata: { client_id: "7", status: "delivery", ghl_contact_id: "ghl-client-7" } },
    { ...base, provider: "portal", capability: "leads", resource_type: "lead", external_id: "lead-1", title: "Homeowner One", source_timestamp: ago(5), metadata: { client_id: "7", outcome: "new", ghl_contact_id: "ghl-lead-1", email_hash: emailHash("homeowner1@gmail.com") } },
    { ...base, provider: "highlevel", capability: "contacts", resource_type: "contact", external_id: "ghl-lead-1", title: "Homeowner One", source_timestamp: ago(5), metadata: { email_hash: emailHash("homeowner1@gmail.com") } },
    { ...base, id: LEAD_OPP, provider: "highlevel", capability: "opportunities", resource_type: "opportunity", external_id: "opp-lead", title: "Bathroom remodel", source_timestamp: ago(20), metadata: { status: "open", contactId: "ghl-lead-1", stage: "New lead" } },
    { ...base, id: AGENCY_OPP, provider: "highlevel", capability: "opportunities", resource_type: "opportunity", external_id: "opp-agency", title: "Roofing Co — website", source_timestamp: ago(20), metadata: { status: "open", contactId: "ghl-agency-1", stage: "New lead" } },
  ]);
  const finding = (id: string, oppId: string, title: string) => ({ id, owner_id: OWNER_ID, category: "lead_followup_gap", fingerprint: `lead_followup_gap:${id}`, title, status: "open", confidence: 0.7, severity: "medium", evidence: [{ source_item_id: oppId, provider: "highlevel", external_id: id, url: null, title }], metrics: {}, observed_facts: [], interpretation: "", limitations: "", is_sample: false });
  db.seed("findings", [finding("f-lead", LEAD_OPP, "No follow-up in 20 days: Bathroom remodel"), finding("f-agency", AGENCY_OPP, "No follow-up in 20 days: Roofing Co — website")]);
}

beforeEach(() => {
  db = new FakeDb();
  seed();
});

describe("ensureSystemRules seeds the client-lead rule once and reprocesses existing findings", () => {
  it("creates both Tier-1 system rules, suppresses only the client-lead finding, and is idempotent", async () => {
    const rules = await ensureSystemRules(OWNER_ID);
    const names = rules.map((r) => r.name);
    expect(names).toContain(GITHUB_NOTIFICATION_RULE_NAME);
    expect(names).toContain(CLIENT_LEAD_RULE_NAME);
    const rule = rules.find((r) => r.name === CLIENT_LEAD_RULE_NAME)!;
    expect(rule).toMatchObject({ tier: 1, enabled: true, pending_confirmation: false, created_by: "system", source: "system", target_monitor: null, action: { type: "exclude" } });
    expect(rule.conditions).toEqual({ client_lead: true, monitors: ["lead_followup_gap", "pipeline_aging", "lead_not_contacted", "missed_commitment"] });
    const status = Object.fromEntries(db.rows("findings").map((f) => [f.id, f.status]));
    expect(status).toEqual({ "f-lead": "suppressed_by_rule", "f-agency": "open" });
    expect(db.rows("findings").find((f) => f.id === "f-lead")).toMatchObject({ suppressed_by_rule_id: rule.id, previous_status: "open" });
    expect(db.rows("rule_events").some((e) => e.finding_id === "f-lead" && e.effect === "suppressed")).toBe(true);
    // Second call: nothing new, nothing reprocessed again.
    const writes = db.writes.length;
    const again = await ensureSystemRules(OWNER_ID, await listRules(OWNER_ID));
    expect(again.filter((r) => r.name === CLIENT_LEAD_RULE_NAME)).toHaveLength(1);
    expect(db.writes.length).toBe(writes);
  });
  it("a disabled rule stays disabled and suppression is reversible", async () => {
    const rules = await ensureSystemRules(OWNER_ID);
    const rule = rules.find((r) => r.name === CLIENT_LEAD_RULE_NAME)!;
    const { restored } = await undoRuleSuppression(OWNER_ID, rule.id);
    expect(restored).toBe(1);
    expect(db.rows("findings").find((f) => f.id === "f-lead")!.status).toBe("open");
    db.rows("operating_rules").find((r) => r.id === rule.id)!.enabled = false;
    const after = await ensureSystemRules(OWNER_ID);
    expect(after.find((r) => r.name === CLIENT_LEAD_RULE_NAME)!.enabled).toBe(false);
    expect((await reprocessFindingsForRule(OWNER_ID, rule.id)).suppressed).toBe(0);
    expect(db.rows("findings").find((f) => f.id === "f-lead")!.status).toBe("open");
  });
});
