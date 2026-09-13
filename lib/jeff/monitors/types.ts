/**
 * Monitor contracts. Monitors are PURE: rows in, candidate findings out.
 * The runner (index.ts) does all database I/O.
 */
export interface SourceRow {
  id: string;
  provider: string;
  capability: string | null;
  resource_type: string;
  external_id: string;
  title: string | null;
  summary: string | null;
  author: string | null;
  source_url: string | null;
  source_timestamp: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
}

export interface EvidenceRef {
  source_item_id: string;
  provider: string;
  external_id: string;
  url: string | null;
  title: string | null;
}

export type FindingCategory =
  | "relationship_quiet"
  | "relationship_promise"
  | "referral_source_declining"
  | "contact_resurfaced"
  | "important_date"
  | "time_allocation_mismatch"
  | "attention_fragmentation"
  | "personal_project_stalled"
  | "personal_renewal_due"
  | "new_recurring_charge"
  | "duplicate_tool"
  | "price_increase"
  | "unused_software"
  | "annual_renewal_upcoming"
  | "webhook_broken"
  | "repeated_error"
  | "manual_repetition"
  | "client_engagement_drop"
  | "client_missed_meeting"
  | "client_negative_signal"
  | "goal_coach"
  | "lead_followup_gap"
  | "pipeline_aging"
  | "onboarding_blocker"
  | "missed_commitment"
  | "automation_failure"
  | "failed_payment"
  | "cashflow_change"
  | "recurring_expense_change"
  | "ad_spend_change"
  | "underperforming_acquisition"
  | "portal_task_overdue"
  | "portal_stage_stalled"
  | "portal_notification_failure"
  | "lead_not_contacted"
  | "client_unpaid_invoice"
  | "client_ad_spend_no_leads"
  | "operational_bottleneck"
  | "automation_opportunity"
  | "blind_spot"
  | "client_scope_creep"
  | "goal_trajectory"
  | "obligation";

export interface CandidateFinding {
  /** Stable identity: same condition → same fingerprint across runs. */
  fingerprint: string;
  category: FindingCategory;
  title: string;
  observed_facts: string[];
  metrics: Record<string, unknown>;
  interpretation: string;
  evidence: EvidenceRef[];
  range_start: string | null;
  range_end: string | null;
  confidence: number;
  limitations: string;
  severity: "info" | "low" | "medium" | "high";
  proposed_mission: { title: string; goal: string } | null;
  /** Set when the finding is about a specific goal (stamped onto findings.goal_id). */
  goal_id?: string | null;
}

export interface MonitorContext {
  now: Date;
}

/** Lite goal for detectors that compare behaviour with intention. */
export interface GoalLite {
  id: string;
  name: string;
  scope: string;
  status: string;
  trajectory: string | null;
  /** Free-text keywords derived from the goal (name/outcome/metric keys), lowercase. */
  keywords: string[];
  primary_metric: string | null;
  constraint_key: string | null;
  recommendation: string | null;
  end_date: string | null;
  updated_at: string | null;
}

export interface MemoryLite {
  category: string;
  scope: string;
  content: string;
}

export interface ObligationLite {
  id: string;
  title: string;
  status: string;
  scope: string;
  priority: string;
  due_at: string | null;
  reminder_count: number;
  updated_at: string;
  counterparty: string | null;
  metadata: Record<string, unknown>;
}

/** Richer context for job-only detectors (owner identity, goals, memories, obligations, job config). */
export interface ExtendedContext extends MonitorContext {
  ownerEmail?: string | null;
  goals?: GoalLite[];
  memories?: MemoryLite[];
  obligations?: ObligationLite[];
  config?: Record<string, unknown>;
}

export interface Monitor {
  id: string;
  run(rows: SourceRow[], ctx: MonitorContext): CandidateFinding[];
}

export function evidenceOf(r: SourceRow): EvidenceRef {
  return { source_item_id: r.id, provider: r.provider, external_id: r.external_id, url: r.source_url, title: r.title };
}

export function daysBetween(a: Date, b: Date) {
  return Math.round(((a.getTime() - b.getTime()) / 86_400_000) * 10) / 10;
}

export function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}
