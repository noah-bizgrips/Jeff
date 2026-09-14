import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { redact, redactString } from "@/lib/security/redact";
import { audit } from "@/lib/audit";
import { log } from "@/lib/security/log";
import {
  CadenceSchema,
  CompletionStrategySchema,
  LIVE_STATUSES,
  type Cadence,
  type EvidenceRef,
  type ObligationActionInput,
  type ObligationEventKind,
  type ObligationEventRow,
  type ObligationInput,
  type ObligationRow,
  type ObligationSourceRow,
  type ObligationStatus,
} from "./types";

const COLUMNS =
  "id, owner_id, title, description, scope, origin, source_provider, source_external_id, source_url, commitment_id, assigned_to, waiting_on, status, priority, due_at, remind_at, snoozed_until, tracking_mode, completion_strategy, completion_confidence, completion_evidence, completion_question, cadence, escalation_level, reminder_count, last_checked_at, last_reminded_at, next_reminder_at, related_goal_id, related_mission_id, related_client_id, counterparty, fingerprint, metadata, completed_at, dismissed_at, cancelled_at, created_at, updated_at";

function normalize(row: Record<string, unknown>): ObligationRow {
  const r = row as unknown as ObligationRow;
  return {
    ...r,
    completion_strategy: CompletionStrategySchema.safeParse(r.completion_strategy).success ? CompletionStrategySchema.parse(r.completion_strategy) : CompletionStrategySchema.parse({}),
    cadence: CadenceSchema.partial().safeParse(r.cadence).success ? (r.cadence as Partial<Cadence>) : {},
    completion_evidence: Array.isArray(r.completion_evidence) ? r.completion_evidence : [],
    metadata: r.metadata ?? {},
    completion_confidence: r.completion_confidence == null ? null : Number(r.completion_confidence),
  };
}


export interface ObligationFilters {
  statuses?: ObligationStatus[];
  live?: boolean;
  scope?: string;
  assignedTo?: "me" | "other";
  limit?: number;
}

export async function listObligations(ownerId: string, f: ObligationFilters = {}): Promise<ObligationRow[]> {
  const admin = createAdminClient();
  let q = admin.from("obligations").select(COLUMNS).eq("owner_id", ownerId).order("due_at", { ascending: true, nullsFirst: false }).limit(f.limit ?? 300);
  if (f.statuses?.length) q = q.in("status", f.statuses);
  else if (f.live) q = q.in("status", LIVE_STATUSES);
  if (f.scope && f.scope !== "all") q = q.in("scope", [f.scope, "all"]);
  if (f.assignedTo) q = q.eq("assigned_to", f.assignedTo);
  const { data, error } = await q;
  if (error) throw new Error(`obligations_list_failed:${error.code ?? ""}:${redactString(error.message ?? "").slice(0, 120)}`);
  return (data ?? []).map((r) => normalize(r as Record<string, unknown>));
}

export async function getObligation(ownerId: string, id: string): Promise<ObligationRow | null> {
  const admin = createAdminClient();
  const { data } = await admin.from("obligations").select(COLUMNS).eq("owner_id", ownerId).eq("id", id).maybeSingle();
  return data ? normalize(data as Record<string, unknown>) : null;
}

export async function findByFingerprint(ownerId: string, fingerprint: string): Promise<ObligationRow | null> {
  const admin = createAdminClient();
  const { data } = await admin.from("obligations").select(COLUMNS).eq("owner_id", ownerId).eq("fingerprint", fingerprint).maybeSingle();
  return data ? normalize(data as Record<string, unknown>) : null;
}

export async function recordEvent(ownerId: string, obligationId: string, kind: ObligationEventKind, payload: Record<string, unknown> = {}, at?: Date): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("obligation_events").insert({ owner_id: ownerId, obligation_id: obligationId, kind, payload: redact(payload), ...(at ? { created_at: at.toISOString() } : {}) });
  if (error) log.warn("obligation_event_failed", { kind, message: error.message });
}

export async function listEvents(ownerId: string, obligationId: string, limit = 50): Promise<ObligationEventRow[]> {
  const admin = createAdminClient();
  const { data } = await admin.from("obligation_events").select("id, obligation_id, kind, payload, created_at").eq("owner_id", ownerId).eq("obligation_id", obligationId).order("created_at", { ascending: false }).limit(limit);
  return (data ?? []) as ObligationEventRow[];
}

export async function listSources(ownerId: string, obligationId: string): Promise<ObligationSourceRow[]> {
  const admin = createAdminClient();
  const { data } = await admin.from("obligation_sources").select("id, obligation_id, provider, external_id, url, kind, is_primary").eq("owner_id", ownerId).eq("obligation_id", obligationId);
  return (data ?? []) as ObligationSourceRow[];
}

export async function linkSource(ownerId: string, obligationId: string, src: { provider: string; external_id: string; url?: string | null; kind?: string | null; is_primary?: boolean }): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("obligation_sources")
    .upsert({ owner_id: ownerId, obligation_id: obligationId, provider: src.provider, external_id: src.external_id, url: src.url ?? null, kind: src.kind ?? null, is_primary: !!src.is_primary }, { onConflict: "owner_id,provider,external_id" });
  if (error) log.warn("obligation_source_link_failed", { message: error.message });
}

/** Creates an obligation (owner reminder, ingested candidate, commitment hand-off). Dedupes by fingerprint when supplied. */
export async function createObligation(ownerId: string, input: ObligationInput, opts: { actor?: "owner" | "system" | "jeff"; now?: Date } = {}): Promise<{ row: ObligationRow; created: boolean }> {
  if (input.fingerprint) {
    const existing = await findByFingerprint(ownerId, input.fingerprint);
    if (existing) return { row: existing, created: false };
  }
  if (input.commitment_id) {
    const admin = createAdminClient();
    const { data } = await admin.from("obligations").select(COLUMNS).eq("owner_id", ownerId).eq("commitment_id", input.commitment_id).maybeSingle();
    if (data) return { row: normalize(data as Record<string, unknown>), created: false };
  }
  const admin = createAdminClient();
  const status: ObligationStatus = input.assigned_to === "other" ? "waiting_on_other" : "open";
  const remindAt = input.remind_at ?? input.due_at ?? null;
  const { data, error } = await admin
    .from("obligations")
    .insert({
      owner_id: ownerId,
      title: input.title,
      description: input.description,
      scope: input.scope,
      origin: input.origin,
      source_provider: input.source_provider,
      source_external_id: input.source_external_id,
      source_url: input.source_url,
      commitment_id: input.commitment_id,
      assigned_to: input.assigned_to,
      waiting_on: input.waiting_on,
      status,
      priority: input.priority,
      due_at: input.due_at,
      remind_at: remindAt,
      next_reminder_at: remindAt,
      tracking_mode: input.tracking_mode,
      completion_strategy: input.completion_strategy,
      cadence: input.cadence,
      related_goal_id: input.related_goal_id,
      related_mission_id: input.related_mission_id,
      related_client_id: input.related_client_id,
      counterparty: input.counterparty,
      fingerprint: input.fingerprint,
      metadata: redact(input.metadata),
      // Honor an explicit clock (ingestion/replays/tests); otherwise the DB default applies.
      ...(opts.now ? { created_at: opts.now.toISOString(), updated_at: opts.now.toISOString() } : {}),
    })
    .select(COLUMNS)
    .single();
  if (error || !data) throw new Error(`obligation_create_failed:${error?.code ?? ""}:${redactString(error?.message ?? "").slice(0, 120)}`);
  const row = normalize(data as Record<string, unknown>);
  await recordEvent(ownerId, row.id, "created", { origin: input.origin, tracking_mode: input.tracking_mode, due_at: input.due_at, actor: opts.actor ?? "owner" });
  if (input.source_provider && input.source_external_id) await linkSource(ownerId, row.id, { provider: input.source_provider, external_id: input.source_external_id, url: input.source_url, kind: input.origin, is_primary: true });
  await audit({ event: "obligation_created", ownerId, actor: opts.actor === "owner" ? "owner" : "system", targetId: row.id, metadata: { origin: input.origin, tracking_mode: input.tracking_mode, scope: input.scope } });
  return { row, created: true };
}

export async function patchObligation(ownerId: string, id: string, patch: Record<string, unknown>): Promise<ObligationRow | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("obligations").update(redact(patch)).eq("owner_id", ownerId).eq("id", id).select(COLUMNS).maybeSingle();
  if (error) throw new Error(`obligation_update_failed:${error.code ?? ""}:${redactString(error.message ?? "").slice(0, 120)}`);
  return data ? normalize(data as Record<string, unknown>) : null;
}

/**
 * Owner/Jeff actions. Complete ≠ dismiss ≠ cancel ≠ snooze — every transition
 * is recorded so history is never lost.
 */
export async function applyAction(ownerId: string, id: string, action: ObligationActionInput, opts: { actor?: "owner" | "jeff"; now?: Date; request?: Request } = {}): Promise<ObligationRow | null> {
  const now = opts.now ?? new Date();
  const iso = now.toISOString();
  const current = await getObligation(ownerId, id);
  if (!current) return null;
  let patch: Record<string, unknown> = {};
  let event: ObligationEventKind | null = null;
  let payload: Record<string, unknown> = { actor: opts.actor ?? "owner" };
  switch (action.action) {
    case "complete":
      patch = { status: "completed", completed_at: iso, next_reminder_at: null, completion_question: null };
      event = "completed";
      payload = { ...payload, note: action.note ?? null };
      break;
    case "confirm_complete":
      patch = { status: "completed", completed_at: iso, next_reminder_at: null, completion_question: null, completion_confidence: 1 };
      event = "confirmed";
      break;
    case "not_complete": {
      // Owner says the candidate evidence did not complete it: keep evidence for history, resume tracking.
      patch = { status: current.due_at && Date.parse(current.due_at) < now.getTime() ? "overdue" : "open", completion_question: null, completion_confidence: null, next_reminder_at: iso };
      event = "reopened";
      payload = { ...payload, reason: "owner_rejected_completion" };
      break;
    }
    case "snooze":
      patch = { status: "snoozed", snoozed_until: action.until, next_reminder_at: action.until };
      event = "snoozed";
      payload = { ...payload, until: action.until };
      break;
    case "dismiss":
      // Dismissed = stop tracking. NOT evidence that the work happened.
      patch = { status: "dismissed", dismissed_at: iso, next_reminder_at: null, completion_question: null };
      event = "dismissed";
      payload = { ...payload, note: action.note ?? null };
      break;
    case "stop_tracking":
      patch = { status: "dismissed", dismissed_at: iso, next_reminder_at: null, completion_question: null };
      event = "tracking_stopped";
      break;
    case "cancel":
      patch = { status: "cancelled", cancelled_at: iso, next_reminder_at: null, completion_question: null };
      event = "cancelled";
      payload = { ...payload, note: action.note ?? null };
      break;
    case "reopen":
      patch = { status: current.assigned_to === "other" ? "waiting_on_other" : "open", completed_at: null, dismissed_at: null, cancelled_at: null, snoozed_until: null, completion_question: null, completion_confidence: null, next_reminder_at: iso };
      event = "reopened";
      break;
    case "set_cadence":
      patch = { cadence: { ...(current.cadence ?? {}), ...action.cadence } };
      event = "cadence_changed";
      payload = { ...payload, cadence: action.cadence };
      break;
    case "set_strategy":
      patch = { completion_strategy: action.completion_strategy };
      event = "cadence_changed";
      payload = { ...payload, completion_strategy: action.completion_strategy.kind };
      break;
    case "set_tracking_mode":
      patch = { tracking_mode: action.tracking_mode };
      event = "cadence_changed";
      payload = { ...payload, tracking_mode: action.tracking_mode };
      break;
  }
  const row = await patchObligation(ownerId, id, patch);
  if (row && event) await recordEvent(ownerId, id, event, payload);
  if (row) {
    await audit({ event: "obligation_updated", ownerId, actor: opts.actor === "jeff" ? "system" : "owner", targetId: id, request: opts.request, metadata: { action: action.action, status: row.status } });
    // Mirror terminal decisions onto the originating commitment so Mission Control's
    // TODAY list (built from commitments) agrees with Follow-Through.
    const mirrored = row.status === "completed" ? "done" : row.status === "dismissed" || row.status === "cancelled" ? "dismissed" : action.action === "reopen" ? "open" : null;
    if (current.commitment_id && mirrored) {
      const admin = createAdminClient();
      await admin.from("commitments").update({ status: mirrored }).eq("owner_id", ownerId).eq("id", current.commitment_id);
    }
    // Resolve any open reminder alert for terminal states so the alert center stays honest.
    if (["completed", "dismissed", "cancelled", "snoozed"].includes(row.status)) {
      const admin = createAdminClient();
      await admin.from("alerts").update({ status: "resolved", resolved_at: iso }).eq("owner_id", ownerId).eq("kind", "obligation").eq("ref_id", id).in("status", ["open", "acknowledged", "snoozed"]);
    }
  }
  return row;
}

/** Records a detected completion with explainable evidence. */
export async function markAutoCompleted(ownerId: string, id: string, evidence: EvidenceRef[], confidence: number, now: Date): Promise<void> {
  const iso = now.toISOString();
  await patchObligation(ownerId, id, { status: "completed", completed_at: iso, completion_confidence: confidence, completion_evidence: evidence, completion_question: null, next_reminder_at: null, last_checked_at: iso });
  await recordEvent(ownerId, id, "auto_completed", { confidence, evidence: evidence.map((e) => ({ provider: e.provider, external_id: e.external_id, title: e.title, reason: e.reason })) });
  const admin = createAdminClient();
  await admin.from("alerts").update({ status: "resolved", resolved_at: iso }).eq("owner_id", ownerId).eq("kind", "obligation").eq("ref_id", id).in("status", ["open", "acknowledged", "snoozed"]);
  await audit({ event: "obligation_updated", ownerId, actor: "system", targetId: id, metadata: { action: "auto_completed", confidence } });
}

export async function markPossiblyComplete(ownerId: string, id: string, evidence: EvidenceRef[], confidence: number, question: string, now: Date): Promise<void> {
  await patchObligation(ownerId, id, { status: "possibly_complete", completion_confidence: confidence, completion_evidence: evidence, completion_question: question, last_checked_at: now.toISOString() });
  await recordEvent(ownerId, id, "possibly_complete", { confidence, question, evidence: evidence.map((e) => ({ provider: e.provider, external_id: e.external_id, title: e.title, reason: e.reason })) });
}

export interface ObligationCounts {
  live: number;
  overdue: number;
  waiting_on_me: number;
  waiting_on_other: number;
  possibly_complete: number;
  snoozed: number;
}

export function countBuckets(rows: ObligationRow[], now: Date): ObligationCounts {
  const c: ObligationCounts = { live: 0, overdue: 0, waiting_on_me: 0, waiting_on_other: 0, possibly_complete: 0, snoozed: 0 };
  for (const o of rows) {
    if (!LIVE_STATUSES.includes(o.status)) continue;
    c.live++;
    if (o.status === "snoozed" && o.snoozed_until && Date.parse(o.snoozed_until) > now.getTime()) c.snoozed++;
    else if (o.status === "possibly_complete") c.possibly_complete++;
    else if (o.assigned_to === "other" || o.status === "waiting_on_other") c.waiting_on_other++;
    else if (o.due_at && Date.parse(o.due_at) < now.getTime()) c.overdue++;
    else c.waiting_on_me++;
  }
  return c;
}
