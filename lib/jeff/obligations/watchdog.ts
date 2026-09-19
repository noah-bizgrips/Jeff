import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { ownerIdentity } from "@/lib/env";
import { errorMessage, log } from "@/lib/security/log";
import { redact, redactString } from "@/lib/security/redact";
import { loadRows } from "@/lib/jeff/monitors/index";
import type { SourceRow } from "@/lib/jeff/monitors/types";
import { loadFreshness } from "@/lib/jeff/freshness-store";
import type { ProviderFreshness } from "@/lib/jeff/freshness";
import { getSettings } from "@/lib/jeff/settings-store";
import type { OwnerSettings } from "@/lib/jeff/settings";
import { listCommitments } from "@/lib/jeff/commitments/store";
import { listRules } from "@/lib/jeff/rules/store";
import type { OperatingRule } from "@/lib/jeff/rules/schema";
import { assessCompletion, type CompletionAssessment } from "./completion";
import { decideReminder, type ReminderDecision } from "./reminders";
import { dedupeCandidates, OBLIGATION_SOURCES, sourceSaysDone, type SourceCandidate } from "./sources";
import { applyRulesToObligation } from "./rules";
import { createObligation, linkSource, listEvents, listObligations, listSources, markAutoCompleted, markPossiblyComplete, patchObligation, recordEvent } from "./store";
import { CompletionStrategySchema, LIVE_STATUSES, obligationFingerprint, type ObligationRow } from "./types";

/**
 * Follow-Through Watchdog — the lifecycle owner for Open Obligations.
 *
 * TEST mode: evaluates everything and reports what WOULD happen. No writes
 * except the caller's job_runs row. RUN mode: ingests, dedupes, detects
 * completion (auto-closes only at high confidence), schedules reminders, and
 * raises reminder alerts under quiet hours / daily caps / dedupe.
 */

export interface ItemOutcome {
  id: string | null;
  title: string;
  bucket: string;
  outcome: "would_remain_open" | "would_auto_complete" | "would_ask_confirmation" | "would_remind" | "would_create" | "would_merge" | "waiting_on_other" | "snoozed" | "uncertain";
  detail: string;
  confidence?: number;
}

export interface WatchdogSummary {
  mode: "test" | "run";
  open: number;
  overdue: number;
  waiting_on_me: number;
  waiting_on_other: number;
  possibly_complete: number;
  snoozed: number;
  created: number;
  merged: number;
  auto_completed: number;
  asked: number;
  reminders: number;
  suppressed_quiet_hours: number;
  suppressed_cap: number;
  unavailable_sources: string[];
  items: ItemOutcome[];
  notes: string[];
  rules_applied: number;
  duration_ms: number;
}

interface Ctx {
  ownerId: string;
  now: Date;
  rows: SourceRow[];
  freshness: ProviderFreshness[];
  settings: OwnerSettings;
  rules: OperatingRule[];
  ownerEmail: string | null;
}

async function loadCtx(ownerId: string, now: Date): Promise<Ctx> {
  const [rows, freshness, settings, rules] = await Promise.all([loadRows(ownerId), loadFreshness(ownerId, now).catch(() => [] as ProviderFreshness[]), getSettings(ownerId), listRules(ownerId).catch(() => [] as OperatingRule[])]);
  return { ownerId, now, rows, freshness, settings, rules: rules.filter((r) => r.enabled && !r.pending_confirmation), ownerEmail: ownerIdentity().email };
}

/** Commitments discovered by the classifier become obligations (origin "commitment"); never duplicated. */
async function commitmentCandidates(ownerId: string): Promise<SourceCandidate[]> {
  const commitments = await listCommitments(ownerId, { status: ["open", "overdue"], limit: 200 }).catch(() => []);
  return commitments.map((c) => {
    const mine = c.direction === "owed_by_me";
    const people = c.counterparty ? [c.counterparty] : [];
    return {
      title: c.action_text.slice(0, 200),
      description: c.context_text,
      scope: "business" as const,
      origin: "commitment",
      assigned_to: mine ? ("me" as const) : ("other" as const),
      waiting_on: mine ? null : c.counterparty,
      priority: "normal" as const,
      due_at: c.due_at,
      remind_at: c.due_at,
      tracking_mode: "persistent" as const,
      completion_strategy: CompletionStrategySchema.parse({ kind: mine ? "outbound_message" : "custom", match: { people, keywords: [], amount_minor: null, provider: c.provider ?? null, vendor: null }, min_confidence: 0.85, description: mine ? `An outbound message to ${c.counterparty ?? "them"} that closes the loop` : `A reply from ${c.counterparty ?? "them"} in the same thread` }),
      cadence: {},
      related_goal_id: null,
      related_mission_id: null,
      related_client_id: null,
      counterparty: c.counterparty,
      source_provider: c.provider,
      source_external_id: c.source_item_id,
      source_url: c.source_url,
      commitment_id: c.id,
      fingerprint: `commitment:${c.id}`,
      metadata: { commitment_confidence: c.confidence, people },
      people,
    };
  });
}

async function existingForDedupe(ownerId: string) {
  const live = await listObligations(ownerId, { live: true, limit: 500 });
  const admin = createAdminClient();
  const { data: srcRows } = await admin.from("obligation_sources").select("obligation_id, provider, external_id").eq("owner_id", ownerId);
  const byOb = new Map<string, { provider: string; external_id: string }[]>();
  for (const s of srcRows ?? []) byOb.set(s.obligation_id, [...(byOb.get(s.obligation_id) ?? []), { provider: s.provider, external_id: s.external_id }]);
  return { live, dedupe: live.map((o) => ({ id: o.id, title: o.title, due_at: o.due_at, people: (o.metadata.people as string[] | undefined) ?? (o.counterparty ? [o.counterparty] : []), source_refs: byOb.get(o.id) ?? [], status: o.status })) };
}

function bucketName(o: ObligationRow, now: Date): string {
  if (o.status === "snoozed" && o.snoozed_until && Date.parse(o.snoozed_until) > now.getTime()) return "snoozed";
  if (o.status === "possibly_complete") return "possibly_complete";
  if (o.assigned_to === "other" || o.status === "waiting_on_other") return "waiting_on_other";
  if (o.due_at && Date.parse(o.due_at) < now.getTime()) return "overdue";
  return "waiting_on_me";
}

/** Context trigger: an inbound message from the counterparty since the last reminder that mentions the topic. */
function findContextTrigger(o: ObligationRow, rows: SourceRow[], now: Date): { from: string; snippet: string } | null {
  const who = (o.counterparty ?? o.waiting_on ?? "").toLowerCase().split(" ")[0] ?? "";
  if (who.length < 3) return null;
  const since = o.last_reminded_at ? Date.parse(o.last_reminded_at) : Date.parse(o.created_at);
  const words = o.title
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3);
  for (const r of rows) {
    if (!["email", "message"].includes(r.resource_type)) continue;
    if (!r.source_timestamp || Date.parse(r.source_timestamp) <= since || Date.parse(r.source_timestamp) > now.getTime()) continue;
    const dir = String(r.metadata.direction ?? r.metadata.lastMessageDirection ?? "").toLowerCase();
    const labels = (r.metadata.labelIds as string[] | undefined) ?? [];
    if (dir === "outbound" || labels.includes("SENT")) continue;
    const hay = `${(r.author ?? "").toLowerCase()} ${(r.title ?? "").toLowerCase()}`;
    if (!hay.includes(who)) continue;
    const text = `${r.title ?? ""} ${r.summary ?? ""}`.toLowerCase();
    if (!words.some((w) => text.includes(w)) && !/update|status|any news|following up|checking in/.test(text)) continue;
    return { from: r.author ?? o.counterparty ?? "They", snippet: redactString((r.summary ?? r.title ?? "").slice(0, 160)) };
  }
  return null;
}

/** Upserts the reminder alert for an obligation and clears its push marker so the next push run delivers it. */
async function raiseReminderAlert(ownerId: string, o: ObligationRow, decision: ReminderDecision, now: Date): Promise<void> {
  const admin = createAdminClient();
  const fingerprint = `obligation:${o.id}`;
  const iso = now.toISOString();
  const importance = decision.importance;
  const scope = o.scope === "all" ? "business" : o.scope;
  const { data: existing } = await admin.from("alerts").select("id, occurrences").eq("owner_id", ownerId).eq("fingerprint", fingerprint).maybeSingle();
  const payload = {
    kind: "obligation",
    ref_id: o.id,
    importance,
    scope,
    category: o.assigned_to === "other" ? "obligation_waiting_on_other" : "obligation_waiting_on_me",
    title: (o.assigned_to === "other" ? `Waiting on ${o.waiting_on ?? o.counterparty ?? "someone"}: ${o.title}` : `Reminder: ${o.title}`).slice(0, 300),
    summary: redactString(decision.copy).slice(0, 2000),
    evidence: o.source_url ? [{ url: o.source_url, title: o.title }] : [],
    status: "open",
    last_seen: iso,
    pushed_at: null,
    pushed_importance: null,
    deferred_until: null,
    rule_trace: redact({ reason: decision.reason, escalation_level: decision.escalation_level, tracking_mode: o.tracking_mode }),
  };
  if (existing) await admin.from("alerts").update({ ...payload, occurrences: (existing.occurrences ?? 1) + 1 }).eq("id", existing.id);
  else await admin.from("alerts").insert({ owner_id: ownerId, fingerprint, first_seen: iso, occurrences: 1, ...payload });
  await patchObligation(ownerId, o.id, { last_reminded_at: iso, reminder_count: o.reminder_count + 1, escalation_level: decision.escalation_level, next_reminder_at: null, status: o.status === "open" && o.due_at && Date.parse(o.due_at) < now.getTime() ? "overdue" : o.status });
  await recordEvent(ownerId, o.id, decision.reason === "context trigger" ? "context_trigger" : "reminded", { importance, reason: decision.reason, level: decision.escalation_level }, now);
  if (decision.escalation_level > o.escalation_level) await recordEvent(ownerId, o.id, "escalated", { level: decision.escalation_level }, now);
  await audit({ event: "obligation_reminded", ownerId, actor: "system", targetId: o.id, metadata: { importance, reason: decision.reason } });
}

export async function runFollowThrough(ownerId: string, opts: { mode: "test" | "run"; now?: Date }): Promise<WatchdogSummary> {
  const now = opts.now ?? new Date();
  const started = Date.now();
  const mode = opts.mode;
  const ctx = await loadCtx(ownerId, now);
  const notes: string[] = [];
  const items: ItemOutcome[] = [];
  const summary: WatchdogSummary = { mode, open: 0, overdue: 0, waiting_on_me: 0, waiting_on_other: 0, possibly_complete: 0, snoozed: 0, created: 0, merged: 0, auto_completed: 0, asked: 0, reminders: 0, suppressed_quiet_hours: 0, suppressed_cap: 0, unavailable_sources: [], items, notes, rules_applied: 0, duration_ms: 0 };

  const connected = new Set(ctx.freshness.map((f) => f.provider));
  const stale = ctx.freshness.filter((f) => f.age_hours == null || f.age_hours > 6 || !["connected", "limited"].includes(f.status)).map((f) => f.provider);
  summary.unavailable_sources = stale;
  if (stale.length) notes.push(`${stale.join(", ")} data is stale — completion checks that depend on it stay uncertain.`);
  const apple = OBLIGATION_SOURCES.find((s) => s.id === "apple_reminders");
  if (apple) notes.push("Apple Reminders is not connected (no supported integration yet).");

  // 1. Ingest candidates from sources + commitments; dedupe against live obligations.
  const candidates: SourceCandidate[] = [];
  for (const src of OBLIGATION_SOURCES) {
    if (src.status !== "available" || !src.provider || !connected.has(src.provider)) continue;
    try {
      candidates.push(...src.extract(ctx.rows, now));
    } catch (err) {
      notes.push(`${src.label} ingestion failed: ${errorMessage(err)}`);
    }
  }
  candidates.push(...(await commitmentCandidates(ownerId)));
  const { live, dedupe } = await existingForDedupe(ownerId);
  const matches = dedupeCandidates(candidates, dedupe);
  const liveById = new Map(live.map((o) => [o.id, o]));
  // Terminal obligations must not be recreated from the same source (dismissed stays dismissed).
  const admin = createAdminClient();
  const fps = matches.map((m) => m.candidate.fingerprint).filter((f): f is string => !!f);
  const { data: terminalRows } = fps.length ? await admin.from("obligations").select("fingerprint, status").eq("owner_id", ownerId).in("fingerprint", fps).in("status", ["completed", "dismissed", "cancelled"]) : { data: [] as { fingerprint: string; status: string }[] };
  const terminal = new Set((terminalRows ?? []).map((r) => r.fingerprint));
  const createdByFingerprint = new Map<string, ObligationRow>();

  for (const m of matches) {
    const c = m.candidate;
    if (c.fingerprint && terminal.has(c.fingerprint)) continue;
    if (m.duplicateOfFingerprint) {
      const primary = createdByFingerprint.get(m.duplicateOfFingerprint);
      if (mode === "run" && primary && c.source_provider && c.source_external_id) await linkSource(ownerId, primary.id, { provider: c.source_provider, external_id: c.source_external_id, url: c.source_url, kind: c.origin });
      if (mode === "run" && !primary) continue; // primary was excluded or already existed; nothing to link
      summary.merged++;
      items.push({ id: primary?.id ?? null, title: c.title, bucket: c.assigned_to === "other" ? "waiting_on_other" : "waiting_on_me", outcome: "would_merge", detail: `Also found in ${c.origin}; linked as an additional source of the same obligation.` });
      continue;
    }
    const ruled = applyRulesToObligation(ctx.rules, c);
    if (ruled.excluded) {
      summary.rules_applied++;
      continue;
    }
    if (ruled.changed) summary.rules_applied++;
    const input = ruled.input;
    if (m.matchesExistingId) {
      const target = liveById.get(m.matchesExistingId);
      if (target && c.source_provider && c.source_external_id) {
        if (mode === "run") await linkSource(ownerId, target.id, { provider: c.source_provider, external_id: c.source_external_id, url: c.source_url, kind: c.origin });
        summary.merged++;
        items.push({ id: target.id, title: target.title, bucket: bucketName(target, now), outcome: "would_merge", detail: `Also found in ${c.origin}; linked as an additional source (confidence ${Math.round(m.confidence * 100)}%).` });
        // Source-driven completion (Notion/portal marked done).
        if (sourceSaysDone(c) && mode === "run") await markAutoCompleted(ownerId, target.id, [{ source_item_id: null, provider: c.source_provider, external_id: c.source_external_id, url: c.source_url, title: c.title, observed_at: now.toISOString(), reason: `${c.origin} marks this task as done` }], 0.95, now);
      }
      continue;
    }
    if (sourceSaysDone(c)) continue; // already done at the source; nothing to track
    if (mode === "run") {
      const res = await createObligation(ownerId, { ...input, fingerprint: c.fingerprint }, { actor: "system", now });
      if (res.created) {
        summary.created++;
        liveById.set(res.row.id, res.row);
        if (c.fingerprint) createdByFingerprint.set(c.fingerprint, res.row);
        items.push({ id: res.row.id, title: res.row.title, bucket: bucketName(res.row, now), outcome: "would_create", detail: `Created from ${c.origin}.` });
      }
    } else {
      summary.created++;
      items.push({ id: null, title: input.title, bucket: input.assigned_to === "other" ? "waiting_on_other" : "waiting_on_me", outcome: "would_create", detail: `Would be created from ${c.origin}${input.due_at ? `, due ${input.due_at.slice(0, 10)}` : ""}.` });
    }
  }

  // 2. Evaluate every live obligation: completion, then reminders.
  const current = mode === "run" ? await listObligations(ownerId, { live: true, limit: 500 }) : live;
  for (let o of current) {
    if (!LIVE_STATUSES.includes(o.status)) continue;
    const bucket = bucketName(o, now);
    summary.open++;
    if (bucket === "overdue") summary.overdue++;
    if (bucket === "waiting_on_me") summary.waiting_on_me++;
    if (bucket === "waiting_on_other") summary.waiting_on_other++;
    if (bucket === "possibly_complete") summary.possibly_complete++;
    if (bucket === "snoozed") summary.snoozed++;

    // Snoozed items resume automatically when the snooze expires.
    if (o.status === "snoozed" && o.snoozed_until && Date.parse(o.snoozed_until) <= now.getTime() && mode === "run") {
      const reopened = await patchObligation(ownerId, o.id, { status: o.assigned_to === "other" ? "waiting_on_other" : o.due_at && Date.parse(o.due_at) < now.getTime() ? "overdue" : "open", snoozed_until: null, next_reminder_at: now.toISOString() });
      await recordEvent(ownerId, o.id, "reopened", { reason: "snooze_expired" }, now);
      if (reopened) o = reopened;
    }
    if (bucket === "snoozed") {
      items.push({ id: o.id, title: o.title, bucket, outcome: "snoozed", detail: `Snoozed until ${o.snoozed_until?.slice(0, 16) ?? "?"}.` });
      continue;
    }

    // Completion detection (deterministic, freshness-aware).
    let assessment: CompletionAssessment | null = null;
    if (o.status !== "possibly_complete") {
      assessment = assessCompletion({ obligation: o, rows: ctx.rows, freshness: ctx.freshness, now, ownerEmail: ctx.ownerEmail });
      if (assessment.tier === "high") {
        summary.auto_completed++;
        items.push({ id: o.id, title: o.title, bucket, outcome: "would_auto_complete", detail: assessment.explanation, confidence: assessment.confidence });
        if (mode === "run") await markAutoCompleted(ownerId, o.id, assessment.evidence, assessment.confidence, now);
        continue;
      }
      if (assessment.tier === "medium") {
        summary.asked++;
        items.push({ id: o.id, title: o.title, bucket, outcome: "would_ask_confirmation", detail: assessment.question ?? assessment.explanation, confidence: assessment.confidence });
        if (mode === "run") await markPossiblyComplete(ownerId, o.id, assessment.evidence, assessment.confidence, assessment.question ?? "Did this complete the reminder?", now);
        continue;
      }
      if (mode === "run") await patchObligation(ownerId, o.id, { last_checked_at: now.toISOString() });
    } else {
      items.push({ id: o.id, title: o.title, bucket, outcome: "would_ask_confirmation", detail: o.completion_question ?? "Awaiting your confirmation.", confidence: o.completion_confidence ?? undefined });
      continue;
    }

    // Reminders.
    const events = mode === "run" ? await listEvents(ownerId, o.id, 40) : [];
    const trigger = findContextTrigger(o, ctx.rows, now);
    const decision = decideReminder({ obligation: o, events, settings: ctx.settings, now, contextTrigger: trigger });
    if (decision.remind) {
      summary.reminders++;
      items.push({ id: o.id, title: o.title, bucket, outcome: bucket === "waiting_on_other" ? "waiting_on_other" : "would_remind", detail: `${decision.reason === "context trigger" ? "Context trigger — " : ""}${decision.copy} (${decision.importance})` });
      if (mode === "run") await raiseReminderAlert(ownerId, o, decision, now);
    } else {
      if (decision.reason === "quiet hours") summary.suppressed_quiet_hours++;
      if (decision.reason.startsWith("daily cap")) summary.suppressed_cap++;
      const outcome: ItemOutcome["outcome"] = assessment?.tier === "uncertain" ? "uncertain" : bucket === "waiting_on_other" ? "waiting_on_other" : "would_remain_open";
      items.push({ id: o.id, title: o.title, bucket, outcome, detail: `${assessment?.explanation ?? ""} Reminder: ${decision.reason}${decision.next_reminder_at ? ` (next ${decision.next_reminder_at.slice(0, 16)})` : ""}.`.trim() });
      if (mode === "run" && decision.next_reminder_at !== o.next_reminder_at) await patchObligation(ownerId, o.id, { next_reminder_at: decision.next_reminder_at, escalation_level: decision.escalation_level });
    }
  }

  if (mode === "run") {
    // Reminder alerts for the same client / goal / contact bundle under one parent before any push goes out.
    try {
      const { syncAlertGroups } = await import("@/lib/jeff/grouping/store");
      await syncAlertGroups(ownerId, now);
    } catch (err) {
      log.warn("obligation_grouping_failed", { message: errorMessage(err) });
    }
    try {
      const { pushPendingAlerts } = await import("@/lib/jeff/push/alerts");
      await pushPendingAlerts(ownerId, now);
    } catch (err) {
      log.warn("obligation_push_failed", { message: errorMessage(err) });
    }
  }
  summary.duration_ms = Date.now() - started;
  return summary;
}

/** Cheap re-check for one obligation (used by "did I do X?" and the detail view). */
export async function assessOne(ownerId: string, o: ObligationRow, now = new Date()): Promise<CompletionAssessment> {
  const ctx = await loadCtx(ownerId, now);
  return assessCompletion({ obligation: o, rows: ctx.rows, freshness: ctx.freshness, now, ownerEmail: ctx.ownerEmail });
}

/** Evidence search for "did I ever send Brian that proposal?" without an existing obligation. */
export async function searchEvidence(ownerId: string, question: string, now = new Date()): Promise<{ assessment: CompletionAssessment; strategy: string }> {
  const { interpretReminder } = await import("./interpret");
  const settings = await getSettings(ownerId);
  const i = interpretReminder(question.replace(/^did i (ever )?/i, ""), now, settings.timezone);
  const fake: ObligationRow = {
    id: "search",
    owner_id: ownerId,
    title: i.title,
    description: null,
    scope: i.scope,
    origin: "jeff",
    source_provider: null,
    source_external_id: null,
    source_url: null,
    commitment_id: null,
    assigned_to: "me",
    waiting_on: null,
    status: "open",
    priority: "normal",
    due_at: null,
    remind_at: null,
    snoozed_until: null,
    tracking_mode: "once",
    completion_strategy: i.completion_strategy,
    completion_confidence: null,
    completion_evidence: [],
    completion_question: null,
    cadence: {},
    escalation_level: 0,
    reminder_count: 0,
    last_checked_at: null,
    last_reminded_at: null,
    next_reminder_at: null,
    related_goal_id: null,
    related_mission_id: null,
    related_client_id: null,
    counterparty: i.people[0] ?? null,
    fingerprint: null,
    metadata: { completion_check_since: new Date(now.getTime() - 60 * 86400000).toISOString() },
    completed_at: null,
    dismissed_at: null,
    cancelled_at: null,
    created_at: new Date(now.getTime() - 60 * 86400000).toISOString(),
    updated_at: now.toISOString(),
  };
  const ctx = await loadCtx(ownerId, now);
  return { assessment: assessCompletion({ obligation: fake, rows: ctx.rows, freshness: ctx.freshness, now, ownerEmail: ctx.ownerEmail }), strategy: i.completion_strategy.kind };
}

export { obligationFingerprint, listSources };
