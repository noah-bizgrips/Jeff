import { describe, expect, it } from "vitest";
import type { ExtendedContext, SourceRow } from "@/lib/jeff/monitors/types";
import { contactResurfaced, importantDate, referralSourceDeclining, relationshipQuiet } from "@/lib/jeff/monitors/relationship-radar";
import { goalFocusCategory, timeAllocationMismatch } from "@/lib/jeff/monitors/time-allocation";
import { attentionFragmentation, dayStats } from "@/lib/jeff/monitors/attention-cost";
import { calendarEvents } from "@/lib/jeff/monitors/calendar-shared";
import { annualRenewalUpcoming, duplicateTool, newRecurringCharge, priceIncrease, unusedSoftware } from "@/lib/jeff/monitors/expense-creep";
import { manualRepetition, repeatedError, webhookBroken } from "@/lib/jeff/monitors/automation-audit";
import { clientEngagementDrop, clientMissedMeeting, clientNegativeSignal } from "@/lib/jeff/monitors/client-health";
import { personalProjectStalled, personalRenewalDue } from "@/lib/jeff/monitors/personal-projects";
import { ANALYSTS, DETECTOR_SPECS, getDetector } from "@/lib/jeff/jobs/detectors";
import { SYSTEM_JOBS } from "@/lib/jeff/jobs/registry";
import { MONITOR_IDS, MONITOR_LABELS } from "@/lib/jeff/rules/schema";
import { detectBlindSpots } from "@/lib/jeff/blindspots/detect";
import { applyNovelty } from "@/lib/jeff/blindspots/index";

const NOW = new Date("2026-09-12T12:00:00Z"); // Saturday
const DAY = 86_400_000;
const ago = (days: number, hours = 0) => new Date(NOW.getTime() - days * DAY - hours * 3_600_000).toISOString();
const OWNER = "noah@bizgrips.com";

let seq = 0;
function r(provider: string, resource_type: string, metadata: Record<string, unknown> = {}, extra: Partial<SourceRow> = {}): SourceRow {
  const id = extra.id ?? `${provider}-${resource_type}-${++seq}`;
  return { id, provider, capability: null, resource_type, external_id: extra.external_id ?? id, title: extra.title ?? `${resource_type} ${id}`, summary: null, author: null, source_url: null, source_timestamp: ago(1), tags: [], metadata, ...extra };
}

function ctx(p: Partial<ExtendedContext> = {}): ExtendedContext {
  return { now: NOW, ownerEmail: OWNER, goals: [], memories: [], obligations: [], config: { timezone: "UTC" }, ...p };
}

const goal = (p: Partial<ExtendedContext["goals"] extends (infer G)[] | undefined ? G : never> & { id: string; name: string }) => ({ scope: "business", status: "active", trajectory: "at_risk", keywords: [], primary_metric: null, constraint_key: null, recommendation: null, end_date: null, updated_at: ago(2), ...p });

/* ------------------------------------------------------------------ */
/* Relationship Radar                                                  */
/* ------------------------------------------------------------------ */

function emailFrom(name: string, addr: string, daysAgo: number, id?: string): SourceRow {
  return r("google", "email", { to: [OWNER] }, { author: `${name} <${addr}>`, source_timestamp: ago(daysAgo), title: `Note from ${name}`, id });
}

describe("Relationship Radar", () => {
  it("relationship_quiet: a regular contact whose silence exceeds 2× their median gap, with facts/metrics/limitations", () => {
    // Weekly for 10 weeks, then silence for 35 days.
    const rows = Array.from({ length: 10 }, (_, i) => emailFrom("Dana Ruiz", "dana@ruizlaw.com", 35 + i * 7));
    const out = relationshipQuiet(rows, ctx());
    expect(out).toHaveLength(1);
    const f = out[0]!;
    expect(f.category).toBe("relationship_quiet");
    expect(f.fingerprint).toBe("relationship_quiet:dana@ruizlaw.com");
    expect(f.metrics).toMatchObject({ silent_days: 35, typical_gap_days: 7, threshold_days: 21 });
    expect(f.observed_facts.length).toBeGreaterThanOrEqual(3);
    expect(f.limitations).toMatch(/phone calls/i);
    expect(f.range_end).toBe(NOW.toISOString());
    expect(f.evidence.length).toBeGreaterThan(0);
  });
  it("relationship_quiet: silent when the gap is normal for them, when they are noise senders, or when include_personal=false and the contact is casual", () => {
    const monthly = Array.from({ length: 6 }, (_, i) => emailFrom("Dana Ruiz", "dana@ruizlaw.com", 20 + i * 30));
    expect(relationshipQuiet(monthly, ctx())).toHaveLength(0); // 20 days silence < 2×30
    const linkedin = Array.from({ length: 10 }, (_, i) => emailFrom("LinkedIn", "messages-noreply@linkedin.com", 35 + i * 7));
    expect(relationshipQuiet(linkedin, ctx())).toHaveLength(0);
    const gmailFriend = Array.from({ length: 10 }, (_, i) => emailFrom("Sam Friend", "sam.friend@gmail.com", 35 + i * 7));
    expect(relationshipQuiet(gmailFriend, ctx())).toHaveLength(1);
    expect(relationshipQuiet(gmailFriend, ctx({ config: { include_personal: false } }))).toHaveLength(0);
  });
  it("relationship_quiet: a memory naming someone as important makes them count even with few interactions", () => {
    const rows = Array.from({ length: 3 }, (_, i) => emailFrom("Pat Mentor", "pat@mentor.org", 40 + i * 10));
    expect(relationshipQuiet(rows, ctx())).toHaveLength(0); // below minInteractions
    const out = relationshipQuiet(rows, ctx({ memories: [{ category: "priority", scope: "business", content: "Pat Mentor is an important mentor; keep in touch" }] }));
    expect(out).toHaveLength(1);
    expect(out[0]!.observed_facts.join(" ")).toMatch(/named as important/);
  });

  it("§83 referral source declining: 7 referrals in the prior 6 months, none in 54 days, no comms in 71 days → radar finding", () => {
    const rows: SourceRow[] = [];
    // Four referred contacts (source = the partner's name) and three opportunities on them, all 54–200 days ago.
    const contactDays = [200, 160, 120, 54];
    contactDays.forEach((d, i) => rows.push(r("highlevel", "contact", { source: "Mike Torres", dateAdded: ago(d) }, { external_id: `c${i}`, title: `Referred ${i}`, source_timestamp: ago(d) })));
    [180, 100, 70].forEach((d, i) => rows.push(r("highlevel", "opportunity", { contactId: `c${i}`, createdAt: ago(d) }, { source_timestamp: ago(d), title: `Opp ${i}` })));
    // Direct communication with Mike, last 71 days ago.
    for (const d of [71, 100, 130, 160]) rows.push(emailFrom("Mike Torres", "mike@torresroofing.com", d));
    // A channel source that must never count as a partner.
    for (const d of [100, 120, 140]) rows.push(r("highlevel", "contact", { source: "facebook", dateAdded: ago(d) }, { source_timestamp: ago(d) }));
    const out = referralSourceDeclining(rows, ctx());
    expect(out).toHaveLength(1);
    const f = out[0]!;
    expect(f.fingerprint).toBe("referral_source_declining:mike torres");
    expect(f.metrics).toMatchObject({ prior_referrals: 7, recent_referrals: 0, days_since_last_referral: 54, comms_silent_days: 71 });
    expect(f.confidence).toBe(0.75);
    expect(f.severity).toBe("high");
    expect(f.observed_facts.join(" ")).toMatch(/71 days ago/);
    expect(f.proposed_mission?.title).toMatch(/Mike Torres/);

    // The scanner surfaces the same blind spot when nothing else shows it …
    const bs = detectBlindSpots({ now: NOW, ownerEmail: OWNER, sourceItems: rows, findings: [], alerts: [], goals: [], clients: [], connections: [], attention: [], commitments: [] });
    const spot = bs.candidates.find((c) => c.subtype === "referral_source_declining");
    expect(spot?.ref).toBe("mike torres");
    // … and defers to the Radar finding once that finding is active (novelty §47).
    const known = [{ kind: "finding" as const, id: "f1", title: f.title, category: "referral_source_declining", status: "open", ref: null }];
    expect(applyNovelty([spot!], { known, prior: new Map() }, NOW).suppressed).toBe(1);
    expect(applyNovelty([spot!], { known: [], prior: new Map() }, NOW).kept).toHaveLength(1);
  });
  it("referral source: silent when referrals continue or the history is too thin", () => {
    const rows: SourceRow[] = [];
    [200, 120, 60, 10].forEach((d, i) => rows.push(r("highlevel", "contact", { source: "Mike Torres", dateAdded: ago(d) }, { external_id: `c${i}`, source_timestamp: ago(d) })));
    expect(referralSourceDeclining(rows, ctx())).toHaveLength(0);
    const thin = [200, 120].map((d, i) => r("highlevel", "contact", { source: "Mike Torres", dateAdded: ago(d) }, { external_id: `t${i}`, source_timestamp: ago(d) }));
    expect(referralSourceDeclining(thin, ctx())).toHaveLength(0);
  });

  it("contact_resurfaced: an inbound message after 90+ days of silence, not after a short gap", () => {
    const rows = [emailFrom("Lee Old", "lee@oldclient.com", 170), emailFrom("Lee Old", "lee@oldclient.com", 150), emailFrom("Lee Old", "lee@oldclient.com", 2)];
    const out = contactResurfaced(rows, ctx());
    expect(out).toHaveLength(1);
    expect(out[0]!.metrics).toMatchObject({ silence_days: 148 });
    const recent = [emailFrom("Lee Old", "lee@oldclient.com", 40), emailFrom("Lee Old", "lee@oldclient.com", 20), emailFrom("Lee Old", "lee@oldclient.com", 2)];
    expect(contactResurfaced(recent, ctx())).toHaveLength(0);
  });
  it("important_date: only explicit birthday/anniversary events within 14 days", () => {
    const rows = [r("google", "event", {}, { title: "Mom's birthday", source_timestamp: ago(-5) }), r("google", "event", {}, { title: "Anniversary dinner", source_timestamp: ago(-30) }), r("google", "event", {}, { title: "Dentist", source_timestamp: ago(-3) })];
    const out = importantDate(rows, ctx());
    expect(out.map((f) => f.title)).toEqual(["Mom's birthday in 5 days"]);
    expect(out[0]!.confidence).toBe(0.9);
  });
});

/* ------------------------------------------------------------------ */
/* Time Allocation + Attention Cost                                    */
/* ------------------------------------------------------------------ */

function event(title: string, daysAgo: number, hour: number, minutes: number, attendees: string[] = []): SourceRow {
  const start = new Date(NOW.getTime() - daysAgo * DAY);
  start.setUTCHours(hour, 0, 0, 0);
  const end = new Date(start.getTime() + minutes * 60_000);
  return r("google", "event", { start: start.toISOString(), end: end.toISOString(), attendees }, { title, source_timestamp: start.toISOString() });
}

describe("Time Allocation Auditor", () => {
  it("maps goals to a focus category by wording", () => {
    expect(goalFocusCategory(goal({ id: "g", name: "Onboard 10 new clients in 60 days" }))).toBe("sales");
    expect(goalFocusCategory(goal({ id: "g", name: "Cut churn to 5%" }))).toBe("client");
    expect(goalFocusCategory(goal({ id: "g", name: "Run a marathon", scope: "personal" }))).toBe("personal");
  });
  it("flags <15% of scheduled work time on the top goal's category, with the exact share and breakdown", () => {
    const rows: SourceRow[] = [];
    // 2 sales hours vs 18 client/internal hours over the last month.
    rows.push(event("Discovery call with prospect", 3, 10, 60), event("Sales pitch", 10, 14, 60));
    for (let i = 0; i < 9; i++) rows.push(event("Client onboarding check-in", 2 + i * 3, 9, 60), event("Internal standup", 2 + i * 3, 13, 60));
    const out = timeAllocationMismatch(rows, ctx({ goals: [goal({ id: "g1", name: "Sign 10 new clients" })] }));
    expect(out).toHaveLength(1);
    const f = out[0]!;
    expect(f.fingerprint).toBe("time_allocation_mismatch:g1");
    expect(f.goal_id).toBe("g1");
    expect(f.metrics).toMatchObject({ scheduled_hours: 20, focus_category: "sales", focus_share_pct: 10, threshold_pct: 15 });
    expect(f.observed_facts[1]).toMatch(/client delivery 45% \(9h\)/);
    expect(f.severity).toBe("low");
  });
  it("stays silent when the share is healthy, when there is too little scheduled time, or when there are no goals", () => {
    const rows: SourceRow[] = [];
    for (let i = 0; i < 10; i++) rows.push(event("Estimate walkthrough", 1 + i * 2, 10, 60), event("Client status", 1 + i * 2, 14, 60));
    expect(timeAllocationMismatch(rows, ctx({ goals: [goal({ id: "g1", name: "Sign 10 new clients" })] }))).toHaveLength(0);
    expect(timeAllocationMismatch(rows.slice(0, 4), ctx({ goals: [goal({ id: "g1", name: "Sign 10 new clients" })] }))).toHaveLength(0);
    expect(timeAllocationMismatch(rows, ctx())).toHaveLength(0);
  });
  it("calendarEvents drops cancelled and all-day rows and caps event length", () => {
    const rows = [event("ok", 1, 10, 30), { ...event("cancelled", 1, 11, 30), metadata: { ...event("x", 1, 11, 30).metadata, status: "cancelled" } }, event("all day", 1, 0, 24 * 60)];
    const evs = calendarEvents(rows, NOW.getTime() - 7 * DAY, NOW.getTime(), "UTC");
    expect(evs.map((e) => e.row.title)).toEqual(["ok"]);
  });
});

describe("Attention Cost Detector", () => {
  it("dayStats counts short meetings, focus blocks (≥120 free minutes in 8–18) and category switches", () => {
    const rows = [event("Standup", 4, 8, 15, []), event("Client review", 4, 9, 30), event("Sales demo", 4, 10, 20), event("Internal planning", 4, 15, 60)];
    const evs = calendarEvents(rows, NOW.getTime() - 7 * DAY, NOW.getTime(), "UTC");
    const stats = dayStats(evs, evs[0]!.localDate);
    expect(stats).toMatchObject({ meetings: 4, shortMeetings: 2, focusBlocks: 2, contextSwitches: 3 });
    expect(stats.medianGapMin).toBe(45);
  });
  it("flags a fragmented week (heavy days / many short meetings / no focus blocks) and reports the arithmetic", () => {
    const rows: SourceRow[] = [];
    // Three weekdays with six 20-minute meetings spread hourly 8–14 → heavy days, short meetings, no focus blocks.
    for (const d of [3, 4, 5]) for (let h = 8; h < 14; h++) rows.push(event(h % 2 ? "Client sync" : "Internal check", d, h, 20));
    const out = attentionFragmentation(rows, ctx());
    expect(out).toHaveLength(1);
    const f = out[0]!;
    expect(f.metrics).toMatchObject({ meetings: 18, heavy_days: 3, short_meetings: 18, hours: 6 });
    expect(f.title).toMatch(/3 days with 5\+ meetings/);
    expect(f.severity).toBe("medium");
    expect(f.limitations).toMatch(/Calendar-only/);
  });
  it("stays silent for a calm week", () => {
    const rows = [event("Client review", 3, 10, 60), event("Sales demo", 4, 10, 60), event("Planning", 5, 14, 60), event("1:1", 6, 9, 30), event("Client kickoff", 7, 11, 60)];
    expect(attentionFragmentation(rows, ctx())).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Expense Creep                                                       */
/* ------------------------------------------------------------------ */

function charge(merchant: string, daysAgo: number, amount: number, extra: Record<string, unknown> = {}): SourceRow {
  return r("plaid", "transaction", { amount, direction: "outflow", merchant_key: merchant, merchant_name: merchant[0]!.toUpperCase() + merchant.slice(1), currency: "usd", ...extra }, { source_timestamp: ago(daysAgo), title: merchant });
}

describe("Expense Creep Hunter", () => {
  it("new_recurring_charge: two monthly charges from a merchant first seen recently; not an old subscription", () => {
    const out = newRecurringCharge([charge("loom", 40, 1_500), charge("loom", 10, 1_500)], ctx());
    expect(out).toHaveLength(1);
    expect(out[0]!.metrics).toMatchObject({ amount_minor: 1_500, annualised_minor: 18_000, occurrences: 2 });
    expect(newRecurringCharge([charge("loom", 200, 1_500), charge("loom", 170, 1_500), charge("loom", 140, 1_500), charge("loom", 110, 1_500), charge("loom", 80, 1_500), charge("loom", 50, 1_500), charge("loom", 20, 1_500)], ctx())).toHaveLength(0);
  });
  it("duplicate_tool: two paid tools in one category; one tool is fine", () => {
    const out = duplicateTool([charge("calendly", 20, 1_200), charge("acuity scheduling", 25, 1_600)], ctx());
    expect(out).toHaveLength(1);
    expect(out[0]!.metrics).toMatchObject({ category: "scheduling", tools: ["acuity", "calendly"] });
    expect(duplicateTool([charge("calendly", 20, 1_200), charge("calendly", 50, 1_200)], ctx())).toHaveLength(0);
  });
  it("price_increase: latest monthly charge ≥10% above the prior median; small wobble ignored", () => {
    const rows = [charge("zoom", 120, 1_499), charge("zoom", 90, 1_499), charge("zoom", 60, 1_499), charge("zoom", 30, 1_899)];
    const out = priceIncrease(rows, ctx());
    expect(out).toHaveLength(1);
    expect(out[0]!.metrics).toMatchObject({ prior_median_minor: 1_499, latest_minor: 1_899, increase_pct: 26.7, annual_impact_minor: 4_800 });
    expect(priceIncrease([charge("zoom", 120, 1_499), charge("zoom", 90, 1_499), charge("zoom", 60, 1_499), charge("zoom", 30, 1_549)], ctx())).toHaveLength(0);
  });
  it("unused_software: a recurring tool never mentioned in comms, cleared by a single mention", () => {
    const rows = [charge("dropbox", 95, 1_199), charge("dropbox", 65, 1_199), charge("dropbox", 35, 1_199), charge("dropbox", 5, 1_199)];
    const out = unusedSoftware(rows, ctx());
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBe(0.35);
    const mention = r("google", "email", {}, { title: "Shared the Dropbox folder", author: "Kim <kim@client.com>", source_timestamp: ago(10) });
    expect(unusedSoftware([...rows, mention], ctx())).toHaveLength(0);
  });
  it("annual_renewal_upcoming: a single charge ~12 months ago with nothing since; monthly merchants excluded", () => {
    const out = annualRenewalUpcoming([charge("godaddy", 350, 24_000)], ctx());
    expect(out).toHaveLength(1);
    expect(out[0]!.metrics).toMatchObject({ days_until: 15, last_amount_minor: 24_000 });
    expect(out[0]!.severity).toBe("medium");
    expect(annualRenewalUpcoming([charge("zoom", 350, 1_499), charge("zoom", 320, 1_499), charge("zoom", 290, 1_499)], ctx())).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Automation Auditor · Client Health · Personal Projects              */
/* ------------------------------------------------------------------ */

describe("Automation Auditor", () => {
  it("webhook_broken: ≥3 failures on one channel in 7 days; a single failure is not a broken channel", () => {
    const rows = [1, 2, 3].map((d) => r("portal", "notification", { channel: "sms", status: "failed", client_id: "c1", reason: "provider timeout" }, { source_timestamp: ago(d) }));
    const out = webhookBroken(rows, ctx());
    expect(out).toHaveLength(1);
    expect(out[0]!.metrics).toMatchObject({ channel: "sms", failures: 3, failure_rate_pct: 100 });
    expect(webhookBroken(rows.slice(0, 1), ctx())).toHaveLength(0);
  });
  it("repeated_error: the same workflow erroring on ≥2 days; a one-day burst is not repeated", () => {
    const rows = [1, 1, 3].map((d) => r("n8n", "execution", { status: "error", workflowId: "wf1" }, { source_timestamp: ago(d), title: "Lead intake" }));
    const out = repeatedError(rows, ctx());
    expect(out).toHaveLength(1);
    expect(out[0]!.metrics).toMatchObject({ failures: 3, days_affected: 2 });
    expect(repeatedError([1, 1, 1].map((d) => r("n8n", "execution", { status: "error", workflowId: "wf1" }, { source_timestamp: ago(d, 1) })), ctx())).toHaveLength(0);
  });
  it("manual_repetition: the same task title ≥4× in 30 days", () => {
    const rows = [2, 9, 16, 23].map((d) => r("portal", "task", { owner: "Noah", client_id: `c${d}` }, { title: "Send weekly ads report #12", source_timestamp: ago(d) }));
    const out = manualRepetition(rows, ctx());
    expect(out).toHaveLength(1);
    expect(out[0]!.metrics).toMatchObject({ occurrences: 4, distinct_clients: 4 });
    expect(manualRepetition(rows.slice(0, 3), ctx())).toHaveLength(0);
  });
});

describe("Client Health Analyst", () => {
  const client = r("portal", "client", { client_id: "c1", status: "delivery" }, { title: "Acme Roofing", external_id: "c1" });
  it("client_engagement_drop: comms down ≥60% vs the prior 6 weeks", () => {
    const prior = Array.from({ length: 12 }, (_, i) => r("google", "email", { client_id: "c1" }, { source_timestamp: ago(16 + i * 3) }));
    const out = clientEngagementDrop([client, ...prior], ctx());
    expect(out).toHaveLength(1);
    expect(out[0]!.metrics).toMatchObject({ prior_count: 12, recent_count: 0, drop_pct: 100 });
    expect(out[0]!.severity).toBe("medium");
    const steady = Array.from({ length: 5 }, (_, i) => r("google", "email", { client_id: "c1" }, { source_timestamp: ago(1 + i * 3) }));
    expect(clientEngagementDrop([client, ...prior, ...steady], ctx())).toHaveLength(0);
  });
  it("client_missed_meeting: ≥2 cancelled/no-show appointments in 30 days", () => {
    const rows = [client, r("portal", "appointment", { client_id: "c1", status: "no_show" }, { source_timestamp: ago(3) }), r("portal", "appointment", { client_id: "c1", status: "cancelled" }, { source_timestamp: ago(12) })];
    expect(clientMissedMeeting(rows, ctx())).toHaveLength(1);
    expect(clientMissedMeeting(rows.slice(0, 2), ctx())).toHaveLength(0);
  });
  it("client_negative_signal: inbound keyword hits with short quotes and low confidence; owner-authored text ignored", () => {
    const rows = [client, r("google", "email", { client_id: "c1" }, { title: "Not happy with the delays", summary: "We are frustrated and may reconsider.", author: "Pat <pat@acme.com>", source_timestamp: ago(2) })];
    const out = clientNegativeSignal(rows, ctx());
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBe(0.35);
    expect(out[0]!.observed_facts.slice(1).every((q) => q.length <= 124)).toBe(true);
    const mine = [client, r("google", "email", { client_id: "c1" }, { title: "Sorry for the delay", author: `Noah <${OWNER}>`, source_timestamp: ago(2) })];
    expect(clientNegativeSignal(mine, ctx())).toHaveLength(0);
  });
});

describe("Personal Project Tracker", () => {
  it("personal_project_stalled: an active personal goal with no related activity for 21+ days; business goals ignored", () => {
    const g = goal({ id: "p1", name: "Finish the garage workshop", scope: "personal", keywords: ["garage", "workshop"], updated_at: ago(40) });
    const out = personalProjectStalled([], ctx({ goals: [g] }));
    expect(out).toHaveLength(1);
    expect(out[0]!.metrics).toMatchObject({ stalled_days: 40, threshold_days: 21 });
    expect(out[0]!.goal_id).toBe("p1");
    const active = r("google", "event", {}, { title: "Garage shelving install", source_timestamp: ago(3) });
    expect(personalProjectStalled([active], ctx({ goals: [g] }))).toHaveLength(0);
    expect(personalProjectStalled([], ctx({ goals: [goal({ id: "b1", name: "Sign 10 clients", updated_at: ago(40) })] }))).toHaveLength(0);
  });
  it("personal_renewal_due: a personal recurring charge whose next expected date is within 14 days", () => {
    const rows = [charge("netflix", 80, 1_999), charge("netflix", 50, 1_999), charge("netflix", 20, 1_999)];
    const out = personalRenewalDue(rows, ctx());
    expect(out).toHaveLength(1);
    expect(out[0]!.metrics).toMatchObject({ cadence_days: 30, days_until: 10 });
    expect(out[0]!.severity).toBe("info");
    // Not personal → not this detector's business.
    expect(personalRenewalDue([charge("hubspot", 80, 1_999), charge("hubspot", 50, 1_999), charge("hubspot", 20, 1_999)], ctx())).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Registry wiring                                                     */
/* ------------------------------------------------------------------ */

describe("run C registry wiring", () => {
  it("every detector referenced by a system job exists, and every new category has a rule id and label", () => {
    for (const job of SYSTEM_JOBS) {
      expect(job.status, job.slug).toBe("active");
      for (const id of job.detectors) expect(getDetector(id), `${job.slug} → ${id}`).toBeDefined();
    }
    for (const spec of ANALYSTS) for (const cat of spec.categories) {
      expect(MONITOR_IDS as readonly string[], cat).toContain(cat);
      expect(MONITOR_LABELS[cat as (typeof MONITOR_IDS)[number]]).toBeTruthy();
    }
    expect(DETECTOR_SPECS.find((d) => d.id === "goal_coach")?.kind).toBe("special");
  });
  it("job-only detectors declare the extra context they need", () => {
    expect(getDetector("relationship_quiet")?.needs).toEqual(expect.arrayContaining(["owner", "memories"]));
    expect(getDetector("time_allocation_mismatch")?.needs).toContain("goals");
    expect(getDetector("personal_project_stalled")?.needs).toEqual(expect.arrayContaining(["goals", "memories"]));
  });
});
