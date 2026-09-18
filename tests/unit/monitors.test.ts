import { describe, expect, it } from "vitest";
import { leadFollowupGap, GAP_DAYS } from "@/lib/gomez/monitors/lead-followup-gap";
import { pipelineAging } from "@/lib/gomez/monitors/pipeline-aging";
import { missedCommitment } from "@/lib/gomez/monitors/missed-commitment";
import { automationFailure } from "@/lib/gomez/monitors/automation-failure";
import { operationalBottleneck } from "@/lib/gomez/monitors/operational-bottleneck";
import type { SourceRow } from "@/lib/gomez/monitors/types";

const NOW = new Date("2026-09-12T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function row(p: Partial<SourceRow> & { id: string; provider: string; resource_type: string }): SourceRow {
  return { capability: null, external_id: p.id, title: p.id, summary: null, author: null, source_url: null, source_timestamp: null, tags: [], metadata: {}, ...p };
}

const opp = (id: string, extra: Record<string, unknown>, ts = daysAgo(1)) =>
  row({ id, provider: "highlevel", resource_type: "opportunity", title: `Deal ${id}`, source_timestamp: ts, metadata: { status: "open", contactId: `contact-${id}`, stage: "Estimate sent", pipelineStageId: "s2", monetaryValue: 1000, ...extra } });
const msg = (id: string, contactId: string, at: string) => row({ id, provider: "highlevel", resource_type: "message", source_timestamp: at, metadata: { contactId, lastMessageDate: at } });

describe("lead_followup_gap", () => {
  it("flags open deals with no recent conversation, not those with recent activity", () => {
    const rows = [opp("o1", {}, daysAgo(10)), msg("m1", "contact-o1", daysAgo(6)), opp("o2", {}, daysAgo(10)), msg("m2", "contact-o2", daysAgo(1))];
    const out = leadFollowupGap.run(rows, { now: NOW });
    expect(out.map((f) => f.fingerprint)).toEqual(["lead_followup_gap:o1"]);
    expect(out[0]!.metrics.days_since_activity).toBe(6);
    expect(out[0]!.metrics.threshold_days).toBe(GAP_DAYS);
    expect(out[0]!.evidence.map((e) => e.source_item_id)).toEqual(["o1", "m1"]);
    expect(out[0]!.proposed_mission?.goal).toMatch(/Do not send/);
    expect(out[0]!.interpretation).toMatch(/^Interpretation:/);
  });
  it("ignores won/lost deals and falls back to lastActionDate when no messages exist", () => {
    const rows = [opp("won", { status: "won" }, daysAgo(30)), opp("quiet", { lastActionDate: daysAgo(8) })];
    const out = leadFollowupGap.run(rows, { now: NOW });
    expect(out.map((f) => f.fingerprint)).toEqual(["lead_followup_gap:quiet"]);
    expect(out[0]!.confidence).toBe(0.5);
    expect(out[0]!.severity).toBe("medium");
  });
});

describe("pipeline_aging", () => {
  it("groups stale open deals by stage and sums value", () => {
    const rows = [
      opp("a", { lastStageChangeAt: daysAgo(20), monetaryValue: 6000 }),
      opp("b", { lastStageChangeAt: daysAgo(40), monetaryValue: 7000 }),
      opp("fresh", { lastStageChangeAt: daysAgo(3) }),
      opp("lost", { status: "lost", lastStageChangeAt: daysAgo(90) }),
    ];
    const out = pipelineAging.run(rows, { now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]!.fingerprint).toBe("pipeline_aging:s2");
    expect(out[0]!.metrics).toMatchObject({ count: 2, total_value: 13000, oldest_days: 40 });
    expect(out[0]!.severity).toBe("high");
  });
  it("returns nothing when no deal is stale", () => {
    expect(pipelineAging.run([opp("x", { lastStageChangeAt: daysAgo(2) })], { now: NOW })).toEqual([]);
  });
});

describe("missed_commitment", () => {
  const email = (id: string, thread: string, author: string, title: string, at: string) =>
    row({ id, provider: "google", resource_type: "email", title, author, source_timestamp: at, metadata: { threadId: thread } });
  it("flags a commitment cue with no later reply from someone else", () => {
    // Maya is a known counterparty: the owner has written to her before (classifier v2 requirement).
    const ownerMail = row({ id: "o1", provider: "google", resource_type: "email", title: "Intro", author: "Noah <noah@bizgrips.com>", source_timestamp: daysAgo(20), metadata: { threadId: "t0", to: ["maya@x.io"] } });
    const rows = [ownerMail, email("e1", "t1", "Maya <maya@x.io>", "Proposal — will send by Friday", daysAgo(5))];
    const out = missedCommitment.run(rows, { now: NOW, ownerEmail: "noah@bizgrips.com" });
    expect(out).toHaveLength(1);
    expect(out[0]!.fingerprint).toBe("missed_commitment:t1");
    // Classifier-scored: explicit "by Friday" without a named actor lands mid-range.
    expect(out[0]!.confidence).toBeGreaterThanOrEqual(0.45);
    expect(out[0]!.confidence).toBeLessThan(0.8);
    expect(out[0]!.title).toMatch(/^Open commitment:/);
    expect(out[0]!.metrics.due_date).toBe("2026-09-11");
    expect(out[0]!.proposed_mission).toBeNull();
  });
  it("does not flag when another author replied later, or when the cue is too recent", () => {
    const replied = [email("e1", "t1", "Maya <maya@x.io>", "Follow up on estimate", daysAgo(5)), email("e2", "t1", "Sam <sam@y.io>", "Re: Follow up on estimate", daysAgo(4))];
    expect(missedCommitment.run(replied, { now: NOW })).toEqual([]);
    expect(missedCommitment.run([email("e3", "t2", "a@b.c", "deadline tomorrow", daysAgo(1))], { now: NOW })).toEqual([]);
    expect(missedCommitment.run([email("e4", "t3", "a@b.c", "Lunch photos", daysAgo(5))], { now: NOW })).toEqual([]);
  });
});

describe("automation_failure", () => {
  it("skips cleanly with no n8n data and groups failures by workflow", () => {
    expect(automationFailure.run([], { now: NOW })).toEqual([]);
    const rows = [
      row({ id: "x1", provider: "n8n", resource_type: "execution", title: "Lead intake", source_timestamp: daysAgo(1), metadata: { status: "error", workflowId: "wf1" } }),
      row({ id: "x2", provider: "n8n", resource_type: "execution", title: "Lead intake", source_timestamp: daysAgo(2), metadata: { status: "error", workflowId: "wf1" } }),
      row({ id: "x3", provider: "n8n", resource_type: "execution", title: "Lead intake", source_timestamp: daysAgo(2), metadata: { status: "success", workflowId: "wf1" } }),
    ];
    const out = automationFailure.run(rows, { now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]!.fingerprint).toBe("automation_failure:wf1");
    expect(out[0]!.metrics.failures).toBe(2);
  });
});

describe("operational_bottleneck", () => {
  const ev = (id: string, day: string, hour: number, durH = 1) =>
    row({ id, provider: "google", resource_type: "event", title: id, source_timestamp: `${day}T${String(hour).padStart(2, "0")}:00:00.000Z`, metadata: { end: `${day}T${String(hour + durH).padStart(2, "0")}:00:00.000Z` } });
  it("flags days with > 5 events or > 6 booked hours inside the next 7 days only", () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => ev(`a${i}`, "2026-09-14", 8 + i)),
      ev("long1", "2026-09-15", 8, 4),
      ev("long2", "2026-09-15", 13, 3),
      ev("past", "2026-09-01", 9, 8),
      ev("far", "2026-10-01", 9, 8),
    ];
    const out = operationalBottleneck.run(rows, { now: NOW }).sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
    expect(out.map((f) => f.fingerprint)).toEqual(["operational_bottleneck:calendar:2026-09-14", "operational_bottleneck:calendar:2026-09-15"]);
    expect(out[0]!.metrics.events).toBe(6);
    expect(out[1]!.metrics.hours).toBe(7);
  });
  it("light days produce nothing", () => {
    expect(operationalBottleneck.run([ev("one", "2026-09-14", 9)], { now: NOW })).toEqual([]);
  });
});

describe("fingerprints are stable across runs", () => {
  it("same input → same fingerprint, different times", () => {
    const rows = [opp("o1", {}, daysAgo(10)), msg("m1", "contact-o1", daysAgo(6))];
    const a = leadFollowupGap.run(rows, { now: NOW });
    const b = leadFollowupGap.run(rows, { now: new Date(NOW.getTime() + 3_600_000) });
    expect(a[0]!.fingerprint).toBe(b[0]!.fingerprint);
  });
});
