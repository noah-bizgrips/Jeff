import { daysBetween, evidenceOf, type CandidateFinding, type Monitor, type SourceRow } from "./types";

/**
 * Gmail messages whose subject/snippet contain a commitment cue ("by Friday",
 * "deadline", "follow up", "get back to you") with no later message in the
 * same thread from a different author. Best-effort, low confidence.
 */
export const LOOKBACK_DAYS = 14;
export const MIN_AGE_DAYS = 2;
const CUE =
  /\b(by (mon|tues|wednes|thurs|fri|satur|sun)day|by (tomorrow|end of (the )?(day|week)|eod|eow)|deadline|follow(?:\s|-)?up|get back to you|circle back|will send|i'?ll send)\b/i;

function authorKey(a: string | null) {
  if (!a) return "";
  const m = a.match(/<([^>]+)>/);
  return (m ? m[1]! : a).trim().toLowerCase();
}

export const missedCommitment: Monitor = {
  id: "missed_commitment",
  run(rows, ctx) {
    const since = ctx.now.getTime() - LOOKBACK_DAYS * 86_400_000;
    const emails = rows.filter((r) => r.provider === "google" && r.resource_type === "email" && r.source_timestamp && Date.parse(r.source_timestamp) >= since);
    const byThread = new Map<string, SourceRow[]>();
    for (const e of emails) {
      const t = typeof e.metadata.threadId === "string" ? (e.metadata.threadId as string) : e.external_id;
      byThread.set(t, [...(byThread.get(t) ?? []), e]);
    }
    const out: CandidateFinding[] = [];
    for (const [thread, msgs] of byThread) {
      const sorted = [...msgs].sort((a, b) => Date.parse(a.source_timestamp!) - Date.parse(b.source_timestamp!));
      const cueMsg = sorted.find((m) => CUE.test(`${m.title ?? ""} ${m.summary ?? ""}`));
      if (!cueMsg) continue;
      const cueAt = Date.parse(cueMsg.source_timestamp!);
      const laterByOther = sorted.some((m) => Date.parse(m.source_timestamp!) > cueAt && authorKey(m.author) !== authorKey(cueMsg.author));
      if (laterByOther) continue;
      const age = daysBetween(ctx.now, new Date(cueAt));
      if (age < MIN_AGE_DAYS) continue;
      out.push({
        fingerprint: `missed_commitment:${thread}`,
        category: "missed_commitment",
        title: `Possible open commitment: ${cueMsg.title ?? "(no subject)"}`,
        observed_facts: [
          `Email "${cueMsg.title}" from ${cueMsg.author ?? "unknown"} on ${new Date(cueAt).toISOString().slice(0, 10)} mentions a commitment or deadline.`,
          `No later reply from another participant is present in synced data (${sorted.length} message${sorted.length === 1 ? "" : "s"} in thread).`,
        ],
        metrics: { days_since: age, thread_messages: sorted.length, formula: "cue message with no later reply from a different author" },
        interpretation: "Interpretation: something may have been promised and not closed out. Worth a 30-second check of the thread.",
        evidence: sorted.slice(-3).map(evidenceOf),
        range_start: new Date(cueAt).toISOString(),
        range_end: ctx.now.toISOString(),
        confidence: 0.35,
        limitations: "Based on subject and snippet only (no email bodies). Replies sent from other tools or in person are invisible. Expect false positives.",
        severity: "low",
        proposed_mission: null,
      });
    }
    return out;
  },
};
