import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { errorMessage, log } from "@/lib/security/log";
import { redact, redactString } from "@/lib/security/redact";
import { loadClientMap } from "@/lib/gomez/clients/map";
import { listObligations } from "@/lib/gomez/obligations/store";
import { listCommitments } from "@/lib/gomez/commitments/store";
import { listGoals } from "@/lib/gomez/goals/store";
import { planGroups, type GroupImportance, type GroupPlan, type GroupableAlert, type GroupableFinding, type GroupableObligation, type PlannedMember } from "./engine";
import type { EntityKind, IssueKind } from "./keys";
import type { MemberDetail, MemberItem, SummaryFacts } from "./summary";

/**
 * Grouping lifecycle (I/O). Runs after each alert run and each Follow-Through
 * run, before pushes:
 *  - one alert_groups row per group_key, one parent alert (kind "group"),
 *  - member alerts hide as `grouped` while the parent is open; member rows keep
 *    their own history and are never deleted,
 *  - counts update in place (6 → 7), the group auto-resolves when every member
 *    resolves, and reappears into the SAME group within REOPEN_DAYS.
 */

export const REOPEN_DAYS = 7;
/** Max AI interpretations per run (one call each, budget-guarded). */
export const INTERPRETATIONS_PER_RUN = 3;
/** Re-push a group when it has grown by this many members since the last push. */
export const REPUSH_GROWTH = 3;

export type GroupStatus = "open" | "acknowledged" | "snoozed" | "dismissed" | "resolved";

export interface AlertGroupRow {
  id: string;
  group_key: string;
  entity_kind: EntityKind;
  entity_id: string | null;
  entity_name: string;
  issue_kind: IssueKind;
  title: string;
  summary: string | null;
  facts: SummaryFacts;
  interpretation: string | null;
  interpretation_model: string | null;
  interpreted_at: string | null;
  interpretation_hash: string | null;
  importance: GroupImportance;
  scope: "business" | "personal" | "financial" | "all";
  status: GroupStatus;
  snoozed_until: string | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
  dismissed_at: string | null;
  reopened_count: number;
  member_count: number;
  member_hash: string | null;
  member_count_pushed: number;
  last_pushed_at: string | null;
  pushed_importance: string | null;
  alert_id: string | null;
  first_seen: string;
  last_seen: string;
  created_at: string;
  updated_at: string;
}

export interface AlertGroupMemberRow {
  id: string;
  group_id: string;
  member_kind: "alert" | "finding" | "obligation" | "commitment";
  member_id: string;
  alert_id: string | null;
  title: string;
  status: "live" | "resolved";
  key_source: "structured" | "semantic";
  detail: MemberDetail;
  added_at: string;
  resolved_at: string | null;
}

export interface AlertGroupWithMembers extends AlertGroupRow {
  members: AlertGroupMemberRow[];
}

const GROUP_COLUMNS =
  "id, group_key, entity_kind, entity_id, entity_name, issue_kind, title, summary, facts, interpretation, interpretation_model, interpreted_at, interpretation_hash, importance, scope, status, snoozed_until, acknowledged_at, resolved_at, dismissed_at, reopened_count, member_count, member_hash, member_count_pushed, last_pushed_at, pushed_importance, alert_id, first_seen, last_seen, created_at, updated_at";
const MEMBER_COLUMNS = "id, group_id, member_kind, member_id, alert_id, title, status, key_source, detail, added_at, resolved_at";

export interface GroupSyncSummary {
  groups: number;
  created: number;
  updated: number;
  reopened: number;
  resolved: number;
  membersGrouped: number;
  interpreted: number;
}

/** Portal tasks listed by an overdue-tasks finding, as member items (task, due, days overdue, owner, status, notes). */
function taskItems(rows: { title: string | null; summary: string | null; source_url: string | null; metadata: Record<string, unknown> }[], now: Date): MemberItem[] {
  const s = (v: unknown) => (typeof v === "string" && v ? v : null);
  return rows.map((r) => {
    const due = s(r.metadata.due_at);
    const days = due ? Math.floor((now.getTime() - Date.parse(due)) / 86_400_000) : null;
    return {
      title: r.title ?? "Task",
      due_at: due,
      days_overdue: days != null && days >= 0 ? days : null,
      owner: s(r.metadata.owner),
      priority: r.metadata.blocking === true ? "blocking" : s(r.metadata.category),
      status: s(r.metadata.status),
      notes: r.summary ? redactString(r.summary).slice(0, 200) : null,
      blocking: r.metadata.blocking === true,
      stage: s(r.metadata.stage_title),
      url: r.source_url,
    };
  });
}

async function loadInput(ownerId: string, now: Date) {
  const admin = createAdminClient();
  const [alertsRes, obligations, commitments, clients, goals] = await Promise.all([
    admin.from("alerts").select("id, fingerprint, kind, ref_id, category, importance, scope, status, title, summary, first_seen, last_seen, group_id").eq("owner_id", ownerId).in("status", ["open", "acknowledged", "snoozed", "grouped"]).limit(500),
    listObligations(ownerId, { live: true, limit: 300 }).catch(() => []),
    listCommitments(ownerId, { status: ["open", "overdue"], limit: 200 }).catch(() => []),
    loadClientMap(ownerId).catch(() => []),
    listGoals(ownerId, ["active"]).catch(() => []),
  ]);
  const alerts = (alertsRes.data ?? []) as unknown as GroupableAlert[];
  const findingIds = alerts.filter((a) => a.kind === "finding" && a.ref_id).map((a) => a.ref_id as string);
  let findings: GroupableFinding[] = [];
  if (findingIds.length) {
    const { data } = await admin.from("findings").select("id, category, title, goal_id, severity, metrics, observed_facts, evidence").eq("owner_id", ownerId).in("id", findingIds.slice(0, 300));
    const rows = (data ?? []) as { id: string; category: string; title: string; goal_id: string | null; severity: string; metrics: Record<string, unknown> | null; observed_facts: string[] | null; evidence: { source_item_id?: string }[] | null }[];
    // Overdue-task findings list their tasks: load the evidence rows so the group can show each task.
    const taskFindings = rows.filter((r) => r.category === "portal_task_overdue");
    const evidenceIds = [...new Set(taskFindings.flatMap((r) => (r.evidence ?? []).map((e) => e.source_item_id).filter((x): x is string => !!x)))].slice(0, 200);
    const itemsByFinding = new Map<string, MemberItem[]>();
    if (evidenceIds.length) {
      const { data: items } = await admin.from("source_items").select("id, title, summary, source_url, metadata").eq("owner_id", ownerId).in("id", evidenceIds);
      const byId = new Map((items ?? []).map((i) => [i.id as string, i as { id: string; title: string | null; summary: string | null; source_url: string | null; metadata: Record<string, unknown> }]));
      for (const f of taskFindings) {
        const rowsFor = (f.evidence ?? []).map((e) => (e.source_item_id ? byId.get(e.source_item_id) : undefined)).filter((x): x is NonNullable<typeof x> => !!x && x.metadata?.status !== "complete");
        itemsByFinding.set(f.id, taskItems(rowsFor, now).sort((a, b) => (b.days_overdue ?? -1) - (a.days_overdue ?? -1)));
      }
    }
    findings = rows.map((r) => ({ id: r.id, category: r.category, title: r.title, goal_id: r.goal_id, severity: r.severity, metrics: r.metrics ?? {}, observed_facts: r.observed_facts ?? [], items: itemsByFinding.get(r.id) ?? [] }));
  }
  const obligationInputs: GroupableObligation[] = obligations.map((o) => ({
    id: o.id,
    title: o.title,
    description: o.description,
    status: o.status,
    scope: o.scope,
    priority: o.priority,
    due_at: o.due_at,
    assigned_to: o.assigned_to,
    waiting_on: o.waiting_on,
    counterparty: o.counterparty,
    related_client_id: o.related_client_id ?? (typeof o.metadata?.client_id === "string" ? (o.metadata.client_id as string) : null),
    related_goal_id: o.related_goal_id,
    related_mission_id: o.related_mission_id,
    source_provider: o.source_provider,
    origin: o.origin,
    metadata: o.metadata ?? {},
  }));
  return {
    now,
    alerts,
    findings,
    obligations: obligationInputs,
    commitments: commitments.map((c) => ({ id: c.id, counterparty: c.counterparty, action_text: c.action_text })),
    clients: clients.map((c) => ({ portal_client_id: c.portal_client_id, name: c.name, slug: c.slug, email_domains: c.email_domains })),
    goalNames: new Map(goals.map((g) => [g.id, g.name])),
  };
}

function alertStatusForGroup(status: GroupStatus): string {
  return status; // 1:1 — the parent alert mirrors the group's lifecycle
}

function parentEvidence(members: PlannedMember[]) {
  return members.slice(0, 20).map((m) => ({ title: m.title.slice(0, 200), member_kind: m.member_kind, member_id: m.member_id, href: m.detail.href }));
}

/** Creates or updates the parent alert for a group. Returns the alert id. */
async function upsertParentAlert(ownerId: string, group: { id: string }, plan: GroupPlan, status: GroupStatus, now: Date, extra: Record<string, unknown> = {}): Promise<string | null> {
  const admin = createAdminClient();
  const fingerprint = `group:${plan.group_key}`;
  const payload = {
    kind: "group",
    ref_id: group.id,
    importance: plan.importance,
    scope: plan.scope,
    category: plan.issue_kind,
    title: plan.title.slice(0, 300),
    summary: redactString(plan.summary).slice(0, 2000),
    evidence: redact(parentEvidence(plan.members)),
    status: alertStatusForGroup(status),
    occurrences: plan.members.length,
    last_seen: now.toISOString(),
    rule_trace: redact({ base: `${plan.members.length} related signals for ${plan.entity_name}`, rules: [], settings: [], group_key: plan.group_key, entity_kind: plan.entity_kind, issue_kind: plan.issue_kind }),
    ...extra,
  };
  const { data: existing } = await admin.from("alerts").select("id").eq("owner_id", ownerId).eq("fingerprint", fingerprint).maybeSingle();
  if (existing?.id) {
    const { error } = await admin.from("alerts").update(payload).eq("id", existing.id).eq("owner_id", ownerId);
    if (error) log.warn("group_alert_update_failed", { message: error.message });
    return existing.id as string;
  }
  const { data, error } = await admin.from("alerts").insert({ owner_id: ownerId, fingerprint, first_seen: now.toISOString(), ...payload }).select("id").single();
  if (error) {
    log.warn("group_alert_insert_failed", { message: error.message });
    return null;
  }
  return (data?.id as string) ?? null;
}

async function loadGroups(ownerId: string): Promise<{ groups: AlertGroupRow[]; members: AlertGroupMemberRow[] }> {
  const admin = createAdminClient();
  const { data: groups } = await admin.from("alert_groups").select(GROUP_COLUMNS).eq("owner_id", ownerId).limit(500);
  const { data: members } = await admin.from("alert_group_members").select(MEMBER_COLUMNS).eq("owner_id", ownerId).eq("status", "live").limit(5000);
  return { groups: (groups ?? []) as unknown as AlertGroupRow[], members: (members ?? []) as unknown as AlertGroupMemberRow[] };
}

/** Next lifecycle status for an existing group given what changed this run. */
export function nextGroupStatus(g: Pick<AlertGroupRow, "status" | "snoozed_until" | "resolved_at" | "importance">, plan: Pick<GroupPlan, "importance">, changes: { added: number }, now: Date): { status: GroupStatus; reopened: boolean; fresh: boolean } {
  const RANK: Record<string, number> = { informational: 0, briefing: 1, important: 2, actionable: 2.5, urgent: 3 };
  const escalated = (RANK[plan.importance] ?? 0) > (RANK[g.importance] ?? 0);
  if (g.status === "resolved") {
    const within = g.resolved_at ? now.getTime() - Date.parse(g.resolved_at) <= REOPEN_DAYS * 86_400_000 : false;
    return { status: "open", reopened: within, fresh: !within };
  }
  if (g.status === "dismissed") return changes.added > 0 || (escalated && plan.importance === "urgent") ? { status: "open", reopened: true, fresh: false } : { status: "dismissed", reopened: false, fresh: false };
  if (g.status === "snoozed") {
    const active = g.snoozed_until ? Date.parse(g.snoozed_until) > now.getTime() : false;
    if (active && !(escalated && plan.importance === "urgent")) return { status: "snoozed", reopened: false, fresh: false };
    return { status: "open", reopened: false, fresh: false };
  }
  if (g.status === "acknowledged") return changes.added > 0 || escalated ? { status: "open", reopened: false, fresh: false } : { status: "acknowledged", reopened: false, fresh: false };
  return { status: "open", reopened: false, fresh: false };
}

export async function syncAlertGroups(ownerId: string, now = new Date()): Promise<GroupSyncSummary> {
  const admin = createAdminClient();
  const summary: GroupSyncSummary = { groups: 0, created: 0, updated: 0, reopened: 0, resolved: 0, membersGrouped: 0, interpreted: 0 };
  const input = await loadInput(ownerId, now);
  const plans = planGroups(input);
  const { groups, members } = await loadGroups(ownerId);
  const byKey = new Map(groups.map((g) => [g.group_key, g]));
  const membersByGroup = new Map<string, AlertGroupMemberRow[]>();
  for (const m of members) membersByGroup.set(m.group_id, [...(membersByGroup.get(m.group_id) ?? []), m]);
  const seenKeys = new Set<string>();
  const iso = now.toISOString();
  const toInterpret: { group: AlertGroupRow; plan: GroupPlan }[] = [];

  for (const plan of plans) {
    seenKeys.add(plan.group_key);
    const existing = byKey.get(plan.group_key);
    let groupId: string;
    let status: GroupStatus = "open";
    let liveMembers: AlertGroupMemberRow[] = [];
    const memberKey = (m: { member_kind: string; member_id: string }) => `${m.member_kind}:${m.member_id}`;
    if (!existing) {
      const { data, error } = await admin
        .from("alert_groups")
        .insert({
          owner_id: ownerId,
          group_key: plan.group_key,
          entity_kind: plan.entity_kind,
          entity_id: plan.entity_id,
          entity_name: plan.entity_name.slice(0, 200),
          issue_kind: plan.issue_kind,
          title: plan.title.slice(0, 300),
          summary: redactString(plan.summary).slice(0, 2000),
          facts: redact(plan.facts),
          importance: plan.importance,
          scope: plan.scope,
          status: "open",
          member_count: plan.members.length,
          member_hash: plan.member_hash,
          first_seen: iso,
          last_seen: iso,
        })
        .select("id")
        .single();
      if (error || !data) {
        log.warn("alert_group_insert_failed", { key: plan.group_key, message: error?.message });
        continue;
      }
      groupId = data.id as string;
      summary.created++;
      await audit({ event: "alert_group_created", ownerId, actor: "system", targetId: groupId, metadata: { entity_kind: plan.entity_kind, issue_kind: plan.issue_kind, members: plan.members.length, importance: plan.importance } });
    } else {
      groupId = existing.id;
      liveMembers = membersByGroup.get(existing.id) ?? [];
      const liveKeys = new Set(liveMembers.map(memberKey));
      const added = plan.members.filter((m) => !liveKeys.has(memberKey(m))).length;
      const next = nextGroupStatus(existing, plan, { added }, now);
      status = next.status;
      const patch: Record<string, unknown> = {
        title: plan.title.slice(0, 300),
        summary: redactString(plan.summary).slice(0, 2000),
        facts: redact(plan.facts),
        importance: plan.importance,
        scope: plan.scope,
        entity_name: plan.entity_name.slice(0, 200),
        member_count: plan.members.length,
        member_hash: plan.member_hash,
        last_seen: iso,
        status,
      };
      if (status === "open" && existing.status !== "open") Object.assign(patch, { snoozed_until: null, resolved_at: null, dismissed_at: null });
      if (next.reopened) {
        patch.reopened_count = existing.reopened_count + 1;
        summary.reopened++;
        await audit({ event: "alert_group_reopened", ownerId, actor: "system", targetId: groupId, metadata: { added, importance: plan.importance } });
      }
      if (next.fresh) Object.assign(patch, { first_seen: iso, reopened_count: 0, member_count_pushed: 0, pushed_importance: null, last_pushed_at: null, interpretation: null, interpretation_hash: null });
      const { error } = await admin.from("alert_groups").update(patch).eq("id", groupId).eq("owner_id", ownerId);
      if (error) log.warn("alert_group_update_failed", { key: plan.group_key, message: error.message });
      else summary.updated++;
    }
    summary.groups++;

    // Members: add new, refresh existing, retire the ones no longer part of the situation.
    const planKeys = new Set(plan.members.map(memberKey));
    const liveByKey = new Map(liveMembers.map((m) => [memberKey(m), m]));
    for (const m of plan.members) {
      const row = { title: m.title.slice(0, 300), alert_id: m.alert_id, key_source: m.key_source, detail: redact(m.detail), status: "live", resolved_at: null };
      const prev = liveByKey.get(memberKey(m));
      if (prev) await admin.from("alert_group_members").update(row).eq("id", prev.id).eq("owner_id", ownerId);
      else await admin.from("alert_group_members").upsert({ owner_id: ownerId, group_id: groupId, member_kind: m.member_kind, member_id: m.member_id, added_at: iso, ...row }, { onConflict: "owner_id,group_id,member_kind,member_id" });
    }
    for (const m of liveMembers) if (!planKeys.has(memberKey(m))) await admin.from("alert_group_members").update({ status: "resolved", resolved_at: iso }).eq("id", m.id).eq("owner_id", ownerId);

    // Parent alert mirrors the group; member alerts hide under it.
    const parentExtra: Record<string, unknown> = {};
    if (status === "open") Object.assign(parentExtra, { snoozed_until: null, resolved_at: null });
    const alertId = await upsertParentAlert(ownerId, { id: groupId }, plan, status, now, parentExtra);
    if (alertId && alertId !== existing?.alert_id) await admin.from("alert_groups").update({ alert_id: alertId }).eq("id", groupId).eq("owner_id", ownerId);
    const memberAlertIds = plan.members.map((m) => m.alert_id).filter((x): x is string => !!x);
    if (memberAlertIds.length) {
      const { data: hidden } = await admin.from("alerts").update({ status: "grouped", group_id: groupId }).eq("owner_id", ownerId).in("id", memberAlertIds).in("status", ["open", "acknowledged"]).select("id");
      summary.membersGrouped += hidden?.length ?? 0;
      // Members already hidden keep pointing at this group (a member can move between families).
      await admin.from("alerts").update({ group_id: groupId }).eq("owner_id", ownerId).in("id", memberAlertIds).eq("status", "grouped");
    }
    if (status === "open" && (!existing || existing.interpretation_hash !== plan.member_hash)) {
      const g = existing ?? ({ id: groupId, interpretation_hash: null, importance: plan.importance } as AlertGroupRow);
      toInterpret.push({ group: { ...g, id: groupId }, plan });
    }
  }

  // Groups whose situation cleared (fewer than two live members): resolve the group, release any remaining member.
  for (const g of groups) {
    if (seenKeys.has(g.group_key)) continue;
    if (!["open", "acknowledged", "snoozed"].includes(g.status)) continue;
    await admin.from("alert_groups").update({ status: "resolved", resolved_at: iso, last_seen: iso }).eq("id", g.id).eq("owner_id", ownerId);
    await admin.from("alert_group_members").update({ status: "resolved", resolved_at: iso }).eq("owner_id", ownerId).eq("group_id", g.id).eq("status", "live");
    if (g.alert_id) await admin.from("alerts").update({ status: "resolved", resolved_at: iso }).eq("id", g.alert_id).eq("owner_id", ownerId);
    await admin.from("alerts").update({ status: "open", group_id: null }).eq("owner_id", ownerId).eq("group_id", g.id).eq("status", "grouped");
    summary.resolved++;
    await audit({ event: "alert_group_resolved", ownerId, actor: "system", targetId: g.id, metadata: { reason: "members_resolved" } });
  }

  // One budget-guarded interpretation per changed group, most important first, bounded per run.
  const { interpretGroup } = await import("./interpret");
  const RANK: Record<string, number> = { informational: 0, briefing: 1, important: 2, actionable: 2.5, urgent: 3 };
  for (const { group, plan } of toInterpret.sort((a, b) => (RANK[b.plan.importance] ?? 0) - (RANK[a.plan.importance] ?? 0)).slice(0, INTERPRETATIONS_PER_RUN)) {
    try {
      const out = await interpretGroup(ownerId, { title: plan.title, entity_kind: plan.entity_kind, entity_name: plan.entity_name, issue_kind: plan.issue_kind, summary: plan.summary, facts: plan.facts, members: plan.members.map((m) => ({ kind: m.member_kind, title: m.title, detail: m.detail as unknown as Record<string, unknown> })) });
      if (!out.usedModel) break; // not configured / budget exhausted: stop trying this run
      if (out.result) {
        const text = [out.result.interpretation, out.result.primary_blocker ? `Primary blocker: ${out.result.primary_blocker}.` : null, out.result.suggested_action ? `First move: ${out.result.suggested_action}` : null].filter(Boolean).join(" ");
        await admin.from("alert_groups").update({ interpretation: redactString(text).slice(0, 1200), interpretation_model: out.model, interpreted_at: iso, interpretation_hash: plan.member_hash }).eq("id", group.id).eq("owner_id", ownerId);
        summary.interpreted++;
      }
    } catch (err) {
      log.warn("group_interpretation_failed", { message: errorMessage(err) });
    }
  }
  log.info("alert_groups_synced", { ...summary });
  return summary;
}

export interface GroupFilters {
  status?: GroupStatus[];
  limit?: number;
}

export async function listAlertGroups(ownerId: string, f: GroupFilters = {}): Promise<AlertGroupWithMembers[]> {
  const admin = createAdminClient();
  let q = admin.from("alert_groups").select(GROUP_COLUMNS).eq("owner_id", ownerId).order("last_seen", { ascending: false }).limit(f.limit ?? 100);
  if (f.status?.length) q = q.in("status", f.status);
  const { data, error } = await q;
  if (error) throw new Error(`alert_groups_list_failed:${error.code ?? ""}:${redactString(error.message ?? "").slice(0, 120)}`);
  const groups = (data ?? []) as unknown as AlertGroupRow[];
  if (!groups.length) return [];
  const { data: members } = await admin
    .from("alert_group_members")
    .select(MEMBER_COLUMNS)
    .eq("owner_id", ownerId)
    .in("group_id", groups.map((g) => g.id))
    .eq("status", "live")
    .order("added_at", { ascending: true })
    .limit(2000);
  const byGroup = new Map<string, AlertGroupMemberRow[]>();
  for (const m of (members ?? []) as unknown as AlertGroupMemberRow[]) byGroup.set(m.group_id, [...(byGroup.get(m.group_id) ?? []), m]);
  return groups.map((g) => ({ ...g, members: byGroup.get(g.id) ?? [] }));
}

export async function getAlertGroup(ownerId: string, id: string): Promise<AlertGroupWithMembers | null> {
  const admin = createAdminClient();
  const { data } = await admin.from("alert_groups").select(GROUP_COLUMNS).eq("owner_id", ownerId).eq("id", id).maybeSingle();
  if (!data) return null;
  const { data: members } = await admin.from("alert_group_members").select(MEMBER_COLUMNS).eq("owner_id", ownerId).eq("group_id", id).order("added_at", { ascending: true }).limit(500);
  return { ...(data as unknown as AlertGroupRow), members: ((members ?? []) as unknown as AlertGroupMemberRow[]).filter((m) => m.status === "live") };
}

export type GroupAction = { action: "acknowledge" } | { action: "snooze"; until: string } | { action: "dismiss" } | { action: "reopen" };

/** Owner lifecycle actions on a group: the parent alert and (for dismiss) the member alerts follow. Member records are never deleted. */
export async function updateAlertGroup(ownerId: string, id: string, action: GroupAction, now = new Date()): Promise<AlertGroupWithMembers | null> {
  const admin = createAdminClient();
  const iso = now.toISOString();
  const current = await getAlertGroup(ownerId, id);
  if (!current) return null;
  const patch: Record<string, unknown> =
    action.action === "acknowledge"
      ? { status: "acknowledged", acknowledged_at: iso }
      : action.action === "snooze"
        ? { status: "snoozed", snoozed_until: action.until }
        : action.action === "dismiss"
          ? { status: "dismissed", dismissed_at: iso }
          : { status: "open", snoozed_until: null, resolved_at: null, dismissed_at: null };
  const { error } = await admin.from("alert_groups").update(patch).eq("owner_id", ownerId).eq("id", id);
  if (error) throw new Error(`alert_group_update_failed:${error.code ?? ""}:${redactString(error.message ?? "").slice(0, 120)}`);
  if (current.alert_id) {
    const alertPatch: Record<string, unknown> =
      action.action === "acknowledge" ? { status: "acknowledged", acknowledged_at: iso } : action.action === "snooze" ? { status: "snoozed", snoozed_until: action.until } : action.action === "dismiss" ? { status: "dismissed" } : { status: "open", snoozed_until: null, resolved_at: null };
    await admin.from("alerts").update(alertPatch).eq("owner_id", ownerId).eq("id", current.alert_id);
  }
  // Dismissing the situation dismisses the hidden member alerts too (they would otherwise pop back individually).
  if (action.action === "dismiss") await admin.from("alerts").update({ status: "dismissed" }).eq("owner_id", ownerId).eq("group_id", id).eq("status", "grouped");
  if (action.action === "reopen") await admin.from("alerts").update({ status: "grouped" }).eq("owner_id", ownerId).eq("group_id", id).eq("status", "dismissed");
  return getAlertGroup(ownerId, id);
}

/** Drafts a sandbox mission for a group (nothing is sent; the owner approves under Missions). */
export async function draftGroupMission(ownerId: string, group: AlertGroupWithMembers, kind: "remind_client" | "prepare_action"): Promise<{ id: string; code: string; title: string } | null> {
  const admin = createAdminClient();
  const items = group.members
    .slice(0, 12)
    .map((m) => {
      const d = m.detail;
      const bits = [d.days_overdue != null ? `${d.days_overdue}d overdue` : d.due_at ? `due ${d.due_at.slice(0, 10)}` : null, d.owner ? `owner ${d.owner}` : null, d.status ?? null].filter(Boolean).join(", ");
      return `- ${m.title}${bits ? ` (${bits})` : ""}`;
    })
    .join("\n");
  const title = kind === "remind_client" ? `Draft reminder for ${group.entity_name}` : `Prepare action: ${group.title}`;
  const goal =
    kind === "remind_client"
      ? `Draft (do NOT send) a short, friendly reminder to ${group.entity_name} listing exactly what is waiting on them and why it matters for their timeline.\n\nSituation: ${group.title}\n${group.summary ?? ""}\n\nItems:\n${items}\n\nOutput the draft message only; sending is a production action that requires approval.`
      : `Prepare the most useful next action for this situation in the sandbox; no production effects.\n\nSituation: ${group.title}\n${group.summary ?? ""}${group.interpretation ? `\n\nGomez's read: ${group.interpretation}` : ""}\n\nItems:\n${items}`;
  const { count } = await admin.from("missions").select("id", { count: "exact", head: true }).eq("owner_id", ownerId);
  const code = `M-${String((count ?? 0) + 1).padStart(4, "0")}`;
  const { data, error } = await admin
    .from("missions")
    .insert({ owner_id: ownerId, code, title: title.slice(0, 120), goal: redactString(goal).slice(0, 4000), status: "draft", worker: "claude", target: { alert_group_id: group.id }, environment: "sandbox" })
    .select("id, code, title")
    .single();
  if (error || !data) {
    log.warn("group_mission_draft_failed", { message: error?.message });
    return null;
  }
  await audit({ event: "mission_created", ownerId, actor: "owner", targetId: data.id as string, metadata: { code, source: "alert_group", kind, group_id: group.id } });
  return data as { id: string; code: string; title: string };
}

/** obligation id → open group (for Mission Control / brain collapsing). */
export async function groupMembershipForObligations(ownerId: string): Promise<Map<string, { group_id: string; title: string; importance: GroupImportance; member_count: number; status: GroupStatus }>> {
  const out = new Map<string, { group_id: string; title: string; importance: GroupImportance; member_count: number; status: GroupStatus }>();
  try {
    const groups = await listAlertGroups(ownerId, { status: ["open", "acknowledged"], limit: 100 });
    for (const g of groups) for (const m of g.members) if (m.member_kind === "obligation") out.set(m.member_id, { group_id: g.id, title: g.title, importance: g.importance, member_count: g.member_count, status: g.status });
  } catch (err) {
    log.warn("group_membership_failed", { message: errorMessage(err) });
  }
  return out;
}
