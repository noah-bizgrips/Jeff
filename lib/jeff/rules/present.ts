import { describeRule, MONITOR_LABELS, resolveMonitorId, type OperatingRule } from "./schema";

/** UI-facing shape of a rule: raw fields plus a plain-English summary. */
export interface PresentedRule extends OperatingRule {
  summary: string;
  target_label: string;
}

export function presentRule(r: OperatingRule): PresentedRule {
  const mid = resolveMonitorId(r.target_monitor);
  return { ...r, summary: describeRule(r), target_label: mid ? MONITOR_LABELS[mid] : "All monitors" };
}
