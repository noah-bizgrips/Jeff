import { describe, expect, it } from "vitest";
import { baseImportance, finalizeImportance, atLeast } from "@/lib/jeff/alerts/importance";
import { candidatesFromCommitments, candidatesFromFindings, candidatesFromGoals, reconcileAlerts, GROUP_THRESHOLD, type ExistingAlert, type FindingInput } from "@/lib/jeff/alerts/engine";
import { DEFAULT_SETTINGS, inQuietHours, quietHoursEnd, localTime, type OwnerSettings } from "@/lib/jeff/settings";

// Noon in Denver (MDT = UTC-6) on a Wednesday.
const NOON = new Date("2026-09-16T18:00:00.000Z");
// 22:30 Denver = 04:30Z next day.
const LATE = new Date("2026-09-17T04:30:00.000Z");

function finding(over: Partial<FindingInput> = {}): FindingInput {
  return {
    id: "f1",
    category: "failed_payment",
    title: "Invoice #1001 failed ($2,750)",
    interpretation: "A large invoice payment failed.",
    severity: "high",
    confidence: 0.9,
    status: "open",
    metrics: { amount_minor: 275_000 },
    evidence: [{ source_item_id: "s1" }],
    fingerprint: "failed_payment:in_1001",
    ...over,
  };
}

describe("importance", () => {
  it("high severity + money + urgency → urgent; low severity/confidence → informational", () => {
    expect(baseImportance({ severity: "high", confidence: 0.9, amount_minor: 275_000, urgent: true }).importance).toBe("urgent");
    expect(baseImportance({ severity: "low", confidence: 0.3 }).importance).toBe("informational");
    expect(baseImportance({ severity: "medium", confidence: 0.8 }).importance).toBe("briefing");
    expect(baseImportance({ severity: "high", confidence: 0.8 }).importance).toBe("important");
  });
  it("rules can set importance or suppress the alert", () => {
    const base = baseImportance({ severity: "high", confidence: 0.8 });
    const set = finalizeImportance(base, { scope: "business", kind: "finding", rules: { importance: "urgent" }, settings: DEFAULT_SETTINGS, now: NOON });
    expect(set.importance).toBe("urgent");
    const sup = finalizeImportance(base, { scope: "business", kind: "finding", rules: { suppressAlert: true, decidedBy: { id: "r", name: "Mute X" } }, settings: DEFAULT_SETTINGS, now: NOON });
    expect(sup.surfaced).toBe(false);
    expect(sup.trace.rules[0]).toContain("Mute X");
  });
  it("settings: scope toggles downgrade to informational; quiet hours defer important but never urgent", () => {
    const base = baseImportance({ severity: "high", confidence: 0.8 });
    const off: OwnerSettings = { ...DEFAULT_SETTINGS, financial_notifications: false };
    expect(finalizeImportance(base, { scope: "financial", kind: "finding", settings: off, now: NOON }).importance).toBe("informational");
    const quiet = finalizeImportance(base, { scope: "business", kind: "finding", settings: DEFAULT_SETTINGS, now: LATE });
    expect(quiet.deferred_until).not.toBeNull();
    expect(Date.parse(quiet.deferred_until!)).toBeGreaterThan(LATE.getTime());
    const urgent = finalizeImportance(baseImportance({ severity: "high", confidence: 0.9, amount_minor: 600_000, urgent: true }), { scope: "financial", kind: "finding", settings: { ...DEFAULT_SETTINGS, financial_notifications: false }, now: LATE });
    expect(urgent.importance).toBe("urgent");
    expect(urgent.deferred_until).toBeNull();
    expect(urgent.surfaced).toBe(true);
  });
  it("quiet-hours window crossing midnight in America/Denver is evaluated on local time (DST-safe)", () => {
    expect(inQuietHours(LATE, DEFAULT_SETTINGS)).toBe(true);
    expect(inQuietHours(NOON, DEFAULT_SETTINGS)).toBe(false);
    // 06:59 local on a winter (MST, UTC-7) day is still quiet; 07:00 is not.
    expect(inQuietHours(new Date("2026-12-10T13:59:00.000Z"), DEFAULT_SETTINGS)).toBe(true);
    expect(inQuietHours(new Date("2026-12-10T14:00:00.000Z"), DEFAULT_SETTINGS)).toBe(false);
    const end = quietHoursEnd(LATE, DEFAULT_SETTINGS);
    expect(localTime(end, "America/Denver").hour).toBeGreaterThanOrEqual(7);
    expect(atLeast("actionable", "important")).toBe(true);
  });
});

describe("alert candidates + reconciliation (§54 lifecycle)", () => {
  it("a failed $2,750 payment → one alert; repeat → occurrences 2, no duplicate; paid → resolved", () => {
    const c1 = candidatesFromFindings([finding()], DEFAULT_SETTINGS, NOON);
    expect(c1).toHaveLength(1);
    expect(c1[0]!.fingerprint).toBe("finding:failed_payment:in_1001");
    expect(["important", "urgent", "actionable"]).toContain(c1[0]!.importance);
    const first = reconcileAlerts([], c1, NOON);
    expect(first.create).toHaveLength(1);
    expect(first.update).toHaveLength(0);

    const existing: ExistingAlert[] = [{ id: "a1", fingerprint: c1[0]!.fingerprint, status: "open", importance: c1[0]!.importance, occurrences: 1, snoozed_until: null, cooldown_until: null, resolved_at: null, last_seen: NOON.toISOString() }];
    const second = reconcileAlerts(existing, candidatesFromFindings([finding()], DEFAULT_SETTINGS, new Date(NOON.getTime() + 3_600_000)), new Date(NOON.getTime() + 3_600_000));
    expect(second.create).toHaveLength(0);
    expect(second.update).toHaveLength(1);
    expect(second.update[0]!.patch.occurrences).toBe(2);

    // Payment succeeds → finding resolved → candidate disappears → alert resolved.
    const third = reconcileAlerts(existing, candidatesFromFindings([finding({ status: "resolved" })], DEFAULT_SETTINGS, NOON), NOON);
    expect(third.resolve).toEqual(["a1"]);
  });
  it("cooldown: a resolved alert is not re-raised within 24h unless importance increased", () => {
    const c = candidatesFromFindings([finding({ severity: "medium", metrics: {} })], DEFAULT_SETTINGS, NOON);
    const resolved: ExistingAlert[] = [{ id: "a1", fingerprint: c[0]!.fingerprint, status: "resolved", importance: c[0]!.importance, occurrences: 3, snoozed_until: null, cooldown_until: new Date(NOON.getTime() + 20 * 3_600_000).toISOString(), resolved_at: NOON.toISOString(), last_seen: NOON.toISOString() }];
    const r = reconcileAlerts(resolved, c, new Date(NOON.getTime() + 3_600_000));
    expect(r.create).toHaveLength(0);
    expect(r.update).toHaveLength(0);
    expect(r.skippedByCooldown).toBe(1);
    const escalated = candidatesFromFindings([finding()], DEFAULT_SETTINGS, NOON).map((x) => ({ ...x, fingerprint: c[0]!.fingerprint }));
    const r2 = reconcileAlerts(resolved, escalated, new Date(NOON.getTime() + 3_600_000));
    expect(r2.update).toHaveLength(1);
    expect(r2.update[0]!.patch.status).toBe("open");
  });
  it("dismissed alerts stay dismissed (owner decision) unless escalated to urgent", () => {
    const c = candidatesFromFindings([finding({ severity: "medium", metrics: {} })], DEFAULT_SETTINGS, NOON);
    const dismissed: ExistingAlert[] = [{ id: "a1", fingerprint: c[0]!.fingerprint, status: "dismissed", importance: "briefing", occurrences: 1, snoozed_until: null, cooldown_until: null, resolved_at: null, last_seen: NOON.toISOString() }];
    expect(reconcileAlerts(dismissed, c, NOON).update).toHaveLength(0);
  });
  it("groups many findings of one category into a single alert", () => {
    const many = Array.from({ length: GROUP_THRESHOLD + 4 }, (_, i) => finding({ id: `f${i}`, category: "lead_followup_gap", severity: "medium", title: `Lead ${i} has no follow-up`, metrics: { amount_minor: 800_000 }, fingerprint: `lead_followup_gap:${i}` }));
    const c = candidatesFromFindings(many, DEFAULT_SETTINGS, NOON);
    expect(c).toHaveLength(1);
    expect(c[0]!.fingerprint).toBe("finding-group:lead_followup_gap");
    expect(c[0]!.title).toContain(`${GROUP_THRESHOLD + 4}`);
  });
  it("goal trajectory getting worse → alert; improving → none", () => {
    const worse = candidatesFromGoals([{ goal_id: "g1", name: "10 clients", from: "on_track", to: "at_risk", reason: "booked calls", primary: "4 of ≥ 10", days_remaining: 30 }], DEFAULT_SETTINGS, NOON);
    expect(worse).toHaveLength(1);
    expect(worse[0]!.kind).toBe("goal");
    expect(candidatesFromGoals([{ goal_id: "g1", name: "10 clients", from: "at_risk", to: "slightly_at_risk", reason: null, primary: null, days_remaining: 30 }], DEFAULT_SETTINGS, NOON)).toHaveLength(0);
    expect(candidatesFromGoals([{ goal_id: "g1", name: "10 clients", from: "on_track", to: "at_risk", reason: null, primary: null, days_remaining: 30 }], { ...DEFAULT_SETTINGS, goal_alerts: false }, NOON)[0]!.importance).toBe("informational");
  });
  it("overdue commitments owed by me are important; owed to me are briefing-level", () => {
    const past = new Date(NOON.getTime() - 2 * 86_400_000).toISOString();
    const c = candidatesFromCommitments(
      [
        { id: "c1", action_text: "I'll send the proposal Thursday", context_text: "Sam's $8,400 estimate…", due_at: past, confidence: 0.8, direction: "owed_by_me", counterparty: "Sam", source_url: null },
        { id: "c2", action_text: "Jordan will send access tomorrow", context_text: null, due_at: past, confidence: 0.7, direction: "owed_to_me", counterparty: "Jordan", source_url: null },
        { id: "c3", action_text: "future", context_text: null, due_at: new Date(NOON.getTime() + 86_400_000).toISOString(), confidence: 0.7, direction: "owed_to_me", counterparty: null, source_url: null },
      ],
      DEFAULT_SETTINGS,
      NOON,
    );
    expect(c).toHaveLength(2);
    expect(c[0]!.importance).toBe("important");
    expect(c[1]!.importance).toBe("briefing");
    expect(c[1]!.title).toContain("Jordan");
  });
});
