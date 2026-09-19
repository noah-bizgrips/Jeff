import { daysBetween, evidenceOf, type CandidateFinding, type Monitor, type SourceRow } from "./types";
import { classifyCommitment } from "./commitment-classifier";
import { isKnownCounterparty, knownCounterparties } from "@/lib/jeff/commitments/counterparties";

/**
 * Open commitments (monitor id kept as `missed_commitment` for existing
 * findings; `open_commitments` is an accepted alias in rules).
 *
 * A human-to-human email whose subject/snippet contains an extractable
 * commitment (actor + action + future marker/date) and no later reply from
 * another participant in the same thread. Bot and system notifications
 * (repository events, deployments, receipts, newsletters) are excluded by the
 * classifier before scoring (marketing, vendor and social mail included), a
 * promise from an unknown sender is capped below threshold, and operating
 * rules run before the monitor sees the rows at all.
 */
export const LOOKBACK_DAYS = 14;
export const MIN_AGE_DAYS = 2;
export const DEFAULT_MIN_CONFIDENCE = 0.45;
export const DISPLAY_NAME = "Open commitments";

function authorKey(a: string | null) {
  if (!a) return "";
  const m = a.match(/<([^>]+)>/);
  return (m ? m[1]! : a).trim().toLowerCase();
}

export const missedCommitment: Monitor = {
  id: "missed_commitment",
  run(rows, ctx) {
    const since = ctx.now.getTime() - LOOKBACK_DAYS * 86_400_000;
    const emails = rows.filter(
      (r) =>
        ((r.provider === "google" && r.resource_type === "email") || (r.provider === "slack" && r.resource_type === "message")) &&
        r.source_timestamp &&
        Date.parse(r.source_timestamp) >= since,
    );
    const known = knownCounterparties(rows, ctx.ownerEmail ? [ctx.ownerEmail] : []);
    const byThread = new Map<string, SourceRow[]>();
    for (const e of emails) {
      const t =
        e.provider === "slack"
          ? `slack:${String(e.metadata.channel_id ?? "")}:${String(e.metadata.thread_ts ?? e.metadata.ts ?? e.external_id)}`
          : typeof e.metadata.threadId === "string"
            ? (e.metadata.threadId as string)
            : e.external_id;
      byThread.set(t, [...(byThread.get(t) ?? []), e]);
    }
    const out: CandidateFinding[] = [];
    for (const [thread, msgs] of byThread) {
      const sorted = [...msgs].sort((a, b) => Date.parse(a.source_timestamp!) - Date.parse(b.source_timestamp!));
      let best: { msg: SourceRow; signal: ReturnType<typeof classifyCommitment> } | null = null;
      for (const m of sorted) {
        const at = Date.parse(m.source_timestamp!);
        const repliedByOther = sorted.some((x) => Date.parse(x.source_timestamp!) > at && authorKey(x.author) !== authorKey(m.author));
        // A later reply from another participant closes the loop as far as we can see.
        if (repliedByOther) continue;
        const signal = classifyCommitment(m, { repliedByOther, ownAddresses: ctx.ownerEmail ? [ctx.ownerEmail] : [], knownCounterparty: isKnownCounterparty(m, known) });
        if (signal.sender_class !== "human" || !signal.sentence) continue;
        if (!best || signal.confidence > best.signal.confidence) best = { msg: m, signal };
      }
      if (!best) continue;
      const { msg, signal } = best;
      if (signal.confidence < DEFAULT_MIN_CONFIDENCE || !signal.sentence) continue;
      const cueAt = Date.parse(msg.source_timestamp!);
      const age = daysBetween(ctx.now, new Date(cueAt));
      if (age < MIN_AGE_DAYS) continue;
      const dueLine = signal.due_date ? ` Due ${signal.due_date}${Date.parse(signal.due_date) < ctx.now.getTime() ? " (past due)" : ""}.` : "";
      const overdue = !!signal.due_date && Date.parse(signal.due_date) < ctx.now.getTime();
      out.push({
        fingerprint: `missed_commitment:${thread}`,
        category: "missed_commitment",
        title: `Open commitment: ${signal.sentence.length > 90 ? signal.sentence.slice(0, 87) + "…" : signal.sentence}`,
        observed_facts: [
          `${msg.provider === "slack" ? "Slack message" : "Email"} "${msg.title}" from ${msg.author ?? "unknown"} (${signal.sender_class} sender) on ${new Date(cueAt).toISOString().slice(0, 10)} contains: "${signal.sentence}".`,
          `Actor: ${signal.actor ?? "unclear"} · action: ${signal.action ?? "unclear"} · timing: ${signal.future_marker ?? "unspecified"}.${dueLine}`,
          `No later reply from another participant is present in synced data (${sorted.length} message${sorted.length === 1 ? "" : "s"} in thread).`,
        ],
        metrics: {
          days_since: age,
          thread_messages: sorted.length,
          due_date: signal.due_date,
          overdue,
          classifier_confidence: signal.confidence,
          formula: "human-authored message with actor + action + future marker, no later reply from a different author; confidence from extracted parts and thread context",
        },
        interpretation: overdue
          ? "Interpretation: a stated commitment appears to have passed its date without a visible reply. Worth a quick check of the thread."
          : "Interpretation: something was promised and has not visibly been closed out. Worth a 30-second check of the thread.",
        evidence: sorted.slice(-3).map(evidenceOf),
        range_start: new Date(cueAt).toISOString(),
        range_end: ctx.now.toISOString(),
        confidence: signal.confidence,
        limitations: "Based on subjects/snippets and Slack message text only (no email bodies). Replies sent from other tools, other threads, or in person are invisible. Bot and system notifications are excluded by sender classification.",
        severity: overdue ? "medium" : "low",
        proposed_mission: null,
      });
    }
    return out;
  },
};
