import type { BlindSpotCandidate, BlindSpotContext, Detector } from "../types";
import { referralSourceDeclining as radar } from "@/lib/jeff/monitors/relationship-radar";

/**
 * §83: a referral partner who used to send business and stopped. The
 * Relationship Radar job owns this finding; the scanner re-uses the same
 * pure detector so the blind spot still surfaces when that job is paused or
 * its finding was never seen. Novelty (§47) collapses the two when both exist.
 */
export const referralSourceDeclining: Detector = {
  id: "referral_source_declining",
  run(ctx: BlindSpotContext): BlindSpotCandidate[] {
    const found = radar(ctx.sourceItems, { now: ctx.now, ownerEmail: ctx.ownerEmail ?? undefined });
    return found.map((f) => {
      const source = f.fingerprint.slice("referral_source_declining:".length);
      const silent = typeof f.metrics.comms_silent_days === "number" ? (f.metrics.comms_silent_days as number) : null;
      return {
        fingerprint: `blindspot:referral_source_declining:${source}`,
        subtype: "referral_source_declining",
        ref: source,
        title: f.title,
        observed_facts: f.observed_facts,
        metrics: { ...f.metrics },
        interpretation: f.interpretation,
        attention: silent != null ? `No direct communication with this partner in ${silent} days, and referral volume is not something any dashboard shows.` : "Referral volume by partner is not something any dashboard shows.",
        evidence: f.evidence,
        range_start: f.range_start,
        range_end: f.range_end,
        confidence: f.confidence,
        limitations: f.limitations,
        impact: "client",
      };
    });
  },
};
