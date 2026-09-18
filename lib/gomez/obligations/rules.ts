import { matchesRule } from "@/lib/gomez/rules/engine";
import { resolveMonitorId, type OperatingRule } from "@/lib/gomez/rules/schema";
import type { ObligationInput } from "./types";

/**
 * Applies owner rules to an obligation candidate BEFORE it is created or
 * reminded about. Rules target the `follow_through` monitor (or the
 * follow-through-watchdog job) and use the same deterministic matcher as the
 * monitors: subject patterns, tags (scope/origin/priority), provider, metadata.
 */

export interface RuledObligation {
  input: ObligationInput;
  excluded: boolean;
  changed: boolean;
  matched: { id: string; name: string; action: string }[];
}

export function isFollowThroughRule(r: Pick<OperatingRule, "enabled" | "pending_confirmation" | "target_job" | "target_monitor" | "conditions">): boolean {
  if (!r.enabled || r.pending_confirmation) return false;
  if (r.target_job && r.target_job !== "follow-through-watchdog") return false;
  const m = r.target_monitor ? resolveMonitorId(r.target_monitor) : null;
  if (r.target_monitor && m !== "follow_through") return false;
  if (!r.target_monitor && !r.target_job) return r.conditions.monitor ? resolveMonitorId(r.conditions.monitor) === "follow_through" : false;
  return true;
}

export function applyRulesToObligation(rules: OperatingRule[], input: ObligationInput & { people?: string[] }): RuledObligation {
  const out: ObligationInput = { ...input, cadence: { ...(input.cadence ?? {}) } };
  const matched: RuledObligation["matched"] = [];
  let excluded = false;
  let changed = false;
  const subject = {
    kind: "item" as const,
    monitor: "follow_through",
    source_type: "any",
    provider: input.source_provider ?? input.origin,
    sender: null,
    author_type: null,
    subject: input.title,
    tags: [input.scope, input.origin, input.priority, input.assigned_to === "other" ? "waiting_on_other" : "waiting_on_me", ...(input.related_client_id ? ["client"] : []), ...(input.people ?? []).map((p) => p.toLowerCase())],
    metadata: { ...input.metadata, scope: input.scope, origin: input.origin, priority: input.priority, tracking_mode: input.tracking_mode },
    amount_minor: input.completion_strategy?.match?.amount_minor ?? null,
    confidence: typeof input.metadata?.interpretation_confidence === "number" ? (input.metadata.interpretation_confidence as number) : null,
    severity: null,
    category: "obligation",
  };
  for (const r of rules) {
    if (!isFollowThroughRule(r)) continue;
    if (!matchesRule({ target_monitor: null, conditions: { ...r.conditions, monitor: undefined }, enabled: r.enabled }, subject)) continue;
    matched.push({ id: r.id, name: r.name, action: r.action.type });
    switch (r.action.type) {
      case "exclude":
      case "suppress_alert":
        excluded = true;
        break;
      case "set_tracking_mode":
        if (out.tracking_mode !== r.action.mode) changed = true;
        out.tracking_mode = r.action.mode;
        break;
      case "set_daily_cap":
        out.cadence = { ...out.cadence, daily_cap: r.action.value };
        changed = true;
        break;
      case "briefing_only":
        out.cadence = { ...out.cadence, briefing_only: true };
        changed = true;
        break;
      case "no_escalation":
        out.cadence = { ...out.cadence, no_escalation: true };
        changed = true;
        break;
      case "set_importance":
      case "escalate":
        out.priority = r.action.level === "urgent" ? "critical" : r.action.level === "important" || r.action.level === "actionable" ? "high" : out.priority;
        changed = true;
        break;
      default:
        break;
    }
  }
  return { input: out, excluded, changed, matched };
}
