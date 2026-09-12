import { describe, expect, it } from "vitest";
import type { SourceRow } from "@/lib/jeff/monitors/types";
import type { OperatingRule } from "@/lib/jeff/rules/schema";
import type { BlindSpotCandidate, BlindSpotContext } from "@/lib/jeff/blindspots/types";
import { applyDailyCap, blindSpotSubject, detectBlindSpots, rankScore, severityOf, toFinding } from "@/lib/jeff/blindspots/detect";
import { unseenFindings } from "@/lib/jeff/blindspots/detectors/unseen-findings";
import { quietClient } from "@/lib/jeff/blindspots/detectors/quiet-client";
import { sourceVolumeDrop } from "@/lib/jeff/blindspots/detectors/source-volume-drop";
import { staleConnection } from "@/lib/jeff/blindspots/detectors/stale-connection";
import { untrackedDrift } from "@/lib/jeff/blindspots/detectors/untracked-drift";
import { crossSourceContradiction } from "@/lib/jeff/blindspots/detectors/cross-source-contradiction";
import { unansweredOwedToMe } from "@/lib/jeff/blindspots/detectors/unanswered-owed-to-me";
import { neglectedGoal } from "@/lib/jeff/blindspots/detectors/neglected-goal";
import { applyReview, sanitizeReview } from "@/lib/jeff/blindspots/interpret";
import { blindSpotPushPayload, shouldPushBlindSpotBatch } from "@/lib/jeff/blindspots/push";
import { shouldSendSignal } from "@/lib/jeff/attention/types";
import { alertEmoji, BLIND_SPOT_EMOJI } from "@/lib/jeff/push/emoji";
import { shouldPushAlert } from "@/lib/jeff/push/decide";
import { inferNarrowRule } from "@/lib/jeff/rules/feedback";

const NOW = new Date("2026-09-12T18:00:00Z"); // 12:00 Denver
const DAY = 86_400_000;
const ago = (days: number, hours = 0) => new Date(NOW.getTime() - days * DAY - hours * 3_600_000).toISOString();

function row(p: Partial<SourceRow> & { id: string; provider: string; resource_type: string }): SourceRow {
  return { capability: null, external_id: p.id, title: `row ${p.id}`, summary: null, author: null, source_url: null, source_timestamp: ago(1), tags: [], metadata: {}, ...p };
}

function ctx(p: Partial<BlindSpotContext> = {}): BlindSpotContext {
  return { now: NOW, ownerEmail: "noah@bizgrips.com", sourceItems: [], findings: [], alerts: [], goals: [], clients: [], connections: [], attention: [], commitments: [], ...p };
}

function rule(partial: Partial<OperatingRule> & { name: string }): OperatingRule {
  return {
    id: partial.id ?? partial.name.toLowerCase().replace(/\W+/g, "-"),
    owner_id: "o",
    description: undefined,
    rule_type: "monitor_filter",
    scope: "business",
    target_system: "monitors",
    target_monitor: null,
    conditions: {},
    action: { type: "exclude" },
    priority: 100,
    tier: 1,
    enabled: true,
    pending_confirmation: false,
    source: "chat",
    source_quote: null,
    created_by: "owner",
    created_at: "2026-09-11T00:00:00Z",
    updated_at: "2026-09-11T00:00:00Z",
    last_triggered_at: null,
    trigger_count: 0,
    ...partial,
  };
}

/* ------------------------------------------------------------------ */
/* Detectors                                                           */
/* ------------------------------------------------------------------ */

describe("unseen_findings", () => {
  const findings = Array.from({ length: 4 }, (_, i) => ({ id: `f${i}`, category: "lead_followup_gap", title: `gap ${i}`, status: "open", created_at: ago(10) }));
  it("flags a category with ≥3 open findings and no views in 14 days", () => {
    const out = unseenFindings.run(ctx({ findings }));
    expect(out).toHaveLength(1);
    expect(out[0]!.ref).toBe("lead_followup_gap");
    expect(out[0]!.metrics.open_findings).toBe(4);
    expect(out[0]!.attention).toMatch(/not opened/);
  });
  it("does not flag when one finding was viewed recently, or fewer than 3 are open, or they are blind spots themselves", () => {
    expect(unseenFindings.run(ctx({ findings, attention: [{ kind: "finding_viewed", ref_id: "f1", path: null, created_at: ago(2) }] }))).toHaveLength(0);
    expect(unseenFindings.run(ctx({ findings: findings.slice(0, 2) }))).toHaveLength(0);
    expect(unseenFindings.run(ctx({ findings: findings.map((f) => ({ ...f, category: "blind_spot" })) }))).toHaveLength(0);
    // a view older than the lookback does not count
    expect(unseenFindings.run(ctx({ findings, attention: [{ kind: "finding_viewed", ref_id: "f1", path: null, created_at: ago(20) }] }))).toHaveLength(1);
  });
});

describe("quiet_client", () => {
  const client = { portal_client_id: "c1", name: "Smart Choice", slug: "smart-choice", status: "delivery", ghl_contact_id: null, email_domains: ["smartchoice.com"], stripe_customer_ids: ["cus_1"], highlevel_contact_ids: [], meta_page_ids: [] };
  const priorActivity = [30, 33, 36, 40].map((d, i) => row({ id: `lead${i}`, provider: "portal", resource_type: "lead", source_timestamp: ago(d), metadata: { client_id: "c1" } }));
  it("flags a formerly active client with no activity for 21+ days", () => {
    const out = quietClient.run(ctx({ clients: [client], sourceItems: priorActivity }));
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toMatch(/Smart Choice has gone quiet/);
    expect(out[0]!.metrics.prior_activity).toBe(4);
    expect(out[0]!.impact).toBe("client");
  });
  it("stays silent when there is recent activity (also via Stripe customer id), too little prior activity, or the client is churned", () => {
    expect(quietClient.run(ctx({ clients: [client], sourceItems: [...priorActivity, row({ id: "inv", provider: "stripe", resource_type: "invoice", source_timestamp: ago(3), metadata: { customerId: "cus_1" } })] }))).toHaveLength(0);
    expect(quietClient.run(ctx({ clients: [client], sourceItems: priorActivity.slice(0, 2) }))).toHaveLength(0);
    expect(quietClient.run(ctx({ clients: [{ ...client, status: "churned" }], sourceItems: priorActivity }))).toHaveLength(0);
  });
});

describe("source_volume_drop", () => {
  function weeks(provider: string, perWeek: number[]): SourceRow[] {
    const rows: SourceRow[] = [];
    perWeek.forEach((n, w) => {
      for (let i = 0; i < n; i++) rows.push(row({ id: `${provider}-${w}-${i}`, provider, resource_type: "email", source_timestamp: ago(w * 7 + 1 + (i % 5)) }));
    });
    return rows;
  }
  it("flags a provider whose weekly volume fell below 40% of the 4-week median", () => {
    const out = sourceVolumeDrop.run(ctx({ sourceItems: weeks("google", [3, 20, 22, 18, 25]) }));
    expect(out).toHaveLength(1);
    expect(out[0]!.metrics.recent_7d).toBe(3);
    expect(out[0]!.title).toMatch(/dropped/);
    expect(out[0]!.impact).toBe("operational");
  });
  it("words it as a data problem when the connection is broken", () => {
    const out = sourceVolumeDrop.run(ctx({ sourceItems: weeks("google", [3, 20, 22, 18, 25]), connections: [{ id: "c", provider: "google", display_name: "Google", status: "reconnect_required", last_success_at: ago(3), last_error: "invalid_grant", age_hours: 72 }] }));
    expect(out[0]!.title).toMatch(/stopped syncing/);
    expect(out[0]!.impact).toBe("data");
  });
  it("ignores small baselines and normal weeks", () => {
    expect(sourceVolumeDrop.run(ctx({ sourceItems: weeks("google", [1, 4, 5, 3, 4]) }))).toHaveLength(0);
    expect(sourceVolumeDrop.run(ctx({ sourceItems: weeks("google", [18, 20, 22, 18, 25]) }))).toHaveLength(0);
  });
});

describe("stale_connection", () => {
  const stale = { id: "c1", provider: "stripe", display_name: "Stripe", status: "connected", last_success_at: ago(3), last_error: null, age_hours: 72 };
  it("flags a stale or broken connection the owner has not looked at", () => {
    expect(staleConnection.run(ctx({ connections: [stale] }))).toHaveLength(1);
    expect(staleConnection.run(ctx({ connections: [{ ...stale, status: "error", age_hours: 1 }] }))).toHaveLength(1);
  });
  it("stays silent when fresh, or when Connections was opened after the problem started", () => {
    expect(staleConnection.run(ctx({ connections: [{ ...stale, age_hours: 2 }] }))).toHaveLength(0);
    expect(staleConnection.run(ctx({ connections: [stale], attention: [{ kind: "page_viewed", ref_id: null, path: "/connections", created_at: ago(1) }] }))).toHaveLength(0);
    // a visit BEFORE the last success does not count as awareness
    expect(staleConnection.run(ctx({ connections: [stale], attention: [{ kind: "page_viewed", ref_id: null, path: "/connections", created_at: ago(10) }] }))).toHaveLength(1);
  });
});

describe("untracked_drift", () => {
  const charges = (n: number, daysStart: number, amount: number) => Array.from({ length: n }, (_, i) => row({ id: `ch-${daysStart}-${i}`, provider: "stripe", resource_type: "charge", source_timestamp: ago(daysStart + i), metadata: { amount, status: "succeeded" } }));
  it("flags a >30% month-over-month move in a metric no goal tracks", () => {
    const out = untrackedDrift.run(ctx({ sourceItems: [...charges(10, 2, 100_000), ...charges(10, 35, 200_000)] }));
    const stripe = out.find((c) => c.ref === "stripe_net");
    expect(stripe).toBeDefined();
    expect(stripe!.metrics.change_pct).toBe(-50);
    expect(stripe!.impact).toBe("financial");
  });
  it("stays silent when a goal tracks the metric or the move is small", () => {
    const rows = [...charges(10, 2, 100_000), ...charges(10, 35, 200_000)];
    expect(untrackedDrift.run(ctx({ sourceItems: rows, goals: [{ id: "g", name: "Revenue", status: "active", trajectory: "on_track", metric_keys: ["revenue"], end_date: null }] })).find((c) => c.ref === "stripe_net")).toBeUndefined();
    expect(untrackedDrift.run(ctx({ sourceItems: [...charges(10, 2, 100_000), ...charges(10, 35, 110_000)] })).find((c) => c.ref === "stripe_net")).toBeUndefined();
  });
});

describe("cross_source_contradiction", () => {
  const client = { portal_client_id: "c1", name: "Pure Bath", slug: "pure-bath", status: "delivery", ghl_contact_id: "ghl-1", email_domains: ["purebath.com"], stripe_customer_ids: ["cus_9"], highlevel_contact_ids: ["ghl-1"], meta_page_ids: [] };
  it("flags a delivery client with no billing in 45+ days", () => {
    const out = crossSourceContradiction.run(ctx({ clients: [client], sourceItems: [row({ id: "inv-old", provider: "stripe", resource_type: "invoice", source_timestamp: ago(60), metadata: { customerId: "cus_9" } })] }));
    expect(out.some((c) => c.ref === "no_billing:c1")).toBe(true);
    expect(out.find((c) => c.ref === "no_billing:c1")!.metrics.days_since_billing).toBe(60);
  });
  it("does not flag when billed recently", () => {
    const out = crossSourceContradiction.run(ctx({ clients: [client], sourceItems: [row({ id: "inv", provider: "stripe", resource_type: "invoice", source_timestamp: ago(10), metadata: { customerId: "cus_9" } })] }));
    expect(out.some((c) => c.ref === "no_billing:c1")).toBe(false);
  });
  it("flags a won HighLevel opportunity with no portal client, but not one that matches a client contact", () => {
    const won = row({ id: "opp1", provider: "highlevel", resource_type: "opportunity", title: "Acme fence", source_timestamp: ago(5), metadata: { status: "won", contactId: "ghl-other" } });
    expect(crossSourceContradiction.run(ctx({ clients: [client], sourceItems: [won, row({ id: "inv", provider: "stripe", resource_type: "invoice", source_timestamp: ago(1), metadata: { customerId: "cus_9" } })] })).some((c) => c.ref === "won_no_client:opp1")).toBe(true);
    expect(crossSourceContradiction.run(ctx({ clients: [client], sourceItems: [{ ...won, metadata: { status: "won", contactId: "ghl-1" } }] })).some((c) => c.ref === "won_no_client:opp1")).toBe(false);
  });
  it("flags a client meeting with no follow-up thread, and clears when a message follows", () => {
    const meeting = row({ id: "ev1", provider: "google", resource_type: "event", title: "Kickoff", source_timestamp: ago(8), metadata: { attendees: ["jane@purebath.com"] } });
    const billed = row({ id: "inv", provider: "stripe", resource_type: "invoice", source_timestamp: ago(1), metadata: { customerId: "cus_9" } });
    expect(crossSourceContradiction.run(ctx({ clients: [client], sourceItems: [meeting, billed] })).some((c) => c.ref === "meeting_no_followup:ev1")).toBe(true);
    const reply = row({ id: "m1", provider: "google", resource_type: "email", author: "Jane <jane@purebath.com>", source_timestamp: ago(6) });
    expect(crossSourceContradiction.run(ctx({ clients: [client], sourceItems: [meeting, billed, reply] })).some((c) => c.ref === "meeting_no_followup:ev1")).toBe(false);
  });
});

describe("unanswered_owed_to_me", () => {
  const commitment = { id: "cm1", action_text: "send the signed contract", context_text: null, due_at: ago(10), direction: "owed_to_me" as const, counterparty: "Jordan", source_item_id: "src1", source_url: null, status: "overdue" };
  const source = row({ id: "src1", provider: "google", resource_type: "email", author: "Jordan <jordan@client.com>", source_timestamp: ago(15), metadata: { threadId: "t1" } });
  it("flags an overdue promise owed to me with no reminder from me", () => {
    const out = unansweredOwedToMe.run(ctx({ commitments: [commitment], sourceItems: [source] }));
    expect(out).toHaveLength(1);
    expect(out[0]!.metrics.overdue_days).toBe(10);
    expect(out[0]!.evidence[0]!.source_item_id).toBe("src1");
  });
  it("stays silent when I replied in the thread after the due date, when it is mine, or not yet 7 days overdue", () => {
    const mine = row({ id: "src2", provider: "google", resource_type: "email", author: "Noah <noah@bizgrips.com>", source_timestamp: ago(3), metadata: { threadId: "t1" } });
    expect(unansweredOwedToMe.run(ctx({ commitments: [commitment], sourceItems: [source, mine] }))).toHaveLength(0);
    expect(unansweredOwedToMe.run(ctx({ commitments: [{ ...commitment, direction: "owed_by_me" }], sourceItems: [source] }))).toHaveLength(0);
    expect(unansweredOwedToMe.run(ctx({ commitments: [{ ...commitment, due_at: ago(3) }], sourceItems: [source] }))).toHaveLength(0);
  });
});

describe("neglected_goal", () => {
  const goal = { id: "g1", name: "10 clients", status: "active", trajectory: "at_risk", metric_keys: ["clients"], end_date: ago(-20) };
  it("flags an at-risk goal not opened in 14+ days", () => {
    const out = neglectedGoal.run(ctx({ goals: [goal], attention: [{ kind: "goal_viewed", ref_id: "g1", path: null, created_at: ago(20) }] }));
    expect(out).toHaveLength(1);
    expect(out[0]!.metrics.days_since_viewed).toBe(20);
  });
  it("stays silent when recently viewed, on track, or not active", () => {
    expect(neglectedGoal.run(ctx({ goals: [goal], attention: [{ kind: "goal_viewed", ref_id: "g1", path: null, created_at: ago(2) }] }))).toHaveLength(0);
    expect(neglectedGoal.run(ctx({ goals: [{ ...goal, trajectory: "on_track" }] }))).toHaveLength(0);
    expect(neglectedGoal.run(ctx({ goals: [{ ...goal, status: "paused" }] }))).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Pipeline: rules, ranking, cap, finding shape                        */
/* ------------------------------------------------------------------ */

function candidate(p: Partial<BlindSpotCandidate> & { fingerprint: string }): BlindSpotCandidate {
  return { subtype: "quiet_client", ref: "c1", title: "t", observed_facts: [], metrics: {}, interpretation: "i", attention: "a", evidence: [], range_start: null, range_end: null, confidence: 0.7, limitations: "", impact: "client", ...p };
}

describe("detectBlindSpots pipeline", () => {
  const goal = { id: "g1", name: "10 clients", status: "active", trajectory: "at_risk", metric_keys: [], end_date: null };
  it("runs detectors, ranks by confidence × impact, and de-duplicates", () => {
    const stale = { id: "c1", provider: "stripe", display_name: "Stripe", status: "error", last_success_at: ago(3), last_error: "x", age_hours: 72 };
    const res = detectBlindSpots(ctx({ goals: [goal], connections: [stale] }));
    expect(res.candidates.map((c) => c.subtype)).toEqual(["stale_connection", "neglected_goal"]);
    expect(rankScore(res.candidates[0]!)).toBeGreaterThan(rankScore(res.candidates[1]!));
    expect(res.errors).toEqual([]);
  });
  it("applies operating rules before persistence: by ref, by subtype tag, and only for the blind_spots monitor", () => {
    const byRef = rule({ name: "ignore g1", target_monitor: "blind_spots", conditions: { metadata_equals: { subtype: "neglected_goal", ref: "g1" } } });
    const res = detectBlindSpots(ctx({ goals: [goal] }), [byRef]);
    expect(res.candidates).toHaveLength(0);
    expect(res.excluded).toBe(1);
    expect(res.events[0]).toMatchObject({ ruleId: byRef.id, effect: "excluded", monitor: "blind_spots" });
    const bySubtype = rule({ name: "no goal nags", target_monitor: "blind_spots", conditions: { tags_any: ["neglected_goal"] } });
    expect(detectBlindSpots(ctx({ goals: [goal] }), [bySubtype]).candidates).toHaveLength(0);
    const otherMonitor = rule({ name: "unrelated", target_monitor: "failed_payment", conditions: {} });
    expect(detectBlindSpots(ctx({ goals: [goal] }), [otherMonitor]).candidates).toHaveLength(1);
  });
  it("maps to a blind_spot finding with subtype/ref/attention in metrics and severity from confidence × impact", () => {
    const f = toFinding(candidate({ fingerprint: "fp", confidence: 0.9, impact: "financial" }));
    expect(f.category).toBe("blind_spot");
    expect(f.metrics).toMatchObject({ subtype: "quiet_client", ref: "c1", attention: "a" });
    expect(f.severity).toBe("high");
    expect(severityOf(candidate({ fingerprint: "x", confidence: 0.6, impact: "financial" }))).toBe("medium");
    expect(severityOf(candidate({ fingerprint: "y", confidence: 0.95, impact: "operational" }))).toBe("medium");
    expect(f.interpretation).toMatch(/Why you might be missing this/);
    expect(blindSpotSubject(candidate({ fingerprint: "z" })).tags).toEqual(["quiet_client", "ref:c1"]);
  });
  it("caps NEW blind spots per day but always lets known ones through", () => {
    const cands = [candidate({ fingerprint: "a", confidence: 0.9 }), candidate({ fingerprint: "b", confidence: 0.8 }), candidate({ fingerprint: "known", confidence: 0.3 }), candidate({ fingerprint: "c", confidence: 0.7 })];
    const { pass, deferred } = applyDailyCap(cands, new Set(["known"]), 0, 2);
    expect(pass.map((c) => c.fingerprint)).toEqual(["a", "b", "known"]);
    expect(deferred.map((c) => c.fingerprint)).toEqual(["c"]);
    expect(applyDailyCap(cands, new Set(), 2, 2).pass).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* AI review validation                                                */
/* ------------------------------------------------------------------ */

describe("AI review", () => {
  const cands = [candidate({ fingerprint: "keep-me" }), candidate({ fingerprint: "drop-me" })];
  const bundle = [{ id: "src1", label: "stripe/invoice · INV-1" }, { id: "src2", label: "google/email · Re: kickoff" }];
  it("rejects additions that cite unknown refs and unknown fingerprints", () => {
    const clean = sanitizeReview(
      { keep: [{ fingerprint: "keep-me", reason: "r" }, { fingerprint: "ghost", reason: "r" }], drop: [{ fingerprint: "drop-me", reason: "r" }], additional: [{ title: "grounded", why: "w", evidence_refs: ["src1"], confidence: 0.6 }, { title: "hallucinated", why: "w", evidence_refs: ["src1", "nope"], confidence: 0.9 }] },
      bundle,
      cands,
    );
    expect(clean.keep.map((k) => k.fingerprint)).toEqual(["keep-me"]);
    expect(clean.additional.map((a) => a.title)).toEqual(["grounded"]);
    const applied = applyReview(cands, clean, bundle, NOW);
    expect(applied.map((c) => c.fingerprint)).not.toContain("drop-me");
    const added = applied.find((c) => c.subtype === "ai_observation")!;
    expect(added.observed_facts).toEqual(["stripe/invoice · INV-1"]);
    expect(added.confidence).toBeLessThanOrEqual(0.75);
  });
  it("leaves candidates untouched without a review", () => {
    expect(applyReview(cands, null, bundle, NOW)).toEqual(cands);
  });
});

/* ------------------------------------------------------------------ */
/* Push, attention throttle, emoji                                     */
/* ------------------------------------------------------------------ */

describe("blind-spot push batch", () => {
  const settings = { push_blind_spots: true, timezone: "America/Denver", quiet_hours_start: "21:00", quiet_hours_end: "07:00" };
  const NIGHT = new Date("2026-09-13T05:00:00Z"); // 23:00 Denver
  it("pushes one batch per local day, outside quiet hours, when enabled", () => {
    expect(shouldPushBlindSpotBatch({ pendingTitles: ["a"], lastBatchAt: null, settings, now: NOW })).toBe(true);
    expect(shouldPushBlindSpotBatch({ pendingTitles: ["a"], lastBatchAt: ago(0, 3), settings, now: NOW })).toBe(false); // already pushed today
    expect(shouldPushBlindSpotBatch({ pendingTitles: ["a"], lastBatchAt: ago(1, 3), settings, now: NOW })).toBe(true); // yesterday
    expect(shouldPushBlindSpotBatch({ pendingTitles: ["a"], lastBatchAt: null, settings, now: NIGHT })).toBe(false);
    expect(shouldPushBlindSpotBatch({ pendingTitles: ["a"], lastBatchAt: null, settings: { ...settings, push_blind_spots: false }, now: NOW })).toBe(false);
    expect(shouldPushBlindSpotBatch({ pendingTitles: [], lastBatchAt: null, settings, now: NOW })).toBe(false);
  });
  it("formats the payload with the eye emoji and a +N more suffix", () => {
    const p = blindSpotPushPayload(["Smart Choice has gone quiet", "b", "c"]);
    expect(p.title.startsWith("👁️")).toBe(true);
    expect(p.body).toBe("Smart Choice has gone quiet (+2 more)");
    expect(p.url).toBe("/insights?view=blind");
  });
  it("blind-spot alerts never go through the per-alert push path", () => {
    const base = { id: "a", status: "open", kind: "finding", category: "blind_spot", importance: "important" as const, deferred_until: null, pushed_at: null, pushed_importance: null };
    expect(shouldPushAlert(base, { push_alerts: true, push_goal_alerts: true, push_opportunity_alerts: true, ...settings }, NOW)).toBe(false);
  });
});

describe("attention throttle + emoji + narrow rule", () => {
  it("sends once per key per window", () => {
    const seen = new Map<string, number>();
    expect(shouldSendSignal("page_viewed:/goals", seen, 1_000)).toBe(true);
    expect(shouldSendSignal("page_viewed:/goals", seen, 2_000)).toBe(false);
    expect(shouldSendSignal("page_viewed:/alerts", seen, 2_000)).toBe(true);
    expect(shouldSendSignal("page_viewed:/goals", seen, 1_000 + 5 * 60_000 + 1)).toBe(true);
  });
  it("maps blind spots to the eye emoji", () => {
    expect(BLIND_SPOT_EMOJI).toBe("👁️");
    expect(alertEmoji({ kind: "finding", category: "blind_spot", importance: "briefing" })).toBe("👁️");
  });
  it("'Don't show this again' on a blind spot anchors on subtype + ref, never the whole detector", () => {
    const r = inferNarrowRule({ id: "f", category: "blind_spot", title: "Smart Choice has gone quiet", evidence: [], metrics: { subtype: "quiet_client", ref: "c1" } }, null);
    expect(r).not.toBeNull();
    expect(r!.target_monitor).toBe("blind_spots");
    expect(r!.conditions).toEqual({ metadata_equals: { subtype: "quiet_client", ref: "c1" } });
    expect(inferNarrowRule({ id: "f", category: "blind_spot", title: "x", evidence: [], metrics: {} }, null)).toBeNull();
  });
});
