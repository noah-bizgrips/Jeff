import { specificity } from "./engine";
import { resolveMonitorId, type OperatingRule, type RuleCondition } from "./schema";

/**
 * Conflict detection: two enabled rules whose conditions can overlap and whose
 * actions pull in opposite directions. Overlap is judged structurally
 * (conservatively): conditions on the same field must be compatible.
 * Resolvable conflicts (one rule strictly more specific — an intended
 * exception) are reported as `resolved_by_specificity`; equal-specificity
 * opposites are `needs_clarification`.
 */

export interface RuleConflict {
  a: { id: string; name: string };
  b: { id: string; name: string };
  kind: "resolved_by_specificity" | "needs_clarification";
  winner: { id: string; name: string } | null;
  reason: string;
}

const OPPOSITES: [string, string][] = [
  ["exclude", "include"],
  ["exclude", "escalate"],
  ["exclude", "set_importance"],
  ["suppress_alert", "escalate"],
  ["suppress_alert", "set_importance"],
];

function opposite(x: string, y: string) {
  return OPPOSITES.some(([p, q]) => (p === x && q === y) || (p === y && q === x));
}

function listsOverlap(a?: string[], b?: string[]) {
  if (!a?.length || !b?.length) return true; // unconstrained on one side
  const A = new Set(a.map((s) => s.toLowerCase()));
  return b.some((s) => A.has(s.toLowerCase()));
}

function senderOverlap(a?: string[], b?: string[]) {
  if (!a?.length || !b?.length) return true;
  const norm = (s: string) => s.toLowerCase().replace(/^\*@/, "");
  return a.some((x) => b.some((y) => norm(x) === norm(y) || norm(x).endsWith(`.${norm(y)}`) || norm(y).endsWith(`.${norm(x)}`) || norm(x).includes("@") === false && norm(y).endsWith(norm(x)) || norm(y).includes("@") === false && norm(x).endsWith(norm(y))));
}

function rangesOverlap(a: RuleCondition, b: RuleCondition) {
  const lo = Math.max(a.amount_min ?? 0, b.amount_min ?? 0);
  const hi = Math.min(a.amount_max ?? Number.MAX_SAFE_INTEGER, b.amount_max ?? Number.MAX_SAFE_INTEGER);
  return lo <= hi;
}

export function conditionsOverlap(a: RuleCondition, b: RuleCondition): boolean {
  if (a.source_type && b.source_type && a.source_type !== "any" && b.source_type !== "any" && a.source_type !== b.source_type) return false;
  if (a.provider && b.provider && a.provider !== b.provider) return false;
  if (!senderOverlap(a.sender_matches, b.sender_matches)) return false;
  if (!listsOverlap(a.sender_domain, b.sender_domain)) return false;
  if (!listsOverlap(a.author_type, b.author_type)) return false;
  if (!listsOverlap(a.tags_any, b.tags_any)) return false;
  if (a.category && b.category && a.category !== b.category) return false;
  if (!rangesOverlap(a, b)) return false;
  return true;
}

export function detectConflicts(rules: OperatingRule[]): RuleConflict[] {
  const active = rules.filter((r) => r.enabled && !r.pending_confirmation);
  const out: RuleConflict[] = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]!;
      const b = active[j]!;
      if (!opposite(a.action.type, b.action.type)) continue;
      const ma = resolveMonitorId(a.target_monitor);
      const mb = resolveMonitorId(b.target_monitor);
      if (ma && mb && ma !== mb) continue;
      if (!conditionsOverlap(a.conditions, b.conditions)) continue;
      const sa = specificity(a);
      const sb = specificity(b);
      if (sa !== sb) {
        const w = sa > sb ? a : b;
        out.push({ a: { id: a.id, name: a.name }, b: { id: b.id, name: b.name }, kind: "resolved_by_specificity", winner: { id: w.id, name: w.name }, reason: `"${w.name}" is more specific and wins where both apply.` });
      } else {
        out.push({ a: { id: a.id, name: a.name }, b: { id: b.id, name: b.name }, kind: "needs_clarification", winner: null, reason: "Both rules are equally specific and pull in opposite directions. Narrow one of them." });
      }
    }
  }
  return out;
}
