import { describeRule, MONITOR_LABELS, resolveMonitorId, type OperatingRule } from "./schema";

/** UI-facing shape of a rule: raw fields plus a plain-English summary. */
export interface PresentedRule extends OperatingRule {
  summary: string;
  target_label: string;
}

/** Job slug → display name, kept here (no server-only imports) so the presenter stays isomorphic. */
const JOB_NAMES: Record<string, string> = {
  "revenue-leakage-hunter": "Revenue Leakage Hunter",
  "relationship-radar": "Relationship Radar",
  "client-health-analyst": "Client Health Analyst",
  "cash-flow-watchdog": "Cash Flow Watchdog",
  "expense-creep-hunter": "Expense Creep Hunter",
  "commitment-watchdog": "Commitment Watchdog",
  "follow-through-watchdog": "Follow-Through Watchdog",
  "automation-auditor": "Automation Auditor",
  "time-allocation-auditor": "Time Allocation Auditor",
  "attention-cost-detector": "Attention Cost Detector",
  "personal-project-tracker": "Personal Project Tracker",
  "goal-coach": "Goal Coach",
  "blind-spot-scanner": "Find what I'm missing",
};

export function jobDisplayName(slug: string | null | undefined): string | null {
  if (!slug) return null;
  return JOB_NAMES[slug] ?? slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function presentRule(r: OperatingRule): PresentedRule {
  const mid = resolveMonitorId(r.target_monitor);
  const monitorLabel = mid ? MONITOR_LABELS[mid] : "All monitors";
  const job = jobDisplayName(r.target_job);
  return { ...r, summary: describeRule(r), target_label: job ? `${job} · ${monitorLabel}` : monitorLabel };
}
