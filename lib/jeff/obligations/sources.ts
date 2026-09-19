import type { SourceRow } from "@/lib/jeff/monitors/types";
import { CompletionStrategySchema, obligationFingerprint, type ObligationInput } from "./types";

/**
 * Obligation sources — a provider abstraction that normalises "things that
 * still need to happen" from connected data. Each source is a pure function
 * over SourceRows. Apple Reminders has no public API; it is listed as
 * `not_configured` so the UI is honest about coverage.
 */

export interface SourceCandidate extends ObligationInput {
  /** People involved (for dedupe + completion matching). */
  people: string[];
}

export interface ObligationSourceAdapter {
  id: string;
  label: string;
  provider: string | null;
  status: "available" | "not_configured";
  extract(rows: SourceRow[], now: Date): SourceCandidate[];
}

const TASK_WORDS = /\b(due|deadline|send|submit|renew|renewal|pay|payment|invoice|deliver|file|cancel|follow[- ]?up|review|approve|sign|respond|reply|finish|complete|ship|book|schedule|reminder|todo|to-do)\b/i;
const JEFF_TAG = /\bjeff:/i;
const MEETING_WORDS = /\b(meeting|call|sync|standup|1:1|one on one|check-?in|interview|lunch|coffee|demo|kickoff)\b/i;

function strategyFor(title: string): ObligationInput["completion_strategy"] {
  const t = title.toLowerCase();
  const kind = /\b(send|submit|reply|respond|follow)/.test(t) ? "outbound_message" : /\b(pay|invoice|bill|renew)/.test(t) ? "payment" : /\bcancel/.test(t) ? "cancellation" : "manual";
  return CompletionStrategySchema.parse({ kind, match: { people: [], keywords: [], amount_minor: null, provider: null, vendor: null }, min_confidence: 0.85, description: null });
}

function base(over: Partial<SourceCandidate> & Pick<SourceCandidate, "title" | "origin">): SourceCandidate {
  const people = over.people ?? [];
  return {
    title: over.title.slice(0, 200),
    description: over.description ?? null,
    scope: over.scope ?? "business",
    origin: over.origin,
    assigned_to: over.assigned_to ?? "me",
    waiting_on: over.waiting_on ?? null,
    priority: over.priority ?? "normal",
    due_at: over.due_at ?? null,
    remind_at: over.remind_at ?? over.due_at ?? null,
    tracking_mode: over.tracking_mode ?? "once",
    completion_strategy: over.completion_strategy ?? strategyFor(over.title),
    cadence: over.cadence ?? {},
    related_goal_id: null,
    related_mission_id: null,
    related_client_id: over.related_client_id ?? null,
    counterparty: over.counterparty ?? people[0] ?? null,
    source_provider: over.source_provider ?? null,
    source_external_id: over.source_external_id ?? null,
    source_url: over.source_url ?? null,
    commitment_id: over.commitment_id ?? null,
    fingerprint: over.fingerprint ?? obligationFingerprint(over.title, over.due_at ?? null, people),
    metadata: { ...(over.metadata ?? {}), people },
    people,
  };
}

/** Calendar: only task-like/deadline events. Meetings never become open obligations after they pass. */
export const calendarSource: ObligationSourceAdapter = {
  id: "calendar",
  label: "Google Calendar",
  provider: "google",
  status: "available",
  extract(rows, now) {
    const out: SourceCandidate[] = [];
    for (const r of rows) {
      if (r.provider !== "google" || r.resource_type !== "event" || !r.title) continue;
      const title = r.title;
      const tagged = JEFF_TAG.test(title) || JEFF_TAG.test(r.summary ?? "");
      const taskLike = TASK_WORDS.test(title) && !MEETING_WORDS.test(title);
      const isAllDayDeadline = !!r.metadata.all_day && /\b(due|deadline|renew|expires?)\b/i.test(title);
      if (!tagged && !taskLike && !isAllDayDeadline) continue;
      // Passed meeting-style events are not obligations; passed deadline events are (they may still be unresolved).
      if (!tagged && !taskLike && !isAllDayDeadline && r.source_timestamp && Date.parse(r.source_timestamp) < now.getTime()) continue;
      const stripped = title.replace(JEFF_TAG, "").trim();
      const clean = stripped.charAt(0).toUpperCase() + stripped.slice(1);
      out.push(base({ title: clean, origin: "calendar", source_provider: "google", source_external_id: r.external_id, source_url: r.source_url, due_at: r.source_timestamp, scope: "business", metadata: { calendar_event: true, tagged } }));
    }
    return out;
  },
};

/** Notion: pages with a task-ish status/checkbox/date property. Completion is read from the status property. */
export const notionSource: ObligationSourceAdapter = {
  id: "notion",
  label: "Notion tasks",
  provider: "notion",
  status: "available",
  extract(rows) {
    const out: SourceCandidate[] = [];
    for (const r of rows) {
      if (r.provider !== "notion" || r.resource_type !== "page" || !r.title) continue;
      const props = (r.metadata.properties ?? r.metadata.property_summary ?? {}) as Record<string, unknown>;
      const entries = Object.entries(props);
      const statusEntry = entries.find(([k]) => /status|state|done|complete/i.test(k));
      const dateEntry = entries.find(([k]) => /due|date|deadline/i.test(k));
      const assigneeEntry = entries.find(([k]) => /assign|owner/i.test(k));
      if (!statusEntry && !dateEntry) continue;
      const statusVal = String(statusEntry?.[1] ?? "").toLowerCase();
      const done = statusVal === "true" || /done|complete|closed|shipped|archived/.test(statusVal);
      const due = dateEntry && typeof dateEntry[1] === "string" && !Number.isNaN(Date.parse(dateEntry[1])) ? new Date(dateEntry[1]).toISOString() : null;
      out.push(base({ title: r.title, origin: "notion", source_provider: "notion", source_external_id: r.external_id, source_url: r.source_url, due_at: due, metadata: { notion_status: statusVal || null, notion_done: done, assignee: assigneeEntry ? String(assigneeEntry[1]) : null }, completion_strategy: CompletionStrategySchema.parse({ kind: "custom", match: { people: [], keywords: [], amount_minor: null, provider: "notion", vendor: null }, min_confidence: 0.9, description: "The Notion task status changes to done" }) }));
    }
    return out;
  },
};

/** HighLevel: appointments that need preparation/attendance are not obligations; clearly actionable follow-ups are. */
export const highlevelSource: ObligationSourceAdapter = {
  id: "highlevel",
  label: "HighLevel follow-ups",
  provider: "highlevel",
  status: "available",
  extract(rows, now) {
    const out: SourceCandidate[] = [];
    for (const r of rows) {
      if (r.provider !== "highlevel") continue;
      if (r.resource_type === "message" && String(r.metadata.lastMessageDirection ?? "").toLowerCase() === "inbound") {
        const unread = Number(r.metadata.unreadCount ?? 0) > 0;
        const ageH = r.source_timestamp ? (now.getTime() - Date.parse(r.source_timestamp)) / 3_600_000 : 0;
        if (unread && ageH > 24) {
          const who = String(r.metadata.contactName ?? r.title?.split(" · ")[0] ?? "a contact");
          out.push(base({ title: `Reply to ${who}`, origin: "highlevel", source_provider: "highlevel", source_external_id: r.external_id, source_url: r.source_url, due_at: null, people: [who], counterparty: who, tracking_mode: "persistent", completion_strategy: CompletionStrategySchema.parse({ kind: "crm_activity", match: { people: [who], keywords: [], amount_minor: null, provider: "highlevel", vendor: null }, min_confidence: 0.85, description: `An outbound reply to ${who} in HighLevel` }), metadata: { unread_inbound: true, contactId: r.metadata.contactId ?? null } }));
        }
      }
    }
    return out;
  },
};

/** Client portal tasks: BizGrips-owned → waiting on me; client-owned → waiting on the client. */
export const portalSource: ObligationSourceAdapter = {
  id: "portal",
  label: "Client portal tasks",
  provider: "portal",
  status: "available",
  extract(rows, now) {
    const out: SourceCandidate[] = [];
    for (const r of rows) {
      if (r.provider !== "portal" || r.resource_type !== "task" || !r.title) continue;
      const status = String(r.metadata.status ?? "").toLowerCase();
      if (status === "complete") continue;
      const owner = String(r.metadata.owner ?? "BizGrips");
      const due = r.source_timestamp ?? (typeof r.metadata.due_at === "string" ? r.metadata.due_at : null);
      if (!due || Date.parse(due) > now.getTime()) continue; // only overdue portal tasks become obligations
      const client = String(r.metadata.client_name ?? r.metadata.client_id ?? "client");
      const other = owner.toLowerCase() === "client";
      out.push(base({ title: `${r.title} (${client})`, origin: "portal", source_provider: "portal", source_external_id: r.external_id, source_url: r.source_url, due_at: due, assigned_to: other ? "other" : "me", waiting_on: other ? client : null, related_client_id: r.metadata.client_id ? String(r.metadata.client_id) : null, priority: r.metadata.blocking ? "high" : "normal", tracking_mode: "persistent", completion_strategy: CompletionStrategySchema.parse({ kind: "custom", match: { people: [], keywords: [], amount_minor: null, provider: "portal", vendor: null }, min_confidence: 0.9, description: "The portal task is marked complete" }), metadata: { portal_task: true, owner, blocking: !!r.metadata.blocking, client_id: r.metadata.client_id ?? null } }));
    }
    return out;
  },
};

export const appleSource: ObligationSourceAdapter = { id: "apple_reminders", label: "Apple Reminders", provider: null, status: "not_configured", extract: () => [] };

export const OBLIGATION_SOURCES: ObligationSourceAdapter[] = [calendarSource, notionSource, highlevelSource, portalSource, appleSource];

/** Source-driven completion for portal/notion tasks: the origin system says it is done. */
export function sourceSaysDone(candidate: SourceCandidate): boolean {
  return candidate.metadata.notion_done === true;
}

/* ------------------------------------------------------------------ */
/* Dedupe                                                              */
/* ------------------------------------------------------------------ */

function tokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !["the", "and", "for", "with", "send", "reply"].includes(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface DedupeMatch {
  candidate: SourceCandidate;
  matchesExistingId: string | null;
  confidence: number;
  /** Same fingerprint as an earlier candidate in this batch (e.g. Notion + calendar): link as a source of that one. */
  duplicateOfFingerprint?: string;
}

/**
 * Same obligation in several systems → one obligation with several sources.
 * Merge only when confident (same external ref, or title similarity ≥ 0.6 with
 * the same person or due day). Ambiguous pairs stay separate.
 */
export function dedupeCandidates(candidates: SourceCandidate[], existing: { id: string; title: string; due_at: string | null; people: string[]; source_refs: { provider: string; external_id: string }[]; status: string }[]): DedupeMatch[] {
  const out: DedupeMatch[] = [];
  const seenInBatch: SourceCandidate[] = [];
  for (const c of candidates) {
    let bestId: string | null = null;
    let bestScore = 0;
    for (const e of existing) {
      if (e.source_refs.some((s) => s.provider === c.source_provider && s.external_id === c.source_external_id)) {
        bestId = e.id;
        bestScore = 1;
        break;
      }
      const sim = jaccard(tokens(c.title), tokens(e.title));
      const samePerson = c.people.length && e.people.length ? c.people.some((p) => e.people.map((x) => x.toLowerCase()).includes(p.toLowerCase())) : false;
      const sameDay = c.due_at && e.due_at ? c.due_at.slice(0, 10) === e.due_at.slice(0, 10) : false;
      const score = sim >= 0.6 && (samePerson || sameDay) ? Math.min(0.95, sim + 0.2) : sim >= 0.85 ? sim : 0;
      if (score > bestScore) {
        bestScore = score;
        bestId = e.id;
      }
    }
    // Within-batch duplicates: keep the first, link the rest to it later via fingerprint equality.
    const dupInBatch = c.fingerprint ? seenInBatch.find((s) => s.fingerprint === c.fingerprint) : undefined;
    if (dupInBatch) {
      out.push({ candidate: c, matchesExistingId: null, confidence: 1, duplicateOfFingerprint: dupInBatch.fingerprint! });
      continue;
    }
    seenInBatch.push(c);
    out.push({ candidate: c, matchesExistingId: bestScore >= 0.75 ? bestId : null, confidence: bestScore });
  }
  return out;
}
