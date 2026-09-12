import { daysAgo, ts, type BlindSpotCandidate, type BlindSpotContext, type Detector } from "../types";

/** Something owed to the owner, overdue this long, with no nudge from the owner. */
export const OVERDUE_DAYS = 7;

export const unansweredOwedToMe: Detector = {
  id: "unanswered_owed_to_me",
  run(ctx: BlindSpotContext): BlindSpotCandidate[] {
    const out: BlindSpotCandidate[] = [];
    const cutoff = daysAgo(ctx, OVERDUE_DAYS);
    const me = ctx.ownerEmail?.toLowerCase() ?? null;
    for (const c of ctx.commitments) {
      if (c.direction !== "owed_to_me" || !["open", "overdue"].includes(c.status)) continue;
      const due = ts(c.due_at);
      if (!Number.isFinite(due) || due > cutoff) continue;
      // Did the owner send anything in the same thread after the due date?
      const source = c.source_item_id ? ctx.sourceItems.find((r) => r.id === c.source_item_id) : null;
      const threadId = source ? (typeof source.metadata?.threadId === "string" ? source.metadata.threadId : typeof source.metadata?.thread_ts === "string" ? source.metadata.thread_ts : null) : null;
      const reminded =
        !!me &&
        ctx.sourceItems.some((r) => {
          if (ts(r.source_timestamp) <= due) return false;
          if (!(r.author ?? "").toLowerCase().includes(me)) return false;
          if (threadId) return r.metadata?.threadId === threadId || r.metadata?.thread_ts === threadId;
          return !!c.counterparty && ((r.title ?? "") + " " + (r.summary ?? "")).toLowerCase().includes(c.counterparty.toLowerCase());
        });
      if (reminded) continue;
      const overdueDays = Math.floor((ctx.now.getTime() - due) / 86_400_000);
      out.push({
        fingerprint: `blindspot:unanswered_owed_to_me:${c.id}`,
        subtype: "unanswered_owed_to_me",
        ref: c.id,
        title: `${c.counterparty ?? "Someone"} owes you "${c.action_text}" — ${overdueDays} days overdue, no reminder sent`,
        observed_facts: [`Commitment: ${c.action_text}.`, `Due ${c.due_at?.slice(0, 10)}; overdue by ${overdueDays} days.`, `No message from you in that thread after the due date.`, ...(c.context_text ? [c.context_text] : [])],
        metrics: { overdue_days: overdueDays, threshold_days: OVERDUE_DAYS, reminder_sent: false, formula: `owed_to_me AND overdue > ${OVERDUE_DAYS}d AND no owner message after due` },
        interpretation: "Things other people owe you quietly slip because nothing in your tools nags on your behalf.",
        attention: "You have not written to them since the due date.",
        evidence: source ? [{ source_item_id: source.id, provider: source.provider, external_id: source.external_id, url: source.source_url, title: source.title }] : c.source_url ? [{ source_item_id: "", provider: "", external_id: "", url: c.source_url, title: c.action_text }] : [],
        range_start: c.due_at,
        range_end: ctx.now.toISOString(),
        confidence: 0.6,
        limitations: "Only synced threads count as reminders; a phone call or text would not be seen.",
        impact: "client",
      });
    }
    return out;
  },
};
