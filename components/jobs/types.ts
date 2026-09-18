/**
 * Client-side shapes for Gomez's Jobs — mirrors the API payloads built from
 * lib/gomez/jobs (which is server-only). Keep in sync with JobPresentation,
 * JobRunRow and JobDefinitionInterpretation.
 */
import type { CoverageEntry, JobRunRow, JobRow, NotificationPolicy, TestResult } from "@/lib/gomez/jobs/types";

export type { CoverageEntry, JobRunRow, NotificationPolicy, TestResult };

export interface JobItem extends JobRow {
  schedule_label: string;
  status_label: "ACTIVE" | "LIMITED COVERAGE" | "PAUSED" | "DRAFT" | "DISABLED" | "ERROR";
  missing_sources: string[];
  detector_labels: string[];
  looks_for: string[];
  ui_name: string;
  pending: string | null;
}

export interface JobFinding {
  id: string;
  category: string;
  severity: string;
  title: string;
  summary: string | null;
  evidence: unknown;
  status: string;
  job_id: string | null;
  job_run_id: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  /** Present for blind spots: theme (§48), novelty verdict (§47), rank (§51). */
  metrics?: { theme?: string; novelty?: { novel: boolean; reason: string; exception: string | null }; rank?: number } | null;
}

export interface RunOutcome {
  runId: string;
  mode: string;
  status: "succeeded" | "partial" | "failed";
  coverage: CoverageEntry[];
  stats: Record<string, unknown> & { candidates?: number; findings_created?: number; findings_updated?: number; findings_resolved?: number; alerts_created?: number; records_considered?: number; rules_matched?: number; duplicates_suppressed?: number };
  results: TestResult[];
  notes: string[];
  error?: string;
}

export interface Interpretation {
  name: string;
  purpose: string;
  scope: "business" | "personal" | "financial" | "all";
  schedule_type: string;
  schedule_expression: string | null;
  detectors: string[];
  sources: string[];
  would_need: string[];
  notification_policy: NotificationPolicy;
  minimum_severity: string;
  limitations: string[];
  ambiguities: { field: string; question: string; options: string[] }[];
  matches_system_job: string | null;
  safe: boolean;
  config?: Record<string, unknown>;
}

export interface TemplateItem {
  id: string;
  category: string;
  name: string;
  description: string;
  system_slug?: string;
  scaffold?: { detectors: string[]; sources: string[]; [k: string]: unknown };
  missing_sources: string[];
}

export interface DetectorItem {
  id: string;
  label: string;
  kind: string;
  sources: string[];
}

export const SOURCE_LABEL: Record<string, string> = {
  google: "Google",
  highlevel: "HighLevel",
  stripe: "Stripe",
  plaid: "Financial Accounts",
  meta: "Meta",
  slack: "Slack",
  notion: "Notion",
  github: "GitHub",
  n8n: "n8n",
  portal: "Client Portal",
};

export const STATUS_TONE: Record<JobItem["status_label"], string> = {
  ACTIVE: "ok",
  "LIMITED COVERAGE": "amber",
  PAUSED: "neutral",
  DRAFT: "neutral",
  DISABLED: "neutral",
  ERROR: "danger",
};

export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff >= 0 && diff < 60_000) return "just now";
  if (diff >= 0 && diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff >= 0 && diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export async function api<T>(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: T | null; error?: string }> {
  const res = await fetch(path, { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  return { ok: res.ok, status: res.status, data, error: data?.error };
}
