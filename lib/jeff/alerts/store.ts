import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { errorMessage, log } from "@/lib/security/log";
import { redact, redactString } from "@/lib/security/redact";
import { getSettings } from "@/lib/jeff/settings-store";
import { listRules } from "@/lib/jeff/rules/store";
import { decide } from "@/lib/jeff/rules/precedence";
import { subjectFromCandidate } from "@/lib/jeff/rules/engine";
import { latestSnapshot, listGoalEvents, listGoalMetrics, listGoals } from "@/lib/jeff/goals/store";
import { formatMetricValue, formatTarget } from "@/lib/jeff/goals/format";
import type { CandidateFinding } from "@/lib/jeff/monitors/types";
import { candidatesFromCommitments, candidatesFromFindings, candidatesFromGoals, cooldownUntil, reconcileAlerts, type AlertCandidate, type AlertKind, type AlertStatus, type CommitmentInput, type ExistingAlert, type FindingInput, type GoalChangeInput } from "./engine";
import type { Importance } from "@/lib/jeff/settings";

export interface AlertRow {
  id: string;
  fingerprint: string;
  kind: AlertKind;
  ref_id: string | null;
  importance: Importance;
  scope: "business" | "personal" | "financial" | "all";
  category: string | null;
  title: string;
  summary: string | null;
  evidence: unknown[];
  status: AlertStatus;
  snoozed_until: string | null;
  cooldown_until: string | null;
  deferred_until: string | null;
  occurrences: number;
  first_seen: string;
  last_seen: string;
  resolved_at: string | null;
  acknowledged_at: string | null;
  rule_trace: Record<string, unknown>;
  /** Set while the alert is a member of an open group (status "grouped"). */
  group_id: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS =
  "id, fingerprint, kind, ref_id, importance, scope, category, title, summary, evidence, status, snoozed_until, cooldown_until, deferred_until, occurrences, first_seen, last_seen, resolved_at, acknowledged_at, rule_trace, group_id, created_at, updated_at";

export interface AlertRunSummary {
  candidates: number;
  created: number;
  updated: number;
  resolved: number;
  skippedByCooldown: number;
  suppressedByRules: number;
}

async function loadFindingInputs(ownerId: string): Promise<FindingInput[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("findings")
    .select("id, category, title, interpretation, severity, confidence, status, metrics, evidence, goal_id, fingerprint, proposed_mission")
    .eq("owner_id", ownerId)
    .eq("is_sample", false)
    .in("status", ["open", "new", "reviewing", "accepted", "action_planned", "action_in_progress", "monitoring"])
    .limit(500);
  return (data ?? []) as unknown as FindingInput[];
}

async function loadGoalChanges(ownerId: string, now: Date): Promise<GoalChangeInput[]> {
  const goals = await listGoals(ownerId, ["active"]).catch(() => []);
  const out: GoalChangeInput[] = [];
  for (const g of goals) {
    const snap = await latestSnapshot(g.id).catch(() => null);
    if (!snap) continue;
    const events = await listGoalEvents(g.id, 10).catch(() => []);
    const change = events.find((e) => e.kind === "trajectory_changed");
    const metrics = await listGoalMetrics(g.id).catch(() => []);
    const primary = metrics.find((m) => m.is_primary) ?? metrics[0];
    const p = primary ? snap.metrics?.[primary.key] : null;
    out.push({
      goal_id: g.id,
      name: g.name,
      from: (change?.payload?.from as string | null) ?? null,
      to: snap.trajectory,
      reason: (change?.payload?.constraint as string | null) ?? snap.constraint_key,
      primary: p ? `${formatMetricValue(p)} of ${formatTarget(p)}` : null,
      days_remaining: g.end_date ? Math.max(0, Math.round((Date.parse(g.end_date) - now.getTime()) / 86_400_000)) : null,
    });
  }
  return out;
}

async function loadOverdueCommitments(ownerId: string): Promise<CommitmentInput[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("commitments")
    .select("id, action_text, context_text, due_at, confidence, direction, counterparty, source_url")
    .eq("owner_id", ownerId)
    .in("status", ["open", "overdue"])
    .not("due_at", "is", null)
    .limit(200);
  const rows = (data ?? []) as unknown as CommitmentInput[];
  if (!rows.length) return rows;
  const { data: tracked } = await admin.from("obligations").select("commitment_id").eq("owner_id", ownerId).not("commitment_id", "is", null);
  const trackedIds = new Set((tracked ?? []).map((t) => t.commitment_id as string));
  return rows.filter((c) => !trackedIds.has(c.id));
}

/** Builds all alert candidates for an owner, applying operating rules to findings first. */
export async function buildCandidates(ownerId: string, now = new Date()): Promise<{ candidates: AlertCandidate[]; suppressedByRules: number }> {
  const settings = await getSettings(ownerId);
  const [findings, goalChanges, commitments, rules] = await Promise.all([loadFindingInputs(ownerId), loadGoalChanges(ownerId, now), loadOverdueCommitments(ownerId), listRules(ownerId).catch(() => [])]);
  const alertRules = rules.filter((r) => r.enabled && !r.pending_confirmation);
  let suppressedByRules = 0;
  for (const f of findings) {
    if (!alertRules.length) break;
    const asCandidate = { fingerprint: f.fingerprint ?? f.id, category: f.category, title: f.title, evidence: f.evidence, metrics: f.metrics, confidence: f.confidence ?? 0.5, severity: f.severity } as unknown as CandidateFinding;
    const d = decide(alertRules, subjectFromCandidate(asCandidate));
    if (d.matched.length) {
      f.rules = { importance: d.importance, suppressAlert: d.suppressAlert || d.excluded, decidedBy: d.decidedBy ? { id: d.decidedBy.id, name: d.decidedBy.name } : null, matched: d.matched.map((r) => ({ id: r.id, name: r.name, action: r.action })) };
      if (d.suppressAlert || d.excluded) suppressedByRules++;
    }
  }
  const candidates = [...candidatesFromFindings(findings, settings, now), ...candidatesFromGoals(goalChanges, settings, now), ...candidatesFromCommitments(commitments, settings, now)];
  return { candidates, suppressedByRules };
}

export async function runAlertsForOwner(ownerId: string, now = new Date()): Promise<AlertRunSummary> {
  const admin = createAdminClient();
  const { candidates, suppressedByRules } = await buildCandidates(ownerId, now);
  const { data: existingRows } = await admin.from("alerts").select("id, fingerprint, status, importance, occurrences, snoozed_until, cooldown_until, resolved_at, last_seen").eq("owner_id", ownerId);
  const existing = (existingRows ?? []) as ExistingAlert[];
  const plan = reconcileAlerts(existing, candidates, now);
  let created = 0;
  let updated = 0;
  let resolved = 0;
  for (const c of plan.create) {
    const { data, error } = await admin
      .from("alerts")
      .insert({
        owner_id: ownerId,
        fingerprint: c.fingerprint,
        kind: c.kind,
        ref_id: c.ref_id,
        importance: c.importance,
        scope: c.scope,
        category: c.category,
        title: c.title.slice(0, 300),
        summary: redactString(c.summary).slice(0, 2000),
        evidence: redact(c.evidence),
        status: "open",
        deferred_until: c.deferred_until,
        rule_trace: redact(c.trace),
        first_seen: now.toISOString(),
        last_seen: now.toISOString(),
      })
      .select("id")
      .single();
    if (error) log.warn("alert_insert_failed", { fingerprint: c.fingerprint, message: error.message });
    else {
      created++;
      await audit({ event: "alert_created", ownerId, actor: "system", targetId: data?.id, metadata: { kind: c.kind, importance: c.importance, category: c.category } });
    }
  }
  for (const u of plan.update) {
    const { error } = await admin.from("alerts").update(redact(u.patch)).eq("id", u.id).eq("owner_id", ownerId);
    if (error) log.warn("alert_update_failed", { id: u.id, message: error.message });
    else updated++;
  }
  for (const id of plan.resolve) {
    const { error } = await admin.from("alerts").update({ status: "resolved", resolved_at: now.toISOString(), cooldown_until: cooldownUntil(now) }).eq("id", id).eq("owner_id", ownerId);
    if (error) log.warn("alert_resolve_failed", { id, message: error.message });
    else resolved++;
  }
  // Bundle related alerts / follow-through items into one parent per situation BEFORE pushing,
  // so the owner gets one push per group instead of one per signal.
  try {
    const { syncAlertGroups } = await import("@/lib/jeff/grouping/store");
    await syncAlertGroups(ownerId, now);
  } catch (err) {
    log.warn("alert_grouping_failed", { message: errorMessage(err) });
  }
  // Push qualifying alerts (urgent always; important outside quiet hours; once per importance level).
  try {
    const { pushPendingAlerts } = await import("@/lib/jeff/push/alerts");
    await pushPendingAlerts(ownerId, now);
  } catch (err) {
    log.warn("alert_push_run_failed", { message: err instanceof Error ? err.message : "unknown" });
  }
  log.info("alerts_run", { candidates: candidates.length, created, updated, resolved, skippedByCooldown: plan.skippedByCooldown, suppressedByRules });
  return { candidates: candidates.length, created, updated, resolved, skippedByCooldown: plan.skippedByCooldown, suppressedByRules };
}

export interface AlertFilters {
  importance?: Importance[];
  status?: AlertStatus[];
  scope?: string[];
  kind?: AlertKind[];
  category?: string[];
  limit?: number;
}

export async function listAlerts(ownerId: string, f: AlertFilters = {}): Promise<AlertRow[]> {
  const admin = createAdminClient();
  let q = admin.from("alerts").select(COLUMNS).eq("owner_id", ownerId).order("last_seen", { ascending: false }).limit(f.limit ?? 200);
  if (f.importance?.length) q = q.in("importance", f.importance);
  if (f.status?.length) q = q.in("status", f.status);
  if (f.scope?.length) q = q.in("scope", f.scope);
  if (f.kind?.length) q = q.in("kind", f.kind);
  if (f.category?.length) q = q.in("category", f.category);
  const { data, error } = await q;
  if (error) throw new Error(`alerts_list_failed:${error.code ?? ""}:${redactString(error.message ?? "").slice(0, 120)}`);
  return (data ?? []) as unknown as AlertRow[];
}

export async function getAlert(ownerId: string, id: string): Promise<AlertRow | null> {
  const admin = createAdminClient();
  const { data } = await admin.from("alerts").select(COLUMNS).eq("owner_id", ownerId).eq("id", id).maybeSingle();
  return (data as unknown as AlertRow) ?? null;
}

export type AlertAction = { action: "acknowledge" } | { action: "snooze"; until: string } | { action: "dismiss" } | { action: "resolve" } | { action: "reopen" };

export async function updateAlert(ownerId: string, id: string, action: AlertAction, now = new Date()): Promise<AlertRow | null> {
  const admin = createAdminClient();
  const patch: Record<string, unknown> =
    action.action === "acknowledge"
      ? { status: "acknowledged", acknowledged_at: now.toISOString() }
      : action.action === "snooze"
        ? { status: "snoozed", snoozed_until: action.until }
        : action.action === "dismiss"
          ? { status: "dismissed" }
          : action.action === "resolve"
            ? { status: "resolved", resolved_at: now.toISOString(), cooldown_until: cooldownUntil(now) }
            : { status: "open", snoozed_until: null, resolved_at: null };
  // A grouped member stays under its group unless the owner explicitly acts on it; only then does it leave the group.
  if (action.action !== "reopen") patch.group_id = null;
  const { data, error } = await admin.from("alerts").update(patch).eq("owner_id", ownerId).eq("id", id).select(COLUMNS).maybeSingle();
  if (error) throw new Error(`alert_update_failed:${error.code ?? ""}:${redactString(error.message ?? "").slice(0, 120)}`);
  return (data as unknown as AlertRow) ?? null;
}

/** Open alerts that should be surfaced now (not deferred by quiet hours, not snoozed). */
export async function surfacedAlerts(ownerId: string, now = new Date(), limit = 20): Promise<AlertRow[]> {
  try {
    const rows = await listAlerts(ownerId, { status: ["open", "acknowledged"], limit: 200 });
    return rows
      .filter((a) => !a.deferred_until || Date.parse(a.deferred_until) <= now.getTime())
      .sort((a, b) => importanceRank(b.importance) - importanceRank(a.importance) || b.last_seen.localeCompare(a.last_seen))
      .slice(0, limit);
  } catch (err) {
    log.warn("alerts_surface_failed", { message: errorMessage(err) });
    return [];
  }
}

function importanceRank(i: Importance): number {
  return ({ informational: 0, briefing: 1, important: 2, actionable: 2.5, urgent: 3 } as Record<Importance, number>)[i];
}
