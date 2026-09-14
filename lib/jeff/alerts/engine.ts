import { baseImportance, finalizeImportance, rankOf, type RuleDecisionLite } from "./importance";
import type { Importance, OwnerSettings } from "@/lib/jeff/settings";

/**
 * Pure alert engine (spec §26–28). Turns findings, goal trajectory changes
 * and overdue commitments into alert candidates, then reconciles them
 * against existing alerts with deduplication (fingerprint), cooldown,
 * grouping and owner decisions (snooze/dismiss/acknowledge preserved).
 */

export type AlertKind = "finding" | "goal" | "commitment" | "system" | "obligation" | "group";
export type AlertStatus = "open" | "acknowledged" | "snoozed" | "dismissed" | "resolved" | "grouped";
export type Scope = "business" | "personal" | "financial" | "all";

export interface AlertCandidate {
  fingerprint: string;
  kind: AlertKind;
  ref_id: string | null;
  category: string | null;
  scope: Scope;
  title: string;
  summary: string;
  evidence: unknown[];
  importance: Importance;
  surfaced: boolean;
  deferred_until: string | null;
  trace: Record<string, unknown>;
}

export interface ExistingAlert {
  id: string;
  fingerprint: string;
  status: AlertStatus;
  importance: Importance;
  occurrences: number;
  snoozed_until: string | null;
  cooldown_until: string | null;
  resolved_at: string | null;
  last_seen: string;
}

export interface FindingInput {
  id: string;
  category: string;
  title: string;
  interpretation: string | null;
  severity: "info" | "low" | "medium" | "high";
  confidence: number | null;
  status: string;
  metrics: Record<string, unknown>;
  evidence: unknown[];
  goal_id?: string | null;
  fingerprint: string | null;
  /** Rule decision computed by the rules engine for this finding, if any. */
  rules?: RuleDecisionLite;
}

export interface GoalChangeInput {
  goal_id: string;
  name: string;
  from: string | null;
  to: string;
  reason: string | null;
  primary: string | null;
  days_remaining: number | null;
}

export interface CommitmentInput {
  id: string;
  action_text: string;
  context_text: string | null;
  due_at: string | null;
  confidence: number;
  direction: "owed_by_me" | "owed_to_me";
  counterparty: string | null;
  source_url: string | null;
}

const FINANCIAL = new Set(["failed_payment", "cashflow_change", "recurring_expense_change"]);
const URGENT_CATEGORIES = new Set(["failed_payment", "automation_failure"]);
export const GROUP_THRESHOLD = 4;
export const COOLDOWN_HOURS = 24;

function amountOf(metrics: Record<string, unknown>): number | null {
  for (const k of ["amount_minor", "total_minor", "amount_due_minor", "delta_minor", "value_minor"]) {
    const v = metrics[k];
    if (typeof v === "number" && Number.isFinite(v)) return Math.abs(v);
  }
  return null;
}

export function candidatesFromFindings(findings: FindingInput[], settings: OwnerSettings, now: Date): AlertCandidate[] {
  const active = findings.filter((f) => ["open", "new", "reviewing", "accepted", "action_planned", "action_in_progress", "monitoring"].includes(f.status));
  const byCategory = new Map<string, FindingInput[]>();
  for (const f of active) byCategory.set(f.category, [...(byCategory.get(f.category) ?? []), f]);
  const out: AlertCandidate[] = [];
  for (const [category, list] of byCategory) {
    const scope: Scope = FINANCIAL.has(category) ? "financial" : "business";
    if (list.length >= GROUP_THRESHOLD) {
      // Many findings of one kind → a single grouped alert (spec §28), never N notifications.
      const top = [...list].sort((a, b) => rankOf(importanceOf(b, settings, now).importance) - rankOf(importanceOf(a, settings, now).importance))[0]!;
      const base = importanceOf(top, settings, now);
      const total = list.reduce((s, f) => s + (amountOf(f.metrics) ?? 0), 0);
      out.push({
        fingerprint: `finding-group:${category}`,
        kind: "finding",
        ref_id: null,
        category,
        scope,
        title: `${list.length} ${categoryLabel(category)} findings`,
        summary: `${list.length} open ${categoryLabel(category)} findings${total ? ` totalling ${money(total)}` : ""}. Top: ${top.title}`,
        evidence: list.slice(0, 10).map((f) => ({ finding_id: f.id, title: f.title })),
        importance: base.importance,
        surfaced: base.surfaced,
        deferred_until: base.deferred_until,
        trace: { ...base.trace, grouped: list.length },
      });
      continue;
    }
    for (const f of list) {
      const fin = importanceOf(f, settings, now);
      out.push({
        fingerprint: `finding:${f.fingerprint ?? f.id}`,
        kind: "finding",
        ref_id: f.id,
        category,
        scope,
        title: f.title,
        summary: f.interpretation ?? "",
        evidence: f.evidence.slice(0, 6),
        importance: fin.importance,
        surfaced: fin.surfaced,
        deferred_until: fin.deferred_until,
        trace: fin.trace,
      });
    }
  }
  return out;
}

function importanceOf(f: FindingInput, settings: OwnerSettings, now: Date) {
  const base = baseImportance({
    severity: f.severity,
    confidence: f.confidence ?? 0.5,
    amount_minor: amountOf(f.metrics),
    affected_goals: f.goal_id ? 1 : 0,
    urgent: URGENT_CATEGORIES.has(f.category) && f.severity === "high",
    actionable: !!(f as { proposed_mission?: unknown }).proposed_mission,
    category: f.category,
  });
  return finalizeImportance(base, { scope: FINANCIAL.has(f.category) ? "financial" : "business", kind: "finding", rules: f.rules, settings, now });
}

const RISK_RANK: Record<string, number> = { unknown: 0, on_track: 0, slightly_at_risk: 1, at_risk: 2, severely_at_risk: 3 };

export function candidatesFromGoals(changes: GoalChangeInput[], settings: OwnerSettings, now: Date): AlertCandidate[] {
  return changes
    .filter((c) => (RISK_RANK[c.to] ?? 0) > 0 && (RISK_RANK[c.to] ?? 0) > (RISK_RANK[c.from ?? "unknown"] ?? 0))
    .map((c) => {
      const severity = c.to === "severely_at_risk" ? "high" : c.to === "at_risk" ? "medium" : "low";
      const base = baseImportance({ severity, confidence: 0.7, affected_goals: 1, urgent: c.to === "severely_at_risk" && (c.days_remaining ?? 99) <= 14 });
      const fin = finalizeImportance(base, { scope: "business", kind: "goal", settings, now });
      return {
        fingerprint: `goal:${c.goal_id}:trajectory`,
        kind: "goal" as const,
        ref_id: c.goal_id,
        category: "goal_trajectory",
        scope: "business" as const,
        title: `${c.name}: ${label(c.to)}`,
        summary: `${c.name} moved from ${label(c.from ?? "unknown")} to ${label(c.to)}${c.primary ? ` · ${c.primary}` : ""}${c.reason ? ` · ${c.reason}` : ""}${c.days_remaining != null ? ` · ${c.days_remaining} days remaining` : ""}`,
        evidence: [{ goal_id: c.goal_id }],
        importance: fin.importance,
        surfaced: fin.surfaced,
        deferred_until: fin.deferred_until,
        trace: fin.trace,
      };
    });
}

export function candidatesFromCommitments(commitments: CommitmentInput[], settings: OwnerSettings, now: Date): AlertCandidate[] {
  return commitments
    .filter((c) => c.due_at && Date.parse(c.due_at) < now.getTime())
    .map((c) => {
      const mine = c.direction === "owed_by_me";
      // Overdue promises I made are time-sensitive (important); promises owed to me surface in the brief.
      const base = baseImportance({ severity: "medium", confidence: c.confidence, urgent: mine });
      const fin = finalizeImportance(base, { scope: "business", kind: "commitment", settings, now });
      return {
        fingerprint: `commitment:${c.id}`,
        kind: "commitment" as const,
        ref_id: c.id,
        category: mine ? "commitment_owed_by_me" : "commitment_owed_to_me",
        scope: "business" as const,
        title: mine ? `Overdue: ${c.action_text}` : `${c.counterparty ?? "Someone"} is overdue: ${c.action_text}`,
        summary: c.context_text ?? c.action_text,
        evidence: c.source_url ? [{ url: c.source_url }] : [],
        importance: fin.importance,
        surfaced: fin.surfaced,
        deferred_until: fin.deferred_until,
        trace: fin.trace,
      };
    });
}

export interface ReconcileResult {
  create: AlertCandidate[];
  update: { id: string; patch: Record<string, unknown> }[];
  resolve: string[];
  skippedByCooldown: number;
}

/**
 * Reconciles candidates against existing alerts.
 * - same fingerprint & open/acknowledged/snoozed → update occurrences/last_seen (and raise importance if higher)
 * - dismissed → stays dismissed (owner decision) unless importance increased to urgent
 * - resolved within cooldown → no re-raise unless importance increased
 * - existing open alert whose candidate disappeared → resolved
 */
export function reconcileAlerts(existing: ExistingAlert[], candidates: AlertCandidate[], now: Date): ReconcileResult {
  // Reminder alerts (kind obligation) are raised/resolved by the Follow-Through watchdog, and group parents
  // (kind group) by the grouping engine — never by candidate diffing.
  existing = existing.filter((e) => !e.fingerprint.startsWith("obligation:") && !e.fingerprint.startsWith("group:"));
  const byFp = new Map(existing.map((a) => [a.fingerprint, a]));
  const seen = new Set<string>();
  const nowIso = now.toISOString();
  const result: ReconcileResult = { create: [], update: [], resolve: [], skippedByCooldown: 0 };
  for (const c of candidates) {
    if (!c.surfaced) continue;
    seen.add(c.fingerprint);
    const prev = byFp.get(c.fingerprint);
    if (!prev) {
      result.create.push(c);
      continue;
    }
    const escalated = rankOf(c.importance) > rankOf(prev.importance);
    if (prev.status === "dismissed") {
      if (c.importance === "urgent" && escalated) result.update.push({ id: prev.id, patch: { status: "open", importance: c.importance, occurrences: prev.occurrences + 1, last_seen: nowIso, title: c.title, summary: c.summary, evidence: c.evidence, rule_trace: c.trace } });
      continue;
    }
    if (prev.status === "resolved") {
      const cooldownActive = prev.cooldown_until ? Date.parse(prev.cooldown_until) > now.getTime() : false;
      if (cooldownActive && !escalated) {
        result.skippedByCooldown++;
        continue;
      }
      result.update.push({ id: prev.id, patch: { status: "open", importance: c.importance, occurrences: prev.occurrences + 1, last_seen: nowIso, resolved_at: null, cooldown_until: null, title: c.title, summary: c.summary, evidence: c.evidence, rule_trace: c.trace, deferred_until: c.deferred_until } });
      continue;
    }
    if (prev.status === "snoozed") {
      const snoozeActive = prev.snoozed_until ? Date.parse(prev.snoozed_until) > now.getTime() : false;
      const patch: Record<string, unknown> = { occurrences: prev.occurrences + 1, last_seen: nowIso, summary: c.summary, evidence: c.evidence, rule_trace: c.trace };
      if (!snoozeActive || (escalated && c.importance === "urgent")) Object.assign(patch, { status: "open", snoozed_until: null });
      if (escalated) patch.importance = c.importance;
      result.update.push({ id: prev.id, patch });
      continue;
    }
    // open / acknowledged: same condition, more occurrences — never a duplicate row.
    const patch: Record<string, unknown> = { occurrences: prev.occurrences + 1, last_seen: nowIso, summary: c.summary, evidence: c.evidence, rule_trace: c.trace };
    if (escalated) {
      patch.importance = c.importance;
      if (prev.status === "acknowledged" && c.importance === "urgent") patch.status = "open";
    }
    result.update.push({ id: prev.id, patch });
  }
  for (const a of existing) {
    if (seen.has(a.fingerprint)) continue;
    // A grouped member whose condition cleared resolves like any other; the group drops it on its next sync.
    if (["open", "acknowledged", "snoozed", "grouped"].includes(a.status)) result.resolve.push(a.id);
  }
  return result;
}

export function cooldownUntil(now: Date): string {
  return new Date(now.getTime() + COOLDOWN_HOURS * 3_600_000).toISOString();
}

export function categoryLabel(category: string): string {
  return category.replace(/_/g, " ");
}

export function label(t: string): string {
  return ({ on_track: "On track", slightly_at_risk: "Slightly at risk", at_risk: "At risk", severely_at_risk: "Severely at risk", unknown: "Not enough data" } as Record<string, string>)[t] ?? t;
}

export function money(minor: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(minor / 100);
}
