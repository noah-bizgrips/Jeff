import { IMPORTANCE_LEVELS, inQuietHours, quietHoursEnd, type Importance, type OwnerSettings } from "@/lib/gomez/settings";

/**
 * Alert importance (spec §27): deterministic scoring from severity ×
 * confidence × business impact × urgency, then rule decisions, then owner
 * settings (minimum importance, scope toggles, quiet hours).
 *
 * Levels: informational (store only) < briefing (next report) < important
 * (notify during the day) < urgent (notify immediately) < actionable (Gomez
 * can prepare work — treated like important for delivery).
 */

export const IMPORTANCE_RANK: Record<Importance, number> = { informational: 0, briefing: 1, important: 2, urgent: 3, actionable: 2.5 };

export function rankOf(i: Importance): number {
  return IMPORTANCE_RANK[i];
}

export function atLeast(a: Importance, min: Importance): boolean {
  return rankOf(a) >= rankOf(min);
}

export function maxImportance(a: Importance, b: Importance): Importance {
  return rankOf(a) >= rankOf(b) ? a : b;
}

export interface ImportanceInput {
  severity: "info" | "low" | "medium" | "high";
  confidence: number; // 0..1
  /** Money at stake in minor units, when known. */
  amount_minor?: number | null;
  /** Number of active goals this touches. */
  affected_goals?: number;
  /** Time-sensitivity: overdue commitment, payment failing today, etc. */
  urgent?: boolean;
  /** Gomez has a concrete prepared action available. */
  actionable?: boolean;
  /** Finding category / kind; used for financial and security nudges. */
  category?: string | null;
}

const SEVERITY_SCORE: Record<ImportanceInput["severity"], number> = { info: 0.5, low: 1, medium: 2, high: 3 };

/** Raw score → importance before rules/settings. Exposed for tests. */
export function baseImportance(input: ImportanceInput): { importance: Importance; score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = SEVERITY_SCORE[input.severity];
  reasons.push(`severity ${input.severity} (${score})`);
  const conf = Math.max(0, Math.min(1, input.confidence));
  score *= 0.5 + conf / 2; // low confidence halves the weight, high confidence keeps it
  reasons.push(`confidence ${conf.toFixed(2)}`);
  const amount = input.amount_minor ?? 0;
  if (amount >= 500_000) {
    score += 1.5;
    reasons.push("≥ $5,000 at stake");
  } else if (amount >= 100_000) {
    score += 1;
    reasons.push("≥ $1,000 at stake");
  } else if (amount >= 25_000) {
    score += 0.5;
    reasons.push("≥ $250 at stake");
  }
  if (input.affected_goals) {
    score += Math.min(1, input.affected_goals * 0.5);
    reasons.push(`affects ${input.affected_goals} goal${input.affected_goals === 1 ? "" : "s"}`);
  }
  if (input.urgent) {
    score += 1;
    reasons.push("time-sensitive");
  }
  let importance: Importance;
  if (score >= 4) importance = "urgent";
  else if (score >= 2.5) importance = "important";
  else if (score >= 1.2) importance = "briefing";
  else importance = "informational";
  if (input.actionable && importance === "important") importance = "actionable";
  return { importance, score: Math.round(score * 100) / 100, reasons };
}

export interface RuleDecisionLite {
  importance?: string;
  suppressAlert?: boolean;
  decidedBy?: { id: string; name: string } | null;
  matched?: { id: string; name: string; action: { type: string } }[];
}

export interface FinalImportance {
  importance: Importance;
  /** False when a rule suppressed the alert or settings filter it out entirely. */
  surfaced: boolean;
  /** Not surfaced before this instant (quiet hours). */
  deferred_until: string | null;
  trace: { base: string; rules: string[]; settings: string[] };
}

function isImportance(v: unknown): v is Importance {
  return typeof v === "string" && (IMPORTANCE_LEVELS as readonly string[]).includes(v);
}

/**
 * Applies rule decisions then owner settings. Urgent alerts always surface
 * immediately (only rules can suppress them); everything else respects the
 * minimum importance, scope toggles and quiet hours.
 */
export function finalizeImportance(
  base: ReturnType<typeof baseImportance>,
  opts: { scope: "business" | "personal" | "financial" | "all"; kind: "finding" | "goal" | "commitment" | "system" | "obligation"; rules?: RuleDecisionLite; settings: OwnerSettings; now: Date },
): FinalImportance {
  let importance = base.importance;
  const rules: string[] = [];
  const settings: string[] = [];
  if (opts.rules?.importance && isImportance(opts.rules.importance)) {
    importance = opts.rules.importance;
    rules.push(`rule set importance → ${importance}`);
  }
  if (opts.rules?.suppressAlert) {
    rules.push(`rule suppressed alert${opts.rules.decidedBy ? ` (${opts.rules.decidedBy.name})` : ""}`);
    return { importance, surfaced: false, deferred_until: null, trace: { base: base.reasons.join(", "), rules, settings } };
  }
  const s = opts.settings;
  if (opts.scope === "business" && !s.business_notifications) settings.push("business notifications off");
  if (opts.scope === "personal" && !s.personal_notifications) settings.push("personal notifications off");
  if (opts.scope === "financial" && !s.financial_notifications) settings.push("financial notifications off");
  if (opts.kind === "goal" && !s.goal_alerts) settings.push("goal alerts off");
  if (opts.kind === "finding" && !s.opportunity_alerts && ["automation_opportunity", "operational_bottleneck"].includes(String(base.reasons[0] ?? ""))) settings.push("opportunity alerts off");
  if (settings.length && importance !== "urgent") {
    return { importance: "informational", surfaced: true, deferred_until: null, trace: { base: base.reasons.join(", "), rules, settings: [...settings, "stored as informational"] } };
  }
  let deferred: string | null = null;
  if (importance !== "urgent" && atLeast(importance, "important") && inQuietHours(opts.now, s)) {
    deferred = quietHoursEnd(opts.now, s).toISOString();
    settings.push(`quiet hours: deferred until ${deferred}`);
  }
  if (!atLeast(importance, s.alert_min_importance) && importance !== "urgent") settings.push(`below minimum importance (${s.alert_min_importance}); stored, not notified`);
  return { importance, surfaced: true, deferred_until: deferred, trace: { base: base.reasons.join(", "), rules, settings } };
}
