import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorMessage, log } from "@/lib/security/log";
import { redact } from "@/lib/security/redact";
import type { CandidateFinding, Monitor, SourceRow } from "./types";
import { listRules, recordRuleEvents, type RuleEventInput } from "@/lib/gomez/rules/store";
import { ensureSystemRules } from "@/lib/gomez/rules/apply";
import { decide } from "@/lib/gomez/rules/precedence";
import { subjectFromCandidate, subjectFromRow } from "@/lib/gomez/rules/engine";
import { resolveMonitorId, type OperatingRule } from "@/lib/gomez/rules/schema";
import { ClientLeadIndex } from "@/lib/gomez/clients/client-leads";
import { ownerIdentity } from "@/lib/env";
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
  opts: { ownerEmail?: string | null } = {},
): { candidates: CandidateFinding[]; errors: { monitor: string; message: string }[]; trace: RuleTrace } {
  const candidates: CandidateFinding[] = [];
  const errors: { monitor: string; message: string }[] = [];
  const trace: RuleTrace = { events: [], excludedRows: 0, candidatesSuppressed: 0 };
  const active = rules.filter((r) => r.enabled && !r.pending_confirmation);
  const seenExcluded = new Set<string>();
  // Client-lead index (portal leads ↔ CRM rows) so rules with `client_lead` can match.
  const subjectCtx = { clientLeads: ClientLeadIndex.from(rows) };
  const ctx = { now, ownerEmail: opts.ownerEmail ?? null };

  for (const m of monitors) {
    const monitorId = resolveMonitorId(m.id) ?? m.id;
    // Only rules that can affect this monitor's input.
    const relevant = active.filter((r) => !r.target_monitor || resolveMonitorId(r.target_monitor) === monitorId);
    let input = rows;
    if (relevant.some((r) => r.action.type === "exclude" || r.action.type === "include")) {
      input = rows.filter((row) => {
        const verdict = decide(relevant, subjectFromRow(row, monitorId, subjectCtx));
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
      for (const c of m.run(input, ctx)) {
        const verdict = decide(relevant, subjectFromCandidate(c, rowIndex, subjectCtx));
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


export interface PersistOptions {
  /** Tag findings with the job that produced them (also stamps goal_id from the candidate). */
  jobId?: string;
  jobRunId?: string;
  /**
   * Which existing findings may be auto-resolved when not seen this run:
   * - `categories`: any active finding in these categories (global monitor run)
   * - `jobId`: only findings tagged with this job id (job runs)
   */
  resolveScope: { categories: Set<string> } | { jobId: string };
}

export interface PersistSummary {
  created: number;
  updated: number;
  resolved: number;
  /** ids of findings touched this run (created or updated). */
  touched: string[];
}

/**
 * Upserts candidate findings keyed by fingerprint and resolves the ones whose
 * condition no longer holds (within the given scope). Owner decisions
 * (dismissed, suppressed) are preserved. Shared by the global monitor run and
 * by Gomez's Jobs.
 */
export async function persistFindings(ownerId: string, candidates: CandidateFinding[], now: Date, opts: PersistOptions): Promise<PersistSummary> {
  const admin = createAdminClient();
  let q = admin.from("findings").select("id, fingerprint, status, category, job_id").eq("owner_id", ownerId).not("fingerprint", "is", null).neq("category", "blind_spot");
  if ("jobId" in opts.resolveScope) q = q.eq("job_id", opts.resolveScope.jobId);
  const { data: scopedRows } = await q;
  // Fingerprint index across ALL findings so a job never duplicates a global finding.
  const { data: allRows } = await admin.from("findings").select("id, fingerprint, status, category").eq("owner_id", ownerId).not("fingerprint", "is", null);
  const existing = new Map<string, { id: string; status: string; category: string }>();
  for (const r of allRows ?? []) if (r.fingerprint) existing.set(r.fingerprint, { id: r.id, status: r.status, category: r.category });

  let created = 0;
  let updated = 0;
  const touched: string[] = [];
  const seen = new Set<string>();
  const nowIso = now.toISOString();
  for (const c of candidates) {
    seen.add(c.fingerprint);
    const prev = existing.get(c.fingerprint);
    const base: Record<string, unknown> = {
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
    if (opts.jobId) base.job_id = opts.jobId;
    if (opts.jobRunId) base.job_run_id = opts.jobRunId;
    if (c.goal_id) base.goal_id = c.goal_id;
    if (prev) {
      // Keep owner decisions; reopen only findings that were auto-resolved.
      const status = prev.status === "resolved" ? "open" : prev.status;
      const { error } = await admin.from("findings").update({ ...base, status }).eq("id", prev.id);
      if (error) log.warn("finding_update_failed", { fingerprint: c.fingerprint, message: error.message });
      else {
        updated++;
        touched.push(prev.id);
      }
    } else {
      const { data, error } = await admin.from("findings").insert({ ...base, owner_id: ownerId, fingerprint: c.fingerprint, status: "open" }).select("id").single();
      if (error) log.warn("finding_insert_failed", { fingerprint: c.fingerprint, message: error.message });
      else {
        created++;
        if (data?.id) touched.push(String(data.id));
      }
    }
  }

  let resolved = 0;
  for (const r of scopedRows ?? []) {
    if (!r.fingerprint || seen.has(r.fingerprint)) continue;
    if ("categories" in opts.resolveScope && !opts.resolveScope.categories.has(r.category)) continue;
    if (!["open", "new", "reviewing", "accepted", "acknowledged", "in_progress", "monitoring"].includes(r.status)) continue;
    const { error } = await admin.from("findings").update({ status: "resolved", last_seen_at: nowIso }).eq("id", r.id);
    if (!error) resolved++;
  }
  return { created, updated, resolved, touched };
}

/** Categories the global run may auto-resolve: exactly what the shared monitors emit. */
export const GLOBAL_MONITOR_CATEGORIES = new Set<string>(MONITORS.map((m) => m.id));

export async function runMonitorsForOwner(ownerId: string, now = new Date()): Promise<MonitorRunSummary> {
  const rows = await loadRows(ownerId);
  let rules: OperatingRule[] = [];
  try {
    rules = await ensureSystemRules(ownerId, await listRules(ownerId, { enabledOnly: false }));
  } catch (err) {
    log.warn("rules_load_failed", { message: errorMessage(err) });
  }
  // Job-scoped rules only apply inside their job's runs.
  const { candidates, errors, trace } = runMonitors(rows, now, MONITORS, rules.filter((r) => !r.target_job), { ownerEmail: ownerIdentity().email });
  const { created, updated, resolved } = await persistFindings(ownerId, candidates, now, { resolveScope: { categories: GLOBAL_MONITOR_CATEGORIES } });
  await recordRuleEvents(ownerId, trace.events);
  log.info("monitors_run", { rows: rows.length, candidates: candidates.length, created, updated, resolved, excludedByRules: trace.excludedRows, candidatesSuppressed: trace.candidatesSuppressed, errors: errors.length });
  return { rows: rows.length, candidates: candidates.length, created, updated, resolved, excludedByRules: trace.excludedRows, candidatesSuppressed: trace.candidatesSuppressed, errors };
}
