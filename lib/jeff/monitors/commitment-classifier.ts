import { bareAddress, classifyAuthor, type AuthorType } from "@/lib/jeff/rules/engine";
import type { SourceRow } from "./types";

/**
 * Commitment classifier for the Open Commitments monitor.
 *
 * 1. Source classification: human vs bot vs system, from sender address and
 *    domain, Gmail category labels, display-name markers, and subject
 *    patterns that identify repository / deployment / receipt notifications.
 *    Bot and system sources are hard-excluded before any scoring — no repo
 *    names are hard-coded; the patterns are structural (`[owner/repo]`,
 *    `PR #n`, `deployment`, `workflow run`, ...).
 * 2. Commitment extraction: a sentence needs an actor, an action verb and a
 *    future marker (or explicit date). "I'll send the proposal Thursday."
 * 3. Confidence 0..1 from the extracted parts and thread context.
 *
 * Classifier v2 additions: promotional copy ("15% off ends tonight"), vendor /
 * transactional mailboxes (servicing@, billing@, no-reply@) and social
 * notifications are hard-excluded as `system` sources, and a promise made TO
 * the owner only counts when the sender is a known counterparty (CRM contact,
 * portal user/lead, calendar attendee, Slack member, or someone the owner has
 * written to) — otherwise confidence is capped below the monitor threshold.
 */

export const CLASSIFIER_VERSION = 2;
/** Confidence ceiling for a promise from someone Jeff has no relationship record for. */
export const UNKNOWN_COUNTERPARTY_CAP = 0.4;

export interface CommitmentSignal {
  sender_class: AuthorType;
  sentence: string | null;
  actor: string | null;
  action: string | null;
  future_marker: string | null;
  due_date: string | null; // ISO date (YYYY-MM-DD) when parseable
  confidence: number;
  reasons: string[];
}

const PRONOUN_ACTOR = /\b(i'll|i will|i'm going to|i am going to|i|we'll|we will|we're going to|we|you'll|you|he|she|they)\b/i;
const NAME_ACTOR = /\b([A-Z][a-z]+(?: [A-Z][a-z]+)?)\b(?= (?:will|is going to|'ll|can|should))/;
const ACTION = /\b(send|share|deliver|get (?:you|it|this|that|back)|follow(?:-| )?up|update|finish|complete|review|circle back|revisit|call|email|provide|prepare|draft|submit|ship|book|schedule|confirm|pay|sign|invoice|forward|upload|post|publish|fix|resolve|handle|take care of|look into|check|reply|respond|let you know|have (?:it|this|that|the [a-z]+) (?:ready|done|over|sent))\b/i;
const FUTURE =
  /\b(by (?:end of )?(?:mon|tues|wednes|thurs|fri|satur|sun)day|by (?:tomorrow|tonight|end of (?:the )?(?:day|week|month)|eod|eow|eom|noon|next week|monday|friday)|by \d{1,2}(?:\/|-)\d{1,2}(?:(?:\/|-)\d{2,4})?|by (?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]* \d{1,2}|(?:on |this |next )(?:mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|tonight|later today|this week|next week|this afternoon|this evening|in the morning|first thing|asap|shortly|soon|in (?:a|an|\d+) (?:hour|day|week)s?|will|'ll|going to|gonna)\b/i;
const NEGATION = /\b(won't|will not|can't|cannot|couldn't|didn't|never|no longer)\b/i;
const QUESTION = /\?\s*$/;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function iso(d: Date) {
  return d.toISOString().slice(0, 10);
}

/** Resolves relative due-date phrases to an ISO date using the message date as anchor. */
export function parseDueDate(text: string, anchor: Date): string | null {
  const t = text.toLowerCase();
  const day = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate()));
  const add = (n: number) => iso(new Date(day.getTime() + n * 86_400_000));
  if (/\b(tomorrow)\b/.test(t)) return add(1);
  if (/\b(tonight|later today|today|eod|end of (the )?day|this afternoon|this evening)\b/.test(t)) return add(0);
  if (/\b(eow|end of (the )?week|this week)\b/.test(t)) {
    const dow = day.getUTCDay();
    return add(dow === 0 ? 5 : dow >= 5 ? 5 - dow + 7 : 5 - dow);
  }
  if (/\bnext week\b/.test(t)) {
    const dow = day.getUTCDay();
    return add(((8 - dow) % 7 || 7));
  }
  if (/\b(eom|end of (the )?month)\b/.test(t)) return iso(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0)));
  const wd = t.match(/\b(?:by |on |this |next )?(mon|tues|wednes|thurs|fri|satur|sun)day\b/);
  if (wd) {
    const target = WEEKDAYS.findIndex((w) => w.startsWith(wd[1]!));
    const dow = day.getUTCDay();
    let delta = (target - dow + 7) % 7;
    if (delta === 0) delta = 7;
    if (/\bnext /.test(wd[0]) && delta < 7) delta += 7;
    return add(delta);
  }
  const num = t.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/);
  if (num) {
    const m = Number(num[1]);
    const d = Number(num[2]);
    let y = num[3] ? Number(num[3]) : day.getUTCFullYear();
    if (y < 100) y += 2000;
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const candidate = new Date(Date.UTC(y, m - 1, d));
      if (!num[3] && candidate.getTime() < day.getTime() - 30 * 86_400_000) candidate.setUTCFullYear(y + 1);
      return iso(candidate);
    }
  }
  const mon = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?\b/);
  if (mon) {
    const m = MONTHS.indexOf(mon[1]!);
    const d = Number(mon[2]);
    const candidate = new Date(Date.UTC(day.getUTCFullYear(), m, d));
    if (candidate.getTime() < day.getTime() - 30 * 86_400_000) candidate.setUTCFullYear(day.getUTCFullYear() + 1);
    return iso(candidate);
  }
  return null;
}

function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && s.length <= 400);
}

/** Extracts the best commitment sentence from a snippet/subject. */
export function extractCommitment(text: string, anchor: Date): Omit<CommitmentSignal, "sender_class" | "confidence"> & { score: number } {
  let best: { sentence: string; actor: string | null; action: string | null; future: string | null; score: number } | null = null;
  for (const s of sentences(text)) {
    if (QUESTION.test(s) || NEGATION.test(s)) continue;
    const action = s.match(ACTION)?.[0] ?? null;
    const future = s.match(FUTURE)?.[0] ?? null;
    if (!action || !future) continue;
    const actor = s.match(PRONOUN_ACTOR)?.[0] ?? s.match(NAME_ACTOR)?.[1] ?? null;
    let score = 0.45;
    if (actor) score += 0.15;
    if (/\b(i|i'll|i will|we|we'll|we will)\b/i.test(s)) score += 0.1; // first person promise
    if (/\bby\b|\btomorrow\b|\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|\d{1,2}\/\d{1,2}/i.test(future)) score += 0.15; // explicit time bound
    if (!best || score > best.score) best = { sentence: s, actor, action, future, score };
  }
  if (!best) return { sentence: null, actor: null, action: null, future_marker: null, due_date: null, reasons: ["no sentence with actor + action + future marker"], score: 0 };
  return {
    sentence: best.sentence,
    actor: best.actor,
    action: best.action,
    future_marker: best.future,
    due_date: parseDueDate(best.sentence, anchor),
    reasons: [],
    score: best.score,
  };
}

export interface ClassifyOptions {
  /** The owner's own addresses; a thread where the owner promised something is still a commitment (theirs). */
  ownAddresses?: string[];
  /** True when a later message from a different participant exists in the thread. */
  repliedByOther?: boolean;
  /**
   * Whether the sender is a known counterparty (see commitments/counterparties.ts).
   * `false` caps the confidence of a promise owed to the owner; `undefined` = not evaluated.
   */
  knownCounterparty?: boolean;
}

export function classifyCommitment(row: SourceRow, opts: ClassifyOptions = {}): CommitmentSignal {
  const sender_class = classifyAuthor(row);
  const reasons: string[] = [];
  if (sender_class !== "human") {
    return { sender_class, sentence: null, actor: null, action: null, future_marker: null, due_date: null, confidence: 0, reasons: [`${sender_class} source excluded before scoring`] };
  }
  const anchor = row.source_timestamp ? new Date(row.source_timestamp) : new Date();
  const text = `${row.title ?? ""}. ${row.summary ?? ""}`;
  const ex = extractCommitment(text, anchor);
  if (!ex.sentence) return { sender_class, ...ex, confidence: 0, reasons: ex.reasons };
  let confidence = ex.score;
  if (ex.due_date) confidence += 0.05;
  if (opts.repliedByOther) {
    confidence -= 0.25;
    reasons.push("a later reply from another participant exists");
  }
  const sender = bareAddress(row.author);
  const fromOwner = !!sender && !!opts.ownAddresses?.includes(sender);
  if (fromOwner) reasons.push("promise made by the owner");
  if (!fromOwner && opts.knownCounterparty === false && confidence > UNKNOWN_COUNTERPARTY_CAP) {
    confidence = UNKNOWN_COUNTERPARTY_CAP;
    reasons.push("sender is not a known counterparty (no CRM, portal, calendar, Slack or reply history)");
  }
  confidence = Math.max(0, Math.min(0.95, Math.round(confidence * 100) / 100));
  return { sender_class, sentence: ex.sentence, actor: ex.actor, action: ex.action, future_marker: ex.future_marker, due_date: ex.due_date, confidence, reasons };
}
