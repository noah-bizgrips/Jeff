import type { BlindSpotCandidate, BlindSpotContext, Detector } from "./types";
import { unseenFindings } from "./detectors/unseen-findings";
import { quietClient } from "./detectors/quiet-client";
import { sourceVolumeDrop } from "./detectors/source-volume-drop";
import { staleConnection } from "./detectors/stale-connection";
import { untrackedDrift } from "./detectors/untracked-drift";
import { crossSourceContradiction } from "./detectors/cross-source-contradiction";
import { unansweredOwedToMe } from "./detectors/unanswered-owed-to-me";
import { neglectedGoal } from "./detectors/neglected-goal";
import { unresolvedCostlyObligation } from "./detectors/unresolved-costly-obligation";
import { referralSourceDeclining } from "./detectors/referral-source-declining";
import { rankScore as rankScoreImpl, THEME_OF, type NoveltyVerdict, type RankFactors } from "./novelty";
import { decide } from "@/lib/jeff/rules/precedence";
import type { MatchSubject } from "@/lib/jeff/rules/engine";
import type { OperatingRule } from "@/lib/jeff/rules/schema";
import type { CandidateFinding } from "@/lib/jeff/monitors/types";
import type { RuleEventInput } from "@/lib/jeff/rules/store";

/**
 * Pure blind-spot pipeline: detectors → operating rules → ranking. No I/O.
 */

export const BLIND_SPOT_MONITOR = "blind_spots";
export const DETECTORS: Detector[] = [unseenFindings, quietClient, sourceVolumeDrop, staleConnection, untrackedDrift, crossSourceContradiction, unansweredOwedToMe, neglectedGoal, unresolvedCostlyObligation, referralSourceDeclining];

/** Rule subject for a blind spot: rules can target the subtype (tags) or the exact ref (metadata). */
export function blindSpotSubject(c: BlindSpotCandidate): MatchSubject {
  return {
    kind: "finding",
    monitor: BLIND_SPOT_MONITOR,
    category: "blind_spot",
    subject: c.title,
    tags: [c.subtype, `ref:${c.ref}`],
    metadata: { subtype: c.subtype, ref: c.ref, impact: c.impact, theme: THEME_OF[c.subtype] },
    confidence: c.confidence,
    severity: severityOf(c),
    amount_minor: typeof c.metrics.current_30d === "number" && c.metrics.unit === "minor_units" ? Math.abs((c.metrics.current_30d as number) - Number(c.metrics.previous_30d ?? 0)) : null,
  };
}

/** Importance lever: confident + money/client impact → high (→ "important" alert), else medium (→ "briefing"). */
export function severityOf(c: BlindSpotCandidate): CandidateFinding["severity"] {
  return c.confidence >= 0.8 && (c.impact === "financial" || c.impact === "client") ? "high" : "medium";
}

/** §51 ranking; without `now`/factors it is the plain confidence × impact ordering. */
export function rankScore(c: BlindSpotCandidate, now?: Date, factors?: RankFactors): number {
  return rankScoreImpl(c, now, factors);
}

export interface DetectResult {
  candidates: BlindSpotCandidate[];
  excluded: number;
  events: RuleEventInput[];
  errors: { detector: string; message: string }[];
}

export function detectBlindSpots(ctx: BlindSpotContext, rules: OperatingRule[] = [], detectors: Detector[] = DETECTORS): DetectResult {
  const relevant = rules.filter((r) => r.enabled && !r.pending_confirmation && (!r.target_monitor || r.target_monitor === BLIND_SPOT_MONITOR || ["blind_spot", "blindspot", "blindspots"].includes(r.target_monitor)));
  const out: BlindSpotCandidate[] = [];
  const events: RuleEventInput[] = [];
  const errors: { detector: string; message: string }[] = [];
  let excluded = 0;
  for (const d of detectors) {
    let found: BlindSpotCandidate[] = [];
    try {
      found = d.run(ctx);
    } catch (err) {
      errors.push({ detector: d.id, message: err instanceof Error ? err.message : "unknown" });
      continue;
    }
    for (const c of found) {
      const verdict = decide(relevant, blindSpotSubject(c));
      if (verdict.excluded && verdict.decidedBy) {
        excluded++;
        events.push({ ruleId: verdict.decidedBy.id, monitor: BLIND_SPOT_MONITOR, effect: "excluded", detail: c.title });
        continue;
      }
      if (verdict.minConfidence != null && c.confidence < verdict.minConfidence) {
        excluded++;
        continue;
      }
      out.push(c);
    }
  }
  const byFp = new Map<string, BlindSpotCandidate>();
  for (const c of out) byFp.set(c.fingerprint, c);
  const candidates = [...byFp.values()].sort((a, b) => rankScore(b) - rankScore(a));
  return { candidates, excluded, events, errors };
}

/** Converts a blind spot into the shared finding shape (category blind_spot). */
export function toFinding(c: BlindSpotCandidate, extra: { novelty?: NoveltyVerdict; rank?: number } = {}): CandidateFinding {
  return {
    fingerprint: c.fingerprint,
    category: "blind_spot",
    title: c.title,
    observed_facts: c.observed_facts,
    metrics: { ...c.metrics, subtype: c.subtype, theme: THEME_OF[c.subtype], ref: c.ref, impact: c.impact, attention: c.attention, rank: extra.rank ?? rankScore(c), ...(extra.novelty ? { novelty: extra.novelty } : {}) },
    interpretation: `${c.interpretation}\n\nWhy you might be missing this: ${c.attention}`,
    evidence: c.evidence,
    range_start: c.range_start,
    range_end: c.range_end,
    confidence: c.confidence,
    limitations: c.limitations,
    severity: severityOf(c),
    proposed_mission: null,
  };
}

/**
 * Daily cap: only `maxNew` NEW blind spots per day (by rank); existing ones
 * (already known fingerprints) always pass so they keep updating/resolving.
 */
export function applyDailyCap(candidates: BlindSpotCandidate[], knownFingerprints: Set<string>, createdToday: number, maxNew: number): { pass: BlindSpotCandidate[]; deferred: BlindSpotCandidate[] } {
  const pass: BlindSpotCandidate[] = [];
  const deferred: BlindSpotCandidate[] = [];
  let budget = Math.max(0, maxNew - createdToday);
  for (const c of candidates) {
    if (knownFingerprints.has(c.fingerprint)) {
      pass.push(c);
      continue;
    }
    if (budget > 0) {
      pass.push(c);
      budget--;
    } else deferred.push(c);
  }
  return { pass, deferred };
}
