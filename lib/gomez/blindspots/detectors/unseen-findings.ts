import { daysAgo, ts, type BlindSpotCandidate, type BlindSpotContext, type Detector } from "../types";
import { MONITOR_LABELS, resolveMonitorId } from "@/lib/gomez/rules/schema";

/** A category with this many open findings and no views is being ignored. */
export const MIN_OPEN_FINDINGS = 3;
export const LOOKBACK_DAYS = 14;

const ACTIVE = new Set(["open", "new", "reviewing", "accepted", "monitoring"]);

export const unseenFindings: Detector = {
  id: "unseen_findings",
  run(ctx: BlindSpotContext): BlindSpotCandidate[] {
    const since = daysAgo(ctx, LOOKBACK_DAYS);
    const byCategory = new Map<string, typeof ctx.findings>();
    for (const f of ctx.findings) {
      if (!ACTIVE.has(f.status) || f.category === "blind_spot") continue;
      byCategory.set(f.category, [...(byCategory.get(f.category) ?? []), f]);
    }
    const viewedIds = new Set(ctx.attention.filter((a) => a.kind === "finding_viewed" && ts(a.created_at) >= since).map((a) => a.ref_id));
    const out: BlindSpotCandidate[] = [];
    for (const [category, list] of byCategory) {
      if (list.length < MIN_OPEN_FINDINGS) continue;
      const viewed = list.filter((f) => viewedIds.has(f.id)).length;
      if (viewed > 0) continue;
      const oldest = list.map((f) => ts(f.created_at)).filter(Number.isFinite).sort((a, b) => a - b)[0];
      const oldestDays = oldest ? Math.floor((ctx.now.getTime() - oldest) / 86_400_000) : null;
      const label = MONITOR_LABELS[resolveMonitorId(category) ?? "missed_commitment"] ?? category.replace(/_/g, " ");
      out.push({
        fingerprint: `blindspot:unseen_findings:${category}`,
        subtype: "unseen_findings",
        ref: category,
        title: `${list.length} open "${label}" findings you haven't opened`,
        observed_facts: [`${list.length} findings in ${label} are open.`, `None of them has been opened in the last ${LOOKBACK_DAYS} days.`, ...(oldestDays != null ? [`The oldest has been open for ${oldestDays} days.`] : [])],
        metrics: { open_findings: list.length, viewed_last_14d: 0, lookback_days: LOOKBACK_DAYS, formula: "count(open findings in category) where finding_viewed events in 14d = 0" },
        interpretation: `A whole category of findings is accumulating without being looked at. Either it matters and deserves a pass, or it is noise — in which case a rule would silence it for good.`,
        attention: `You have not opened any ${label} finding in ${LOOKBACK_DAYS} days.`,
        evidence: [],
        range_start: new Date(since).toISOString(),
        range_end: ctx.now.toISOString(),
        confidence: Math.min(0.9, 0.55 + list.length * 0.05),
        limitations: "Based on in-app views only; findings read elsewhere (e.g. in a briefing push) are not counted as viewed.",
        impact: "operational",
      });
    }
    return out;
  },
};
