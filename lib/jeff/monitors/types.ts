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
  | "lead_followup_gap"
  | "pipeline_aging"
  | "onboarding_blocker"
  | "missed_commitment"
  | "automation_failure"
  | "failed_payment"
  | "cashflow_change"
  | "recurring_expense_change"
  | "ad_spend_change"
  | "operational_bottleneck"
  | "automation_opportunity";

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
}

export interface MonitorContext {
  now: Date;
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
