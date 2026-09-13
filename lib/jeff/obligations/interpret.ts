import { z } from "zod";
import { CompletionStrategySchema, type CompletionStrategy, type ObligationInput, type Priority, type TrackingMode } from "./types";

/**
 * Natural-language reminder → structured obligation.
 * Deterministic parsing first (dates, cadence, persistence, people, evidence
 * strategy); a strict-schema model pass is only used when the sentence is too
 * ambiguous (see interpretWithModel in ./interpret-model.ts — server only).
 */

export const ObligationInterpretationSchema = z
  .object({
    title: z.string().min(2).max(200),
    due_at: z.string().nullable(),
    remind_at: z.string().nullable(),
    tracking_mode: z.enum(["once", "persistent", "important", "critical"]),
    priority: z.enum(["low", "normal", "high", "critical"]),
    scope: z.enum(["business", "personal", "financial", "all"]),
    assigned_to: z.enum(["me", "other"]),
    waiting_on: z.string().nullable(),
    people: z.array(z.string()).max(5),
    completion_strategy: CompletionStrategySchema,
    cadence: z.object({ follow_up_hours: z.number().nullable(), business_hours_only: z.boolean(), daily_cap: z.number().int(), briefing_only: z.boolean() }),
    completion_uncertain: z.boolean(),
    confidence: z.number().min(0).max(1),
    ambiguities: z.array(z.string()).max(5),
  })
  .strict();
export type ObligationInterpretation = z.infer<typeof ObligationInterpretationSchema>;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function atLocal(base: Date, timezone: string, dayOffset: number, hh: number, mm: number): string {
  // Build a local wall-clock time on (base + dayOffset days) in the owner's timezone.
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(base.getTime() + dayOffset * 86400000)).map((p) => [p.type, p.value]));
  const y = Number(parts.year);
  const m = Number(parts.month);
  const d = Number(parts.day);
  // Find the UTC instant whose local time equals y-m-d hh:mm by probing the offset.
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const offsetMin = tzOffsetMinutes(new Date(guess), timezone);
  return new Date(guess - offsetMin * 60000).toISOString();
}

function tzOffsetMinutes(date: Date, timezone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute));
  return Math.round((asUtc - date.getTime()) / 60000);
}

function localWeekday(date: Date, timezone: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" }).format(date).toLowerCase();
  return WEEKDAYS.indexOf(name);
}

export interface ParsedDate {
  iso: string | null;
  matched: string | null;
}

/** Parses tomorrow / today / weekday / "by <date>" / "in N days" / "next week" / "end of day". Defaults to 09:00 local. */
export function parseDue(text: string, now: Date, timezone: string): ParsedDate {
  const t = text.toLowerCase();
  const hour = (() => {
    const m = t.match(/\b(?:at|by)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
    if (!m) return null;
    let h = Number(m[1]);
    const mm = Number(m[2] ?? 0);
    if (m[3] === "pm" && h < 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
    return { h, mm };
  })();
  const H = hour?.h ?? 9;
  const M = hour?.mm ?? 0;
  if (/\b(end of (the )?day|eod|tonight)\b/.test(t)) return { iso: atLocal(now, timezone, 0, 17, 0), matched: "end of day" };
  if (/\btomorrow\b/.test(t)) return { iso: atLocal(now, timezone, 1, H, M), matched: "tomorrow" };
  if (/\btoday\b/.test(t)) return { iso: atLocal(now, timezone, 0, hour ? H : 17, M), matched: "today" };
  const inDays = t.match(/\bin\s+(\d{1,2})\s+days?\b/);
  if (inDays) return { iso: atLocal(now, timezone, Number(inDays[1]), H, M), matched: inDays[0] };
  if (/\bnext week\b/.test(t)) {
    const wd = localWeekday(now, timezone);
    const toMonday = ((8 - wd) % 7) || 7;
    return { iso: atLocal(now, timezone, toMonday, H, M), matched: "next week" };
  }
  const wdMatch = t.match(/\b(?:by|on|this|next)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (wdMatch) {
    const target = WEEKDAYS.indexOf(wdMatch[1]!);
    const cur = localWeekday(now, timezone);
    let delta = (target - cur + 7) % 7;
    if (delta === 0 || /\bnext\b/.test(wdMatch[0])) delta = delta === 0 ? 7 : delta + (/\bnext\b/.test(wdMatch[0]) && delta <= 7 ? 7 : 0);
    return { iso: atLocal(now, timezone, delta, H, M), matched: wdMatch[0].trim() };
  }
  const mon = t.match(new RegExp(`\\b(${MONTHS.join("|")})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`));
  if (mon) {
    const y = Number(new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric" }).format(now));
    const monthIdx = MONTHS.indexOf(mon[1]!);
    let candidate = new Date(Date.UTC(y, monthIdx, Number(mon[2]), 12));
    if (candidate.getTime() < now.getTime() - 86400000) candidate = new Date(Date.UTC(y + 1, monthIdx, Number(mon[2]), 12));
    const days = Math.round((candidate.getTime() - now.getTime()) / 86400000);
    return { iso: atLocal(now, timezone, days, H, M), matched: mon[0] };
  }
  const numeric = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (numeric) {
    const y = numeric[3] ? Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]) : Number(new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric" }).format(now));
    const candidate = new Date(Date.UTC(y, Number(numeric[1]) - 1, Number(numeric[2]), 12));
    const days = Math.round((candidate.getTime() - now.getTime()) / 86400000);
    return { iso: atLocal(now, timezone, days, H, M), matched: numeric[0] };
  }
  return { iso: null, matched: null };
}

const PERSISTENT = /\b(keep (on|reminding|bugging|nagging)|keep this on me|until (i|it'?s|its|it is) (actually |really )?(done|do|complete|completed|cancel|cancelled|sent|paid|finish|finished)|remind me daily|every day until|don'?t let (me|this) (forget|slip)|stay on me|hold me to)\b/i;
const CRITICAL = /\b(critical|non-?negotiable|absolutely must|no matter what)\b/i;
const IMPORTANT = /\b(important|urgent|make sure|must)\b/i;
const LOW = /\b(low priority|whenever|no rush|if i get to it|someday)\b/i;
const PERSONAL = /\b(dentist|doctor|gym|groceries|grocery|mom|dad|wife|husband|kids?|birthday|vacation|house|home|car|dog|cat|haircut|personal)\b/i;
const FINANCIAL = /\b(invoice|pay|payment|bill|subscription|renew|renewal|tax|bank|transfer|refund|charge)\b/i;
const BRIEFING_ONLY = /\b(only|just) (in|at|during) (my|the) (morning|daily) brief(ing)?\b/i;

function detectCadence(t: string): { follow_up_hours: number | null; daily_cap: number; briefing_only: boolean } {
  if (BRIEFING_ONLY.test(t)) return { follow_up_hours: null, daily_cap: 0, briefing_only: true };
  const everyHours = t.match(/\bevery\s+(\d{1,2}|few|couple of)\s+hours?\b/i);
  if (everyHours) {
    const n = everyHours[1] === "few" ? 3 : everyHours[1] === "couple of" ? 2 : Number(everyHours[1]);
    return { follow_up_hours: n, daily_cap: Math.max(2, Math.min(12, Math.round(10 / n))), briefing_only: false };
  }
  if (/\b(twice a day|two times a day)\b/i.test(t)) return { follow_up_hours: 5, daily_cap: 2, briefing_only: false };
  if (/\b(daily|every day|each day)\b/i.test(t)) return { follow_up_hours: 24, daily_cap: 1, briefing_only: false };
  return { follow_up_hours: null, daily_cap: 2, briefing_only: false };
}

/** Extracts capitalised names after send/email/call/follow up with/for/to. Lower-case sentences still work for common patterns. */
export function extractPeople(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(?:send|email|e-mail|text|call|message|ping|follow up with|follow-up with|chase|reply to|get back to|ask|remind|invoice|pay|meet(?: with)?|schedule(?: with)?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g)) out.add(m[1]!);
  for (const m of text.matchAll(/\b(?:to|for|from|with)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g)) {
    const name = m[1]!;
    if (!/^(Friday|Monday|Tuesday|Wednesday|Thursday|Saturday|Sunday|Jeff|Stripe|Notion|Gmail|Slack|Calendly)$/.test(name)) out.add(name);
  }
  return [...out].slice(0, 5);
}

/** Infers what would count as done from the verb. Never guesses an unknown provider. */
export function inferStrategy(text: string, people: string[]): { strategy: CompletionStrategy; uncertain: boolean } {
  const t = text.toLowerCase();
  const kw = (words: string[]) => words.filter((w) => t.includes(w));
  const base = (kind: CompletionStrategy["kind"], extra: Partial<CompletionStrategy["match"]> = {}, description: string | null = null, minConf = 0.85): CompletionStrategy =>
    CompletionStrategySchema.parse({ kind, match: { people, keywords: [], amount_minor: null, provider: null, vendor: null, ...extra }, min_confidence: minConf, description });
  const proposal = kw(["proposal", "quote", "estimate", "contract", "invoice", "deck", "report", "document", "file", "link", "update"]);
  if (/\b(send|email|e-mail|reply|respond|get back to|follow up|follow-up|share|forward)\b/.test(t)) {
    return { strategy: base("outbound_message", { keywords: proposal }, `An outbound message to ${people[0] ?? "the person"}${proposal.length ? ` mentioning ${proposal[0]}` : ""}`), uncertain: people.length === 0 };
  }
  if (/\b(cancel|unsubscribe|terminate|close the account)\b/.test(t)) {
    const vendor = text.match(/\b(?:cancel|unsubscribe from|terminate)\s+(?:my |the |our )?([A-Z][A-Za-z0-9]+)/)?.[1] ?? null;
    return { strategy: base("cancellation", { vendor, keywords: ["cancel", "cancellation", "confirmed"] }, `A cancellation confirmation${vendor ? ` from ${vendor}` : ""} OR the recurring charge disappearing`, 0.8), uncertain: !vendor };
  }
  if (/\b(pay|payment|invoice|bill|settle|wire|transfer)\b/.test(t)) {
    const amt = text.match(/\$\s?([\d,]+(?:\.\d{2})?)/);
    const minor = amt ? Math.round(Number(amt[1]!.replace(/,/g, "")) * 100) : null;
    return { strategy: base("payment", { amount_minor: minor, keywords: kw(["invoice", "bill"]) }, `A matching payment${minor ? ` of $${(minor / 100).toFixed(2)}` : ""} in Stripe or your bank feed`, 0.85), uncertain: !minor && people.length === 0 };
  }
  if (/\b(schedule|book|set up a (meeting|call|appointment)|make an appointment|appointment)\b/.test(t)) {
    const topic = kw(["dentist", "doctor", "contractor", "meeting", "call", "haircut", "vet", "appointment", "interview"]);
    return { strategy: base("calendar_event", { keywords: topic }, `A calendar event${topic.length ? ` about ${topic[0]}` : ""} appearing`, 0.9), uncertain: true };
  }
  if (/\b(deploy|ship|release|push live|publish the site)\b/.test(t)) return { strategy: base("deploy", {}, "A successful production deployment or merged pull request", 0.85), uncertain: false };
  if (/\b(fix|repair|patch)\b.*\b(workflow|automation|n8n|zap)\b/.test(t)) return { strategy: base("workflow_run", {}, "The workflow modified and a successful execution afterwards", 0.85), uncertain: false };
  if (/\b(lead|prospect|contact|client|customer)\b/.test(t) && /\b(follow up|call|reach out|check in|touch base)\b/.test(t)) return { strategy: base("crm_activity", {}, `A logged conversation or call with ${people[0] ?? "the contact"} in HighLevel`, 0.85), uncertain: people.length === 0 };
  return { strategy: base("manual", {}, "Only you can mark this done — Jeff has no reliable evidence source for it", 1), uncertain: true };
}

function cleanTitle(text: string): string {
  let t = text.trim();
  t = t.replace(/^(hey |ok |please |jeff,? |can you )+/i, "");
  t = t.replace(/^(remind me|make sure (that )?i|keep (on me|reminding me)|don'?t let me forget|i need) (to )?/i, "");
  t = t.replace(/\b(tomorrow|today|tonight|end of day|eod|next week|this (week|month)|in \d+ days?|(by|on|this|next) (sunday|monday|tuesday|wednesday|thursday|friday|saturday)|by \w+ \d{1,2}(st|nd|rd|th)?|at \d{1,2}(:\d{2})?\s*(am|pm)?)\b/gi, " ");
  t = t.replace(/\b(and )?(keep (on |reminding |bugging |nagging )?(me )?(about (this|it) )?until (i|it'?s|its|it is) (actually |really )?(done|do it|complete|completed|cancel it|cancelled|sent|paid|finish|finished)|keep this on me|until (it'?s|its|i'?m) done)\b.*$/i, "");
  t = t.replace(/\b(and )?(bug|remind|nag) me (about (this|it) )?(every|daily|twice).*$/i, "");
  t = t.replace(/\b(only|just) (in|at|during) (my|the) (morning|daily) brief(ing)?\b.*$/i, "");
  t = t.replace(/\s+/g, " ").replace(/[\s,.]+$/g, "").trim();
  if (!t) t = text.trim().slice(0, 120);
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function interpretReminder(text: string, now: Date, timezone: string): ObligationInterpretation {
  const people = extractPeople(text);
  const due = parseDue(text, now, timezone);
  const persistent = PERSISTENT.test(text);
  const tracking: TrackingMode = CRITICAL.test(text) ? "critical" : persistent && IMPORTANT.test(text) ? "important" : persistent ? "persistent" : IMPORTANT.test(text) ? "important" : "once";
  const priority: Priority = tracking === "critical" ? "critical" : tracking === "important" ? "high" : LOW.test(text) ? "low" : "normal";
  const scope = FINANCIAL.test(text) ? "financial" : PERSONAL.test(text) ? "personal" : "business";
  const { strategy, uncertain } = inferStrategy(text, people);
  const cadence = detectCadence(text);
  const waitingOther = /\b(waiting (on|for)|(they|he|she|client) (need|needs|has|have) to)\b/i.test(text);
  const ambiguities: string[] = [];
  if (!due.iso) ambiguities.push("No due date found — Jeff will treat it as 'soon' and remind in the next brief.");
  if (uncertain && strategy.kind !== "manual") ambiguities.push("Completion evidence may be ambiguous; Jeff will ask before closing it.");
  if (strategy.kind === "manual") ambiguities.push("No automatic completion source; you will need to mark it done.");
  const confidence = Math.max(0.35, Math.min(1, 0.55 + (due.iso ? 0.2 : 0) + (people.length ? 0.1 : 0) + (strategy.kind !== "manual" ? 0.1 : 0)));
  return ObligationInterpretationSchema.parse({
    title: cleanTitle(text),
    due_at: due.iso,
    remind_at: due.iso,
    tracking_mode: tracking,
    priority,
    scope,
    assigned_to: waitingOther ? "other" : "me",
    waiting_on: waitingOther ? (people[0] ?? null) : null,
    people,
    completion_strategy: strategy,
    cadence: { follow_up_hours: cadence.follow_up_hours, business_hours_only: tracking !== "critical", daily_cap: cadence.daily_cap, briefing_only: cadence.briefing_only },
    completion_uncertain: uncertain || strategy.kind === "manual",
    confidence,
    ambiguities,
  });
}

export function toObligationInput(i: ObligationInterpretation, origin = "jeff"): ObligationInput {
  return {
    title: i.title,
    description: null,
    scope: i.scope,
    origin,
    assigned_to: i.assigned_to,
    waiting_on: i.waiting_on,
    priority: i.priority,
    due_at: i.due_at,
    remind_at: i.remind_at,
    tracking_mode: i.tracking_mode,
    completion_strategy: i.completion_strategy,
    cadence: { follow_up_hours: i.cadence.follow_up_hours, business_hours_only: i.cadence.business_hours_only, daily_cap: i.cadence.daily_cap, briefing_only: i.cadence.briefing_only },
    related_goal_id: null,
    related_mission_id: null,
    related_client_id: null,
    counterparty: i.people[0] ?? null,
    source_provider: null,
    source_external_id: null,
    source_url: null,
    commitment_id: null,
    fingerprint: null,
    metadata: { people: i.people, completion_uncertain: i.completion_uncertain, interpretation_confidence: i.confidence },
  };
}
