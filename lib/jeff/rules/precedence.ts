import { matchesRule, specificity, type MatchSubject } from "./engine";
import type { OperatingRule, RuleAction } from "./schema";

/**
 * Precedence (spec §7): security/system policy > explicit owner rule > goal
 * rule > monitor-specific > learned preference > default. Within a class, a
 * more specific rule wins; an `include` exception with higher specificity
 * overrides a broader `exclude`.
 *
 * Security policy is not a rule row at all — Tier 3 targets are refused at
 * creation time (tiers.ts) — so it never has to compete here.
 */

export type PrecedenceClass = "system" | "owner" | "goal" | "monitor" | "preference";

export function precedenceClass(rule: Pick<OperatingRule, "created_by" | "source" | "target_monitor" | "rule_type">): PrecedenceClass {
  if (rule.created_by === "system" || rule.source === "system") return "system";
  if (rule.rule_type === "briefing_pref") return "preference";
  if (rule.created_by === "owner" && rule.source !== "feedback") return "owner";
  if (rule.target_monitor) return "monitor";
  return "preference";
}

const CLASS_RANK: Record<PrecedenceClass, number> = { system: 5, owner: 4, goal: 3, monitor: 2, preference: 1 };

export interface Decision {
  /** Final verdict for exclusion-type questions. */
  excluded: boolean;
  /** Adjustments to apply to a candidate finding (only from winning rules). */
  severity?: "info" | "low" | "medium" | "high";
  importance?: string;
  minConfidence?: number;
  suppressAlert?: boolean;
  /** Every rule that matched, most authoritative first. */
  matched: OperatingRule[];
  /** The rule that decided include/exclude, if any. */
  decidedBy: OperatingRule | null;
}

function rank(rule: OperatingRule): [number, number, number] {
  return [CLASS_RANK[precedenceClass(rule)], specificity(rule), -rule.priority];
}

export function sortByAuthority(rules: OperatingRule[]): OperatingRule[] {
  return [...rules].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < 3; i++) if (ra[i] !== rb[i]) return rb[i]! - ra[i]!;
    return a.created_at < b.created_at ? -1 : 1;
  });
}

/**
 * Evaluates all enabled rules against a subject and returns the combined
 * decision. Include/exclude: the highest-authority (class, then specificity)
 * matching rule with an include/exclude action decides. Other actions stack
 * from every matching rule (most authoritative last-write wins).
 */
export function decide(rules: OperatingRule[], subject: MatchSubject): Decision {
  const matched = sortByAuthority(rules.filter((r) => r.enabled && !r.pending_confirmation && matchesRule(r, subject)));
  const decision: Decision = { excluded: false, matched, decidedBy: null };
  const gate = matched.find((r) => r.action.type === "exclude" || r.action.type === "include");
  if (gate) {
    decision.excluded = gate.action.type === "exclude";
    decision.decidedBy = gate;
  }
  // Apply adjustments from least to most authoritative so the strongest wins.
  for (const r of [...matched].reverse()) {
    const a: RuleAction = r.action;
    if (a.type === "set_severity") decision.severity = a.severity;
    else if (a.type === "set_importance") decision.importance = a.level;
    else if (a.type === "escalate") decision.importance = a.level;
    else if (a.type === "suppress_alert") decision.suppressAlert = true;
    else if (a.type === "require_min_confidence") decision.minConfidence = Math.max(decision.minConfidence ?? 0, a.value);
  }
  return decision;
}
