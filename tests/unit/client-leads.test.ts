import { describe, expect, it } from "vitest";
import { ClientLeadIndex, emailHash, isClientLead } from "@/lib/gomez/clients/client-leads";
import { runMonitors } from "@/lib/gomez/monitors";
import { leadFollowupGap } from "@/lib/gomez/monitors/lead-followup-gap";
import { pipelineAging } from "@/lib/gomez/monitors/pipeline-aging";
import { leadNotContacted } from "@/lib/gomez/monitors/lead-not-contacted";
import { clientAdSpendNoLeads } from "@/lib/gomez/monitors/client-ad-spend-no-leads";
import { conditionsMatch, specificity, subjectFromRow } from "@/lib/gomez/rules/engine";
import { decide } from "@/lib/gomez/rules/precedence";
import { classifyTier } from "@/lib/gomez/rules/tiers";
import { describeRule, RuleInputSchema, type OperatingRule } from "@/lib/gomez/rules/schema";
import { CLIENT_LEAD_RULE_MONITORS, CLIENT_LEAD_RULE_NAME } from "@/lib/gomez/rules/apply";
import { extractCommitments } from "@/lib/gomez/commitments/extract";
import { commitmentRules } from "@/lib/gomez/commitments/store";
import type { SourceRow } from "@/lib/gomez/monitors/types";

const NOW = new Date("2026-09-14T12:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

let seq = 0;
function r(provider: string, resource_type: string, metadata: Record<string, unknown>, extra: Partial<SourceRow> = {}): SourceRow {
  seq++;
  return { id: extra.id ?? `row-${seq}`, provider, capability: null, resource_type, external_id: extra.external_id ?? `ext-${seq}`, title: extra.title ?? `${resource_type} ${seq}`, summary: extra.summary ?? null, author: extra.author ?? null, source_url: null, source_timestamp: extra.source_timestamp ?? null, tags: extra.tags ?? [], metadata };
}

// Portal: one client (Austin Bath Co) whose own HighLevel contact is "ghl-client-7".
const client = r("portal", "client", { client_id: "7", slug: "austin-bath-co", status: "delivery", ghl_contact_id: "ghl-client-7" }, { external_id: "7", title: "Austin Bath Co" });
const leadSource = r("portal", "lead_source", { client_id: "7", source_type: "meta_form", routing_key: "form-austin-bath", meta_form_id: "998877", active: true });
// Client leads (homeowners) that arrived through the portal.
const leadByGhl = r("portal", "lead", { client_id: "7", outcome: "new", ghl_contact_id: "ghl-lead-1", email_hash: emailHash("homeowner1@gmail.com"), phone_last4: "1234" }, { title: "Homeowner One", source_timestamp: ago(3) });
const leadByEmail = r("portal", "lead", { client_id: "7", outcome: "new", email_hash: emailHash("homeowner2@yahoo.com"), phone_last4: "5678" }, { title: "Homeowner Two", source_timestamp: ago(2) });
// HighLevel rows in the (agency) location.
const contactLead1 = r("highlevel", "contact", { email_hash: emailHash("homeowner1@gmail.com") }, { external_id: "ghl-lead-1", title: "Homeowner One" });
const contactLead2 = r("highlevel", "contact", { email_hash: emailHash("homeowner2@yahoo.com") }, { external_id: "ghl-lead-2", title: "Homeowner Two" });
const contactByRouting = r("highlevel", "contact", { source: "form-austin-bath" }, { external_id: "ghl-lead-3", title: "Homeowner Three" });
const contactByTag = r("highlevel", "contact", { tags: ["998877"] }, { external_id: "ghl-lead-4", title: "Homeowner Four", tags: ["998877"] });
const contactByPhone = r("highlevel", "contact", { phone: "•••5678", client_id: "7" }, { external_id: "ghl-lead-5", title: "Homeowner Five" });
const agencyContact = r("highlevel", "contact", { email_hash: emailHash("owner@roofingco.com"), source: "facebook" }, { external_id: "ghl-agency-1", title: "Roofing Co Owner" });
const clientOwnContact = r("highlevel", "contact", { email_hash: emailHash("owner@austinbath.com") }, { external_id: "ghl-client-7", title: "Austin Bath Co" });

const opp = (id: string, contactId: string, title: string) =>
  r("highlevel", "opportunity", { status: "open", contactId, stage: "New lead", pipelineStageId: "s1", monetaryValue: 5000, lastActionDate: ago(20), lastStageChangeAt: ago(20) }, { external_id: id, title, source_timestamp: ago(20) });
const clientLeadOpp = opp("opp-lead", "ghl-lead-1", "Bathroom remodel — Homeowner One");
const routedLeadOpp = opp("opp-routed", "ghl-lead-3", "Bathroom — Homeowner Three");
const agencyOpp = opp("opp-agency", "ghl-agency-1", "Roofing Co — website build");
const clientOwnOpp = opp("opp-client", "ghl-client-7", "Austin Bath Co — upsell");
const leadMsg = r("highlevel", "message", { contactId: "ghl-lead-1", lastMessageDirection: "inbound", lastMessageDate: ago(9) }, { author: "Homeowner One", title: "Homeowner One", summary: "I'll send the photos tomorrow.", source_timestamp: ago(9) });
const leadEmail = r("google", "email", { threadId: "t-lead", labelIds: ["INBOX"] }, { author: "Homeowner One <homeowner1@gmail.com>", title: "Bathroom photos", summary: "I'll send the photos tomorrow.", source_timestamp: ago(3) });
const agencyEmail = r("google", "email", { threadId: "t-agency", labelIds: ["INBOX"] }, { author: "Roofing Co Owner <owner@roofingco.com>", title: "Re: website", summary: "I'll send the signed contract Thursday.", source_timestamp: ago(3) });

const ALL = [client, leadSource, leadByGhl, leadByEmail, contactLead1, contactLead2, contactByRouting, contactByTag, contactByPhone, agencyContact, clientOwnContact, clientLeadOpp, routedLeadOpp, agencyOpp, clientOwnOpp, leadMsg, leadEmail, agencyEmail];

function rule(partial: Partial<OperatingRule> & { name: string }): OperatingRule {
  return { id: partial.name, owner_id: "o", description: undefined, rule_type: "monitor_filter", scope: "business", target_system: "monitors", target_monitor: null, conditions: {}, action: { type: "exclude" }, priority: 100, tier: 1, enabled: true, pending_confirmation: false, source: "system", source_quote: null, created_by: "system", created_at: "2026-09-11T00:00:00Z", updated_at: "2026-09-11T00:00:00Z", last_triggered_at: null, trigger_count: 0, ...partial };
}
const CLIENT_LEAD_RULE = rule({ name: CLIENT_LEAD_RULE_NAME, conditions: { client_lead: true, monitors: [...CLIENT_LEAD_RULE_MONITORS] }, priority: 50 });

describe("ClientLeadIndex — a lead is a client lead only when traceable to a portal client record", () => {
  const idx = ClientLeadIndex.from(ALL);
  it("portal lead rows are always client leads", () => {
    expect(idx.match(leadByGhl)).toEqual({ client_id: "7", via: "portal_lead" });
    expect(isClientLead(leadByEmail)).toBe(true); // even without an index
    expect(isClientLead(client)).toBe(false);
  });
  it("HighLevel contacts match by ghl_contact_id, email_hash, phone + client, or lead-source routing key / form id", () => {
    expect(idx.match(contactLead1)?.via).toBe("ghl_contact_id");
    expect(idx.match(contactLead2)?.via).toBe("email_hash");
    expect(idx.match(contactByPhone)?.via).toBe("phone_last4");
    expect(idx.match(contactByRouting)?.via).toBe("lead_source");
    expect(idx.match(contactByTag)?.via).toBe("lead_source");
  });
  it("opportunities and conversations follow their contact; Gmail follows the sender's hashed address", () => {
    expect(idx.isClientLead(clientLeadOpp)).toBe(true);
    expect(idx.isClientLead(routedLeadOpp)).toBe(true);
    expect(idx.isClientLead(leadMsg)).toBe(true);
    expect(idx.isClientLead(leadEmail)).toBe(true);
  });
  it("agency leads and the client's own contact are NOT client leads (location is never a signal)", () => {
    expect(idx.isClientLead(agencyContact)).toBe(false);
    expect(idx.isClientLead(agencyOpp)).toBe(false);
    expect(idx.isClientLead(agencyEmail)).toBe(false);
    expect(idx.isClientLead(clientOwnContact)).toBe(false);
    expect(idx.isClientLead(clientOwnOpp)).toBe(false);
    // A phone match without a client id on the row is not enough (last-4 digits collide).
    expect(idx.isClientLead(r("highlevel", "contact", { phone: "•••5678" }, { external_id: "ghl-x" }))).toBe(false);
  });
  it("with no portal data nothing in HighLevel is a client lead", () => {
    const empty = ClientLeadIndex.from([contactLead1, clientLeadOpp, agencyOpp]);
    expect(empty.empty).toBe(true);
    expect(empty.isClientLead(clientLeadOpp)).toBe(false);
  });
});

describe("`client_lead` / `monitors` rule conditions", () => {
  it("validate, describe, count as narrowing (Tier 1) and match via the subject context", () => {
    const parsed = RuleInputSchema.safeParse({ name: CLIENT_LEAD_RULE_NAME, conditions: { client_lead: true, monitors: ["lead_followup_gap", "open_commitments"] }, action: { type: "exclude" } });
    expect(parsed.success).toBe(true);
    expect(classifyTier(parsed.data!).tier).toBe(1);
    expect(describeRule(parsed.data!)).toBe("Lead follow-up gaps, Open commitments → ignore leads that belong to a client portal client");
    expect(specificity(CLIENT_LEAD_RULE)).toBeGreaterThan(specificity(rule({ name: "broad" })));
    const idx = ClientLeadIndex.from(ALL);
    const lead = subjectFromRow(clientLeadOpp, "lead_followup_gap", { clientLeads: idx });
    const agency = subjectFromRow(agencyOpp, "lead_followup_gap", { clientLeads: idx });
    expect(lead.client_lead).toBe(true);
    expect(agency.client_lead).toBe(false);
    expect(conditionsMatch(CLIENT_LEAD_RULE.conditions, lead)).toBe(true);
    expect(conditionsMatch(CLIENT_LEAD_RULE.conditions, agency)).toBe(false);
    // Outside the listed monitors the rule never fires, even for a client lead.
    expect(conditionsMatch(CLIENT_LEAD_RULE.conditions, subjectFromRow(leadByGhl, "client_ad_spend_no_leads", { clientLeads: idx }))).toBe(false);
    // Without an index the flag is unknown and the rule does not match.
    expect(conditionsMatch(CLIENT_LEAD_RULE.conditions, subjectFromRow(clientLeadOpp, "lead_followup_gap"))).toBe(false);
  });
});

describe("Noah's rule at runtime: client leads are the client's responsibility", () => {
  const monitors = [leadFollowupGap, pipelineAging, leadNotContacted, clientAdSpendNoLeads];
  it("with the rule enabled, follow-up nagging skips client leads but still flags agency leads", () => {
    const { candidates, trace } = runMonitors(ALL, NOW, monitors, [CLIENT_LEAD_RULE]);
    const fps = candidates.map((c) => c.fingerprint);
    expect(fps).toContain("lead_followup_gap:opp-agency");
    expect(fps).toContain("lead_followup_gap:opp-client");
    expect(fps).not.toContain("lead_followup_gap:opp-lead");
    expect(fps).not.toContain("lead_followup_gap:opp-routed");
    expect(fps.some((f) => f.startsWith("lead_not_contacted:"))).toBe(false);
    const aging = candidates.find((c) => c.category === "pipeline_aging")!;
    expect(aging.metrics.count).toBe(2); // agency + client's own deal; the two homeowner deals are excluded
    expect(trace.excludedRows).toBeGreaterThanOrEqual(4);
    expect(trace.events.every((e) => e.ruleId === CLIENT_LEAD_RULE.id)).toBe(true);
  });
  it("with the rule disabled (Memory & Rules toggle), everything is flagged again", () => {
    const { candidates } = runMonitors(ALL, NOW, monitors, [{ ...CLIENT_LEAD_RULE, enabled: false }]);
    const fps = candidates.map((c) => c.fingerprint);
    expect(fps).toContain("lead_followup_gap:opp-lead");
    expect(fps).toContain("lead_followup_gap:opp-routed");
    expect(fps).toContain("lead_followup_gap:opp-agency");
    expect(fps).toContain("lead_not_contacted:7");
    expect(candidates.find((c) => c.category === "pipeline_aging")!.metrics.count).toBe(4);
  });
  it("leaves client_ad_spend_no_leads alone: portal leads still count for the client's ad accounting", () => {
    const adRows = [client, leadSource, leadByGhl, leadByEmail, r("meta", "ad_insight", { client_id: "7", page_id: "p7", spend: 400, leads: 0, date: ago(1).slice(0, 10) }, { source_timestamp: ago(1) })];
    const withRule = runMonitors(adRows, NOW, [clientAdSpendNoLeads], [CLIENT_LEAD_RULE]);
    const without = runMonitors(adRows, NOW, [clientAdSpendNoLeads], []);
    expect(withRule.candidates.map((c) => c.fingerprint)).toEqual(without.candidates.map((c) => c.fingerprint));
    expect(withRule.trace.excludedRows).toBe(0);
  });
  it("commitment pipeline: a client lead's promise is excluded by the rule; an agency lead's promise is kept", () => {
    const idx = ClientLeadIndex.from(ALL);
    const rules = commitmentRules([CLIENT_LEAD_RULE]);
    expect(rules).toHaveLength(1);
    const excluded = (row: SourceRow) => decide(rules, subjectFromRow(row, "missed_commitment", { clientLeads: idx })).excluded;
    expect(excluded(leadEmail)).toBe(true);
    expect(excluded(leadMsg)).toBe(true);
    expect(excluded(agencyEmail)).toBe(false);
    // And the extractor itself still sees the agency lead's promise (known via HighLevel contact hash).
    const out = extractCommitments([agencyContact, agencyEmail], { ownAddresses: ["noah@bizgrips.com"], now: NOW });
    expect(out.map((c) => c.source_item_id)).toEqual([agencyEmail.id]);
  });
});
