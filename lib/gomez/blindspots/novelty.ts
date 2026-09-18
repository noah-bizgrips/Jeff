import type { BlindSpotCandidate, BlindSpotSubtype } from "./types";

/**
 * Novelty (spec §47) and ranking (§51) for "Find what I'm missing". Pure.
 *
 * A blind spot is only worth surfacing when it is not already visible to the
 * owner somewhere else: an active finding from any job, an open alert, a
 * mission, a goal warning, an open obligation, or a recent briefing item.
 * Repeats are allowed only for the §47 exceptions (severity change, new
 * evidence, worsened, urgent deadline, ignored recommendation with a
 * consequence), and every verdict is recorded in `metrics.novelty`.
 */

export type KnownKind = "finding" | "alert" | "mission" | "goal_warning" | "obligation" | "briefing_item";

export interface KnownItem {
  kind: KnownKind;
  id: string;
  title: string;
  /** Stable reference (client id, goal id, obligation id …) when the source has one. */
  ref?: string | null;
  category?: string | null;
  status?: string | null;
  evidence_ids?: string[];
}

export interface PriorBlindSpot {
  fingerprint: string;
  status: string;
  severity: string;
  metrics: Record<string, unknown>;
  evidence_ids: string[];
  updated_at: string | null;
  /** Latest owner feedback verdict on the previous surfacing (finding_feedback), when recorded. */
  feedback?: string | null;
}

export type RepeatException = "severity_changed" | "new_evidence" | "worsened" | "urgent_deadline" | "ignored_recommendation";

export interface NoveltyVerdict {
  novel: boolean;
  /** 0..1 multiplier used by ranking. */
  score: number;
  reason: string;
  overlaps: { kind: KnownKind; id: string; title: string }[];
  exception: RepeatException | null;
  /** True when the same fingerprint was surfaced before (any status). */
  repeat: boolean;
}

export interface NoveltyInputs {
  known: KnownItem[];
  prior: Map<string, PriorBlindSpot>;
}

/** §48 themes: what kind of blind spot each detector surfaces. */
export type BlindSpotTheme = "contradiction" | "neglect" | "anomaly" | "opportunity" | "risk" | "stale_decision" | "behavior_vs_intention" | "unresolved_obligation";

export const THEME_OF: Record<BlindSpotSubtype, BlindSpotTheme> = {
  unseen_findings: "neglect",
  quiet_client: "neglect",
  source_volume_drop: "anomaly",
  stale_connection: "risk",
  untracked_drift: "stale_decision",
  cross_source_contradiction: "contradiction",
  unanswered_owed_to_me: "unresolved_obligation",
  neglected_goal: "behavior_vs_intention",
  unresolved_costly_obligation: "unresolved_obligation",
  referral_source_declining: "neglect",
  ai_observation: "opportunity",
};

export const THEME_LABEL: Record<BlindSpotTheme, string> = {
  contradiction: "Contradiction",
  neglect: "Neglect",
  anomaly: "Anomaly",
  opportunity: "Opportunity",
  risk: "Risk",
  stale_decision: "Stale decision",
  behavior_vs_intention: "Behavior vs intention",
  unresolved_obligation: "Unresolved obligation",
};

const STOP = new Set(["the", "and", "for", "with", "from", "that", "this", "have", "has", "been", "your", "you", "are", "not", "but", "into", "over", "than", "then", "days", "day", "since", "last", "week", "weeks", "month", "months", "about", "after", "before", "still", "just", "more", "less", "some", "there", "their", "them", "they", "what", "when", "which", "while", "will", "were", "was", "its", "our", "out", "who", "yet", "gone", "quiet", "new", "one", "two", "three"]);

/** Significant lower-case words of a title (≥ 3 chars, not stop-words, numbers dropped). */
export function titleTokens(title: string): Set<string> {
  const out = new Set<string>();
  for (const w of title.toLowerCase().replace(/[^a-z0-9$ ]+/g, " ").split(/\s+/)) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w) || /^\$?\d/.test(w)) continue;
    out.add(w.replace(/(ing|ed|es|s)$/, ""));
  }
  return out;
}

export function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / Math.min(a.size, b.size);
}

export const OVERLAP_THRESHOLD = 0.6;
export const WORSEN_PCT = 25;
export const URGENT_DAYS = 3;

const WORSEN_KEY = /(days|overdue|count|pct|drop|failures|reminders|minor|amount)/i;
const WORSEN_IGNORE = /(threshold|window|lookback|formula|expected|cadence|rank|novelty)/i;

/** Numeric metrics that got materially worse (≥ WORSEN_PCT larger) since the previous surfacing. */
export function worsenedKeys(current: Record<string, unknown>, previous: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(current)) {
    if (typeof v !== "number" || !WORSEN_KEY.test(k) || WORSEN_IGNORE.test(k)) continue;
    const p = previous[k];
    if (typeof p !== "number") continue;
    const cur = Math.abs(v);
    const prev = Math.abs(p);
    if (cur - prev >= 1 && (prev === 0 || ((cur - prev) / prev) * 100 >= WORSEN_PCT)) out.push(k);
  }
  return out;
}

export function daysUntil(metrics: Record<string, unknown>, now: Date): number | null {
  if (typeof metrics.days_until === "number") return metrics.days_until;
  const due = typeof metrics.due_at === "string" ? Date.parse(metrics.due_at) : typeof metrics.expected_on === "string" ? Date.parse(metrics.expected_on) : NaN;
  if (!Number.isFinite(due)) return null;
  return Math.round((due - now.getTime()) / 86_400_000);
}

/** Feedback verdicts that mean "I saw it and set it aside". */
export const SET_ASIDE_VERDICTS = new Set(["not_useful", "wrong", "too_noisy", "dont_show", "already_knew", "dismissed", "snoozed"]);

const ACTIVE_STATUS = new Set(["open", "new", "reviewing", "accepted", "acknowledged", "action_planned", "action_in_progress", "monitoring", "snoozed"]);

/** Items already in front of the owner that say the same thing as this candidate. */
export function findOverlaps(c: BlindSpotCandidate, known: KnownItem[]): KnownItem[] {
  const tokens = titleTokens(c.title);
  const evidence = new Set(c.evidence.map((e) => e.source_item_id).filter(Boolean));
  const out: KnownItem[] = [];
  for (const k of known) {
    if (k.status && !ACTIVE_STATUS.has(k.status) && k.kind !== "briefing_item" && k.kind !== "mission") continue;
    if (k.category === "blind_spot") continue;
    const byRef = !!c.ref && !!k.ref && k.ref === c.ref;
    const byEvidence = !!k.evidence_ids?.length && k.evidence_ids.some((id) => evidence.has(id));
    const byTitle = tokenOverlap(tokens, titleTokens(k.title)) >= OVERLAP_THRESHOLD;
    if (byRef || byEvidence || byTitle) out.push(k);
  }
  return out;
}

export function assessNovelty(c: BlindSpotCandidate, severity: string, inputs: NoveltyInputs, now: Date): NoveltyVerdict {
  const overlaps = findOverlaps(c, inputs.known).map((k) => ({ kind: k.kind, id: k.id, title: k.title.slice(0, 120) }));
  const prior = inputs.prior.get(c.fingerprint) ?? null;
  const repeat = !!prior;
  const due = daysUntil(c.metrics, now);
  const urgent = due != null && due <= URGENT_DAYS;

  // Repeat exceptions (§47) are evaluated against the previous surfacing.
  let exception: RepeatException | null = null;
  if (prior) {
    const worsened = worsenedKeys(c.metrics, prior.metrics);
    const newEvidence = c.evidence.some((e) => e.source_item_id && !prior.evidence_ids.includes(e.source_item_id));
    const setAside = SET_ASIDE_VERDICTS.has(prior.feedback ?? "") || prior.status === "dismissed" || prior.status === "snoozed";
    const ignored = setAside && (worsened.length > 0 || (typeof c.metrics.consequence_minor === "number" && c.metrics.consequence_minor > 0));
    if (ignored) exception = "ignored_recommendation";
    else if (prior.severity !== severity) exception = "severity_changed";
    else if (worsened.length) exception = "worsened";
    else if (urgent && daysUntil(prior.metrics, now) !== due) exception = "urgent_deadline";
    else if (newEvidence) exception = "new_evidence";
  }

  if (prior && prior.status === "resolved" && !exception) {
    return { novel: true, score: 0.9, reason: "Surfaced before, resolved, and it is back.", overlaps, exception: null, repeat };
  }
  if (prior && !exception) {
    const dismissed = prior.status === "dismissed" || SET_ASIDE_VERDICTS.has(prior.feedback ?? "");
    return { novel: false, score: dismissed ? 0 : 0.35, reason: dismissed ? "You dismissed this before and nothing has changed." : "Already surfaced; nothing has changed since.", overlaps, exception: null, repeat };
  }
  if (prior && exception) {
    const reason: Record<RepeatException, string> = {
      severity_changed: `Severity changed from ${prior.severity} to ${severity}.`,
      new_evidence: "New evidence since it was last surfaced.",
      worsened: `Worse than last time (${worsenedKeys(c.metrics, prior.metrics).join(", ")}).`,
      urgent_deadline: `Deadline within ${URGENT_DAYS} days.`,
      ignored_recommendation: "You set this aside and the consequence is now materialising.",
    };
    return { novel: true, score: exception === "ignored_recommendation" ? 1 : 0.85, reason: reason[exception], overlaps, exception, repeat };
  }
  // First time for this fingerprint: novel unless another surface already says it.
  if (overlaps.length) {
    if (urgent) return { novel: true, score: 0.7, reason: `Already visible as ${overlaps[0]!.kind.replace(/_/g, " ")} "${overlaps[0]!.title}", but the deadline is within ${URGENT_DAYS} days.`, overlaps, exception: "urgent_deadline", repeat };
    return { novel: false, score: 0.15, reason: `Already visible as ${overlaps[0]!.kind.replace(/_/g, " ")}: "${overlaps[0]!.title}".`, overlaps, exception: null, repeat };
  }
  return { novel: true, score: 1, reason: "Not surfaced anywhere else.", overlaps, exception: null, repeat };
}

/* ------------------------------------------------------------------ */
/* Ranking (§51)                                                        */
/* ------------------------------------------------------------------ */

export interface RankFactors {
  novelty?: number;
  /** True when the candidate is tied to an active goal. */
  goalRelevant?: boolean;
  /** Multiplier from operating rules (set_severity/escalate → >1, set_importance informational → <1). */
  ruleBoost?: number;
}

export const IMPACT_WEIGHT: Record<BlindSpotCandidate["impact"], number> = { financial: 1.0, client: 0.9, data: 0.8, operational: 0.7 };

export function urgencyFactor(metrics: Record<string, unknown>, now: Date): number {
  if (typeof metrics.overdue_days === "number" && metrics.overdue_days > 0) return 1;
  const due = daysUntil(metrics, now);
  if (due == null) return 0.8;
  if (due <= URGENT_DAYS) return 1;
  if (due <= 7) return 0.95;
  if (due <= 14) return 0.9;
  return 0.8;
}

export function financialExposure(c: BlindSpotCandidate): number {
  const keys = ["amount_minor", "exposure_minor", "annualised_minor", "monthly_minor", "current_30d", "next_charge_minor", "consequence_minor"];
  let max = 0;
  for (const k of keys) {
    const v = c.metrics[k];
    if (typeof v === "number" && (k !== "current_30d" || c.metrics.unit === "minor_units")) max = Math.max(max, Math.abs(v));
  }
  return 1 + Math.min(0.5, max / 2_000_000); // +0.5 at $10k
}

export function goalRelevance(c: BlindSpotCandidate, explicit?: boolean): number {
  if (explicit) return 1;
  if (typeof c.metrics.goal_id === "string" || c.subtype === "neglected_goal" || c.subtype === "untracked_drift") return 1;
  return 0.85;
}

/**
 * Deterministic §51 score: impact × urgency × confidence × novelty × goal
 * relevance × financial exposure × rules. Without factors it degrades to the
 * original confidence × impact ordering.
 */
export function rankScore(c: BlindSpotCandidate, now?: Date, f: RankFactors = {}): number {
  const base = c.confidence * IMPACT_WEIGHT[c.impact];
  if (!now) return Math.round(base * 1000) / 1000;
  const score = base * urgencyFactor(c.metrics, now) * (f.novelty ?? 1) * goalRelevance(c, f.goalRelevant) * financialExposure(c) * (f.ruleBoost ?? 1);
  return Math.round(score * 1000) / 1000;
}

export const EMPTY_RESULT_MESSAGE = "I didn't find anything important enough to surface.";
