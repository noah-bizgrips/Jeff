import type { EvidenceRef, SourceRow } from "@/lib/jeff/monitors/types";
import type { AttentionRow } from "@/lib/jeff/attention/types";

/**
 * Blind spots: things the owner is NOT noticing. Detectors are pure functions
 * over a snapshot of the owner's data plus attention signals; the runner does
 * all I/O. Every candidate carries evidence, a formula-bearing metrics object,
 * and an "attention" sentence explaining why it may be unnoticed.
 */

export type BlindSpotSubtype =
  | "unseen_findings"
  | "quiet_client"
  | "source_volume_drop"
  | "stale_connection"
  | "untracked_drift"
  | "cross_source_contradiction"
  | "unanswered_owed_to_me"
  | "neglected_goal"
  | "ai_observation";

export type Impact = "financial" | "client" | "operational" | "data";

export interface BlindSpotCandidate {
  fingerprint: string;
  subtype: BlindSpotSubtype;
  title: string;
  observed_facts: string[];
  metrics: Record<string, unknown>;
  interpretation: string;
  /** Why the owner may be missing it (attention evidence). */
  attention: string;
  evidence: EvidenceRef[];
  range_start: string | null;
  range_end: string | null;
  confidence: number;
  limitations: string;
  impact: Impact;
  /** Stable reference for narrow rules ("don't show me this one again"). */
  ref: string;
}

export interface FindingLite {
  id: string;
  category: string;
  title: string;
  status: string;
  created_at: string;
}

export interface AlertLite {
  id: string;
  ref_id: string | null;
  category: string | null;
  status: string;
}

export interface GoalLite {
  id: string;
  name: string;
  status: string;
  trajectory: string | null;
  /** Metric keys the goal tracks (used to decide what is "untracked"). */
  metric_keys: string[];
  end_date: string | null;
}

export interface ClientLite {
  portal_client_id: string;
  name: string;
  slug: string | null;
  status: string | null;
  ghl_contact_id: string | null;
  email_domains: string[];
  stripe_customer_ids: string[];
  highlevel_contact_ids: string[];
  meta_page_ids: string[];
}

export interface ConnectionLite {
  id: string;
  provider: string;
  display_name: string;
  status: string;
  last_success_at: string | null;
  last_error: string | null;
  age_hours: number | null;
}

export interface CommitmentLite {
  id: string;
  action_text: string;
  context_text: string | null;
  due_at: string | null;
  direction: "owed_by_me" | "owed_to_me";
  counterparty: string | null;
  source_item_id: string | null;
  source_url: string | null;
  status: string;
}

export interface BlindSpotContext {
  now: Date;
  ownerEmail: string | null;
  sourceItems: SourceRow[];
  findings: FindingLite[];
  alerts: AlertLite[];
  goals: GoalLite[];
  clients: ClientLite[];
  connections: ConnectionLite[];
  attention: AttentionRow[];
  commitments: CommitmentLite[];
}

export interface Detector {
  id: BlindSpotSubtype;
  run(ctx: BlindSpotContext): BlindSpotCandidate[];
}

export const DAY = 86_400_000;

export function daysAgo(ctx: BlindSpotContext, days: number): number {
  return ctx.now.getTime() - days * DAY;
}

export function ts(iso: string | null | undefined): number {
  if (!iso) return NaN;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : NaN;
}

export function lastViewedAt(ctx: BlindSpotContext, kind: AttentionRow["kind"], refId?: string | null, path?: string | null): number | null {
  let latest: number | null = null;
  for (const a of ctx.attention) {
    if (a.kind !== kind) continue;
    if (refId != null && a.ref_id !== refId) continue;
    if (path != null && !(a.path ?? "").startsWith(path)) continue;
    const t = ts(a.created_at);
    if (Number.isFinite(t) && (latest == null || t > latest)) latest = t;
  }
  return latest;
}

export function evidenceOf(r: SourceRow): EvidenceRef {
  return { source_item_id: r.id, provider: r.provider, external_id: r.external_id, url: r.source_url, title: r.title };
}

export function money(minor: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(minor / 100);
}

export function pctChange(now: number, prev: number): number | null {
  if (!prev) return null;
  return Math.round(((now - prev) / prev) * 1000) / 10;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function clientIdOf(r: SourceRow): string | null {
  const v = r.metadata?.client_id;
  return typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null;
}
