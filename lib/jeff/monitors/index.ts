import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorMessage, log } from "@/lib/security/log";
import { redact } from "@/lib/security/redact";
import type { CandidateFinding, Monitor, SourceRow } from "./types";
import { listRules, recordRuleEvents, type RuleEventInput } from "@/lib/jeff/rules/store";
import { ensureSystemRules } from "@/lib/jeff/rules/apply";
import { decide } from "@/lib/jeff/rules/precedence";
import { subjectFromCandidate, subjectFromRow } from "@/lib/jeff/rules/engine";
import { resolveMonitorId, type OperatingRule } from "@/lib/jeff/rules/schema";
import { leadFollowupGap } from "./lead-followup-gap";
import { pipelineAging } from "./pipeline-aging";
import { missedCommitment } from "./missed-commitment";
import { automationFailure } from "./automation-failure";
import { operationalBottleneck } from "./operational-bottleneck";
import { failedPayment } from "./failed-payment";
import { cashflowChange } from "./cashflow-change";
import { recurringExpenseChange } from "./recurring-expense-change";
import { adSpendChange } from "./ad-spend-change";
import { underperformingAcquisition } from "./underperforming-acquisition";
import { portalTaskOverdue } from "./portal-task-overdue";
import { portalStageStalled } from "./portal-stage-stalled";
import { portalNotificationFailure } from "./portal-notification-failure";
import { leadNotContacted } from "./lead-not-contacted";
import { clientUnpaidInvoice } from "./client-unpaid-invoice";
import { clientAdSpendNoLeads } from "./client-ad-spend-no-leads";

/**
 * Monitor runner. Loads the owner's live (non-sample) source_items, runs every
 * pure monitor, upserts findings keyed by fingerprint, and resolves findings
 * whose condition no longer holds. Owner-decided statuses (dismissed) are
 * preserved across runs.
 */

export const MONITORS: Monitor[] = [
  leadFollowupGap,
  pipelineAging,
  missedCommitment,
  automationFailure,
  operationalBottleneck,
  failedPayment,
  cashflowChange,
  recurringExpenseChange,
  adSpendChange,
  underperformingAcquisition,
  portalTaskOverdue,
  portalStageStalled,
  portalNotificationFailure,
  leadNotContacted,
  clientUnpaidInvoice,
  clientAdSpendNoLeads,
];

export interface MonitorRunSummary {
  rows: number;
  candidates: number;
  created: number;
  updated: number;
  resolved: number;
  /** Source rows excluded by operating rules before any monitor saw them. */
  excludedByRules: number;
  /** Candidate findings dropped/adjusted by post-detection rules. */
  candidatesSuppressed: number;
  errors: { monitor: string; message: string }[];
}

const ROW_LIMIT = 5000;
const DAY = 86_400_000;

export async function loadRows(ownerId: string): Promise<SourceRow[]> {
  const admin = createAdminClient();
  const since = new Date(Date.now() - 120 * DAY).toISOString();
  const { data, error } = await admin
    .from("source_items")
    .select("id, provider, capability, resource_type, external_id, title, summary, author, source_url, source_timestamp, tags, metadata")
    .eq("owner_id", ownerId)
    .eq("is_sample", false)
    .or(`source_timestamp.gte.${since},source_timestamp.is.null`)
    .order("source_timestamp", { ascending: false })
    .limit(ROW_LIMIT);
  if (error) throw new Error(`monitor_rows_failed:${error.code ?? ""}`);
  return (data ?? []) as SourceRow[];
}

export interface RuleTrace {
  events: RuleEventInput[];
  excludedRows: number;
  candidatesSuppressed: number;
}

/**
 * Pure: applies operating rules, then runs all monitors, isolating failures
 * per monitor. Pipeline per spec §14: rows → rules (deterministic exclusion,
 * no AI) → monitor candidate detection → post-candidate rules (severity,
 * confidence, suppression) → findings.
 */
export function runMonitors(
  rows: SourceRow[],
  now = new Date(),
  monitors: Monitor[] = MONITORS,
  rules: OperatingRule[] = [],
): { candidates: CandidateFinding[]; errors: { monitor: string; message: string }[]; trace: RuleTrace } {
  const candidates: CandidateFinding[] = [];
  const errors: { monitor: string; message: string }[] = [];
  const trace: RuleTrace = { events: [], excludedRows: 0, candidatesSuppressed: 0 };
  const active = rules.filter((r) => r.enabled && !r.pending_confirmation);
  const seenExcluded = new Set<string>();

  for (const m of monitors) {
    const monitorId = resolveMonitorId(m.id) ?? m.id;
    // Only rules that can affect this monitor's input.
    const relevant = active.filter((r) => !r.target_monitor || resolveMonitorId(r.target_monitor) === monitorId);
    let input = rows;
    if (relevant.some((r) => r.action.type === "exclude" || r.action.type === "include")) {
      input = rows.filter((row) => {
        const verdict = decide(relevant, subjectFromRow(row, monitorId));
        if (verdict.excluded && verdict.decidedBy) {
          const key = `${verdict.decidedBy.id}:${row.id}`;
          if (!seenExcluded.has(key)) {
            seenExcluded.add(key);
            trace.events.push({ ruleId: verdict.decidedBy.id, sourceItemId: row.id, monitor: monitorId, effect: "excluded", detail: row.title ?? undefined });
            trace.excludedRows++;
          }
          return false;
        }
        return true;
      });
    }
    try {
      const rowIndex = new Map(input.map((r) => [r.id, r]));
      for (const c of m.run(input, { now })) {
        const verdict = decide(relevant, subjectFromCandidate(c, rowIndex));
        if (verdict.excluded && verdict.decidedBy) {
          trace.events.push({ ruleId: verdict.decidedBy.id, monitor: monitorId, effect: "excluded", detail: c.title });
          trace.candidatesSuppressed++;
          continue;
        }
        if (verdict.minConfidence != null && c.confidence < verdict.minConfidence) {
          const r = verdict.matched.find((x) => x.action.type === "require_min_confidence");
          if (r) trace.events.push({ ruleId: r.id, monitor: monitorId, effect: "excluded", detail: `${c.title} (confidence ${c.confidence} < ${verdict.minConfidence})` });
          trace.candidatesSuppressed++;
          continue;
        }
        let adjusted = c;
        if (verdict.severity && verdict.severity !== c.severity) {
          adjusted = { ...adjusted, severity: verdict.severity };
          const r = verdict.matched.find((x) => x.action.type === "set_severity");
          if (r) trace.events.push({ ruleId: r.id, monitor: monitorId, effect: "reclassified", detail: `${c.title} → ${verdict.severity}` });
        }
        if (verdict.decidedBy?.action.type === "include") {
          trace.events.push({ ruleId: verdict.decidedBy.id, monitor: monitorId, effect: "allowed_by_exception", detail: c.title });
        }
        candidates.push(adjusted);
      }
    } catch (err) {
      errors.push({ monitor: m.id, message: errorMessage(err) });
    }
  }
  // De-duplicate by fingerprint (last one wins).
  const byFp = new Map<string, CandidateFinding>();
  for (const c of candidates) byFp.set(c.fingerprint, c);
  return { candidates: [...byFp.values()], errors, trace };
}

export async function runMonitorsForOwner(ownerId: string, now = new Date()): Promise<MonitorRunSummary> {
  const admin = createAdminClient();
  const rows = await loadRows(ownerId);
  let rules: OperatingRule[] = [];
  try {
    rules = await ensureSystemRules(ownerId, await listRules(ownerId, { enabledOnly: false }));
  } catch (err) {
    log.warn("rules_load_failed", { message: errorMessage(err) });
  }
  const { candidates, errors, trace } = runMonitors(rows, now, MONITORS, rules);

  // Blind spots are owned by lib/jeff/blindspots (its own daily lifecycle); never touch them here.
  const { data: existingRows } = await admin.from("findings").select("id, fingerprint, status").eq("owner_id", ownerId).not("fingerprint", "is", null).neq("category", "blind_spot");
  const existing = new Map<string, { id: string; status: string }>();
  for (const r of existingRows ?? []) if (r.fingerprint) existing.set(r.fingerprint, { id: r.id, status: r.status });

  let created = 0;
  let updated = 0;
  const seen = new Set<string>();
  const nowIso = now.toISOString();
  for (const c of candidates) {
    seen.add(c.fingerprint);
    const prev = existing.get(c.fingerprint);
    const base = {
      category: c.category,
      title: c.title.slice(0, 300),
      observed_facts: redact(c.observed_facts),
      metrics: redact(c.metrics),
      interpretation: c.interpretation,
      evidence: c.evidence,
      range_start: c.range_start,
      range_end: c.range_end,
      confidence: Math.max(0, Math.min(1, c.confidence)),
      limitations: c.limitations,
      severity: c.severity,
      proposed_mission: c.proposed_mission,
      last_seen_at: nowIso,
      is_sample: false,
    };
    if (prev) {
      // Keep owner decisions; reopen only findings that were auto-resolved.
      const status = prev.status === "resolved" ? "open" : prev.status;
      const { error } = await admin.from("findings").update({ ...base, status }).eq("id", prev.id);
      if (error) log.warn("finding_update_failed", { fingerprint: c.fingerprint, message: error.message });
      else updated++;
    } else {
      const { error } = await admin.from("findings").insert({ ...base, owner_id: ownerId, fingerprint: c.fingerprint, status: "open" });
      if (error) log.warn("finding_insert_failed", { fingerprint: c.fingerprint, message: error.message });
      else created++;
    }
  }

  let resolved = 0;
  for (const [fp, prev] of existing) {
    if (seen.has(fp)) continue;
    if (!["open", "new", "reviewing", "accepted", "acknowledged", "in_progress", "monitoring"].includes(prev.status)) continue;
    const { error } = await admin.from("findings").update({ status: "resolved", last_seen_at: nowIso }).eq("id", prev.id);
    if (!error) resolved++;
  }

  await recordRuleEvents(ownerId, trace.events);
  log.info("monitors_run", { rows: rows.length, candidates: candidates.length, created, updated, resolved, excludedByRules: trace.excludedRows, candidatesSuppressed: trace.candidatesSuppressed, errors: errors.length });
  return { rows: rows.length, candidates: candidates.length, created, updated, resolved, excludedByRules: trace.excludedRows, candidatesSuppressed: trace.candidatesSuppressed, errors };
}
