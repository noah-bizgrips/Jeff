import { describe, expect, it } from "vitest";
import { classifyCommitment, extractCommitment, parseDueDate } from "@/lib/jeff/monitors/commitment-classifier";
import { missedCommitment } from "@/lib/jeff/monitors/missed-commitment";
import { runMonitors } from "@/lib/jeff/monitors";
import { interpretFeedback } from "@/lib/jeff/rules/interpret";
import { classifyTier } from "@/lib/jeff/rules/tiers";
import { inferNarrowRule } from "@/lib/jeff/rules/feedback";
import type { OperatingRule } from "@/lib/jeff/rules/schema";
import type { SourceRow } from "@/lib/jeff/monitors/types";
import { emailHash } from "@/lib/jeff/clients/client-leads";

const NOW = new Date("2026-09-12T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function email(p: Partial<SourceRow> & { id: string }): SourceRow {
  return { provider: "google", capability: "gmail", resource_type: "email", external_id: p.id, title: null, summary: null, author: null, source_url: `https://mail.google.com/mail/u/0/#all/${p.id}`, source_timestamp: daysAgo(4), tags: [], metadata: { threadId: p.id, labelIds: ["INBOX"] }, ...p };
}

const GITHUB_NOISE = email({ id: "gh", title: "[BizGrips-Site-Builds/site-bathroom-phoenix-smartchoice] change webhook destination to n8n and structure", author: "noah-bizgrips <notifications@github.com>", summary: "noah-bizgrips pushed 1 commit. I'll update the workflow by Friday. View it on GitHub." });
const PR_NOISE = email({ id: "pr", title: "Re: [acme/api] PR #42: Add retries", author: "Jane via GitHub <notifications@github.com>", summary: "Merged. We'll deploy tomorrow." });
const DEPLOY_NOISE = email({ id: "dep", title: "Deployment failed for jeff", author: "Vercel <notifications@vercel.com>", summary: "Your deployment failed. We will retry by tomorrow." });
const NEWSLETTER = email({ id: "nl", title: "This week in growth", author: "Growth Weekly <hello@growthweekly.com>", summary: "We'll send you more tips next week!", metadata: { threadId: "nl", labelIds: ["CATEGORY_PROMOTIONS"] } });
const CLIENT_PROMISE = email({ id: "cl", title: "Re: Atlas proposal", author: "Oliver Chen <oliver@atlasclient.com>", summary: "Thanks Noah. I'll send the signed proposal Thursday and loop in Maya." });
const OWN_PROMISE = email({ id: "own", title: "Fence estimate", author: "Noah <noah@bizgrips.com>", summary: "Great talking today. We will send the revised estimate by 9/15." });
const QUESTION = email({ id: "q", title: "Quick question", author: "Sam <sam@client.com>", summary: "Will you send the estimate tomorrow?" });
/** A HighLevel contact for an address: makes that sender a known counterparty (classifier v2). */
const contact = (id: string, address: string): SourceRow => ({ id: `hl-${id}`, provider: "highlevel", capability: "contacts", resource_type: "contact", external_id: id, title: id, summary: null, author: null, source_url: null, source_timestamp: daysAgo(30), tags: [], metadata: { email_hash: emailHash(address) } });
const KNOWN = [contact("oliver", "oliver@atlasclient.com"), contact("pat", "pat@vendor.com")];

describe("commitment classifier (spec §15–16)", () => {
  it("excludes GitHub repo notifications, PR mail, deploy notices and newsletters even without a rule", () => {
    for (const r of [GITHUB_NOISE, PR_NOISE, DEPLOY_NOISE, NEWSLETTER]) {
      const s = classifyCommitment(r);
      expect(s.sender_class, r.id).not.toBe("human");
      expect(s.confidence, r.id).toBe(0);
    }
  });
  it("detects a human commitment with actor, action and a due date", () => {
    const s = classifyCommitment(CLIENT_PROMISE);
    expect(s.sender_class).toBe("human");
    expect(s.sentence).toMatch(/I'll send the signed proposal Thursday/);
    expect(s.actor).toBe("I'll");
    expect(s.action).toBe("send");
    expect(s.due_date).toBe("2026-09-10"); // Thursday after Tue 2026-09-08
    expect(s.confidence).toBeGreaterThanOrEqual(0.7);
  });
  it("parses explicit dates and lowers confidence when someone already replied", () => {
    expect(classifyCommitment(OWN_PROMISE).due_date).toBe("2026-09-15");
    const replied = classifyCommitment(CLIENT_PROMISE, { repliedByOther: true });
    expect(replied.confidence).toBeLessThan(classifyCommitment(CLIENT_PROMISE).confidence);
  });
  it("ignores questions and negations", () => {
    expect(classifyCommitment(QUESTION).sentence).toBeNull();
    expect(extractCommitment("I won't send it tomorrow.", NOW).sentence).toBeNull();
  });
  it("parseDueDate handles relative phrases", () => {
    const anchor = new Date("2026-09-08T15:00:00Z"); // Tuesday
    expect(parseDueDate("by tomorrow", anchor)).toBe("2026-09-09");
    expect(parseDueDate("by end of week", anchor)).toBe("2026-09-11");
    expect(parseDueDate("next week", anchor)).toBe("2026-09-14");
    expect(parseDueDate("by Friday", anchor)).toBe("2026-09-11");
    expect(parseDueDate("by Sep 20", anchor)).toBe("2026-09-20");
    expect(parseDueDate("no date here", anchor)).toBeNull();
  });
});

describe("open commitments monitor", () => {
  it("produces findings only for human commitments and records sender class + due date", () => {
    const out = missedCommitment.run([...KNOWN, GITHUB_NOISE, PR_NOISE, DEPLOY_NOISE, CLIENT_PROMISE, OWN_PROMISE], { now: NOW, ownerEmail: "noah@bizgrips.com" });
    expect(out.map((f) => f.fingerprint).sort()).toEqual(["missed_commitment:cl", "missed_commitment:own"]);
    const cl = out.find((f) => f.fingerprint === "missed_commitment:cl")!;
    expect(cl.observed_facts[0]).toMatch(/human sender/);
    expect(cl.metrics.due_date).toBe("2026-09-10");
    expect(cl.metrics.overdue).toBe(true);
    expect(cl.severity).toBe("medium");
    expect(cl.evidence[0]!.url).toContain("mail.google.com");
  });
  it("drops a commitment that another participant replied to, and ones younger than 2 days", () => {
    const reply = email({ id: "cl2", title: "Re: Atlas proposal", author: "Noah <noah@bizgrips.com>", summary: "Perfect, thanks!", source_timestamp: daysAgo(3), metadata: { threadId: "cl" } });
    expect(missedCommitment.run([CLIENT_PROMISE, reply], { now: NOW })).toEqual([]);
    expect(missedCommitment.run([{ ...CLIENT_PROMISE, source_timestamp: daysAgo(1) }], { now: NOW })).toEqual([]);
  });
});

function rule(partial: Partial<OperatingRule> & { name: string }): OperatingRule {
  return { id: partial.name, owner_id: "o", description: undefined, rule_type: "monitor_filter", scope: "business", target_system: "monitors", target_monitor: null, conditions: {}, action: { type: "exclude" }, priority: 100, tier: 1, enabled: true, pending_confirmation: false, source: "chat", source_quote: null, created_by: "owner", created_at: "2026-09-11T00:00:00Z", updated_at: "2026-09-11T00:00:00Z", last_triggered_at: null, trigger_count: 0, ...partial };
}

describe("rules run before monitors (spec §14)", () => {
  it("excludes rows by rule with no monitor involvement and records trace events; include exceptions keep rows", () => {
    // A human-looking sender the classifier would accept, excluded purely by an owner rule.
    const vendor = email({ id: "v", title: "Invoice reminder", author: "Pat <pat@vendor.com>", summary: "I'll send the updated invoice tomorrow." });
    const excl = rule({ name: "Ignore vendor.com in Open commitments", target_monitor: "open_commitments", conditions: { sender_domain: ["vendor.com"] } });
    const without = runMonitors([...KNOWN, vendor, CLIENT_PROMISE], NOW, [missedCommitment], []);
    expect(without.candidates.map((c) => c.fingerprint).sort()).toEqual(["missed_commitment:cl", "missed_commitment:v"]);
    const withRule = runMonitors([...KNOWN, vendor, CLIENT_PROMISE], NOW, [missedCommitment], [excl]);
    expect(withRule.candidates.map((c) => c.fingerprint)).toEqual(["missed_commitment:cl"]);
    expect(withRule.trace.excludedRows).toBe(1);
    expect(withRule.trace.events[0]).toMatchObject({ ruleId: excl.id, sourceItemId: "v", monitor: "missed_commitment", effect: "excluded" });
    const exception = rule({ name: "Keep Pat", target_monitor: "open_commitments", conditions: { sender_domain: ["vendor.com"], sender_matches: ["pat@vendor.com"] }, action: { type: "include" } });
    const withException = runMonitors([...KNOWN, vendor, CLIENT_PROMISE], NOW, [missedCommitment], [excl, exception]);
    expect(withException.candidates).toHaveLength(2);
    expect(withException.trace.events.some((e) => e.effect === "allowed_by_exception")).toBe(true);
  });
  it("applies post-candidate rules: confidence floor and severity override", () => {
    const floor = rule({ name: "High bar", target_monitor: "open_commitments", conditions: {}, action: { type: "require_min_confidence", value: 0.99 } });
    expect(runMonitors([...KNOWN, CLIENT_PROMISE], NOW, [missedCommitment], [floor]).candidates).toEqual([]);
    const sev = rule({ name: "Client promises are high", target_monitor: "open_commitments", conditions: { sender_domain: ["atlasclient.com"] }, action: { type: "set_severity", severity: "high" } });
    const out = runMonitors([...KNOWN, CLIENT_PROMISE], NOW, [missedCommitment], [sev]);
    expect(out.candidates[0]!.severity).toBe("high");
    expect(out.trace.events.some((e) => e.effect === "reclassified")).toBe(true);
  });
});

describe("natural-language interpretation (spec §4, §50, §51, §52)", () => {
  it("§50: the exact complaint becomes a Tier-1 GitHub exclusion on Open commitments", () => {
    const text = "In monitors I keep getting open commitments for emails related to git repo changes like this. I don't want these flagged as open commitments. They're polluting the monitors section.";
    const i = interpretFeedback(text)!;
    expect(i.kind).toBe("rule");
    expect(i.rule!.target_monitor).toBe("missed_commitment");
    expect(i.rule!.action).toEqual({ type: "exclude" });
    expect(i.rule!.conditions.sender_matches).toEqual(expect.arrayContaining(["notifications@github.com", "*@github.com"]));
    expect(i.rule!.conditions.author_type).toEqual(["bot", "system"]);
    expect(classifyTier(i.rule!).tier).toBe(1);
  });
  it("§51: the reversal creates a specific include exception rather than deleting the general rule", () => {
    const i = interpretFeedback("Actually, I do want to be alerted about failed production deploys from GitHub.")!;
    expect(i.kind).toBe("rule");
    expect(i.rule!.action.type).toBe("include");
    expect(i.rule!.conditions.subject_patterns).toEqual(expect.arrayContaining(["*deploy*", "*fail*"]));
    expect(i.rule!.conditions.sender_matches).toContain("*@github.com");
  });
  it("amount thresholds and alert-only wording", () => {
    const i = interpretFeedback("Never alert me about failed Stripe payments under $50.")!;
    expect(i.rule!.target_monitor).toBe("failed_payment");
    expect(i.rule!.conditions.amount_max).toBe(5000);
    expect(i.rule!.action.type).toBe("suppress_alert");
    const big = interpretFeedback("Only alert me about leads older than 48 hours if the opportunity is worth more than $5k")!;
    expect(big.rule!.target_monitor).toBe("lead_followup_gap");
    expect(big.rule!.conditions.amount_min).toBe(500000);
  });
  it("§52: briefing length preference is stored as a memory; 'remember' and 'forget' are recognised", () => {
    const m = interpretFeedback("I prefer daily briefs to be very short. Give me no more than five main items.")!;
    expect(m.kind).toBe("memory");
    expect(m.memory!.category).toBe("communication_style");
    const r = interpretFeedback("Remember that I don't consider pipeline revenue.")!;
    expect(r.kind).toBe("memory");
    expect(r.memory!.content).toMatch(/pipeline revenue/);
    const f = interpretFeedback("Forget that preference about short briefs")!;
    expect(f.kind).toBe("forget");
  });
  it("too-broad suppression asks for clarification instead of muting everything", () => {
    const i = interpretFeedback("Never alert me about anything.")!;
    expect(i.kind).toBe("clarify");
  });
});

describe("'Don't show this again' infers the narrowest rule (spec §11)", () => {
  it("anchors on the sender domain for generic mailboxes and never mutes the whole monitor", () => {
    const r = inferNarrowRule({ id: "f", category: "missed_commitment", title: "Open commitment: …", evidence: [{ source_item_id: "gh" }], metrics: {} }, GITHUB_NOISE)!;
    expect(r.target_monitor).toBe("missed_commitment");
    expect(r.conditions.sender_domain).toEqual(["github.com"]);
    expect(r.conditions.author_type).toEqual(["bot"]);
    expect(Object.keys(r.conditions).length).toBeGreaterThan(0);
    expect(classifyTier(r).tier).toBe(1);
  });
  it("anchors on the exact address for a personal sender", () => {
    const r = inferNarrowRule({ id: "f", category: "missed_commitment", title: "x", evidence: [{ source_item_id: "cl" }], metrics: {} }, CLIENT_PROMISE)!;
    expect(r.conditions.sender_matches).toEqual(["oliver@atlasclient.com"]);
  });
  it("returns null when no safe anchor exists", () => {
    expect(inferNarrowRule({ id: "f", category: "operational_bottleneck", title: "busy day", evidence: [], metrics: {} }, null)).toBeNull();
  });
});
