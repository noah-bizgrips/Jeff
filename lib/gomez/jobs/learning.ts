import type { RuleInput } from "@/lib/gomez/rules/schema";

/**
 * Job learning (spec §64). Pure core: repeated snoozes / dismissals of the
 * same job + subtype (or of personal errands in Follow-Through) become a
 * *proposal* — a pending Tier-2 rule the owner confirms in Memory & Rules,
 * plus a one-line suggestion for Ask Gomez and the brief. Explicit owner
 * feedback (an existing enabled rule on the same target) always outranks a
 * proposal, so nothing is proposed where a rule already exists.
 */

export const LEARNING_WINDOW_DAYS = 14;
export const LEARNING_THRESHOLD = 3;

export type LearningSignalKind = "finding_set_aside" | "obligation_snoozed" | "obligation_dismissed";

export interface LearningSignal {
  kind: LearningSignalKind;
  at: string;
  /** Job slug the finding/obligation belongs to (null when unknown). */
  job_slug: string | null;
  /** Finding category, or the obligation scope ("personal" | "business" | …). */
  subtype: string;
  title: string;
  /** Feedback verdict or obligation origin, for the explanation. */
  detail?: string | null;
}

export interface LearningProposal {
  /** Stable key: job + subtype (+ kind class) — used to avoid duplicates. */
  key: string;
  job_slug: string | null;
  subtype: string;
  count: number;
  window_days: number;
  examples: string[];
  /** Pending Tier-2 rule for Memory & Rules. */
  rule: RuleInput;
  /** Tier-2 memory content (kept pending until confirmed). */
  memory: string;
  /** One-liner for Ask Gomez / the brief. */
  suggestion: string;
}

const PERSONAL_SCOPES = new Set(["personal"]);

function humanCategory(c: string): string {
  return c.replace(/_/g, " ");
}

function humanJob(slug: string | null): string {
  if (!slug) return "this job";
  if (slug === "blind-spot-scanner") return "Find what I'm missing";
  return slug.replace(/-/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/** Groups signals in the window and returns one proposal per (job, subtype) that crossed the threshold. */
export function proposeLearnings(signals: LearningSignal[], now: Date, opts: { windowDays?: number; threshold?: number } = {}): LearningProposal[] {
  const windowDays = opts.windowDays ?? LEARNING_WINDOW_DAYS;
  const threshold = opts.threshold ?? LEARNING_THRESHOLD;
  const since = now.getTime() - windowDays * 86_400_000;
  const groups = new Map<string, LearningSignal[]>();
  for (const s of signals) {
    const t = Date.parse(s.at);
    if (!Number.isFinite(t) || t < since || t > now.getTime() + 60_000) continue;
    const personalErrand = s.kind !== "finding_set_aside" && PERSONAL_SCOPES.has(s.subtype);
    const key = personalErrand ? "follow-through-watchdog:personal_errands" : `${s.job_slug ?? "unknown"}:${s.subtype}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const out: LearningProposal[] = [];
  for (const [key, list] of groups) {
    if (list.length < threshold) continue;
    const sorted = [...list].sort((a, b) => a.at.localeCompare(b.at));
    const examples = [...new Set(sorted.map((s) => s.title))].slice(0, 3);
    if (key === "follow-through-watchdog:personal_errands") {
      const snoozes = list.filter((s) => s.kind === "obligation_snoozed").length;
      out.push({
        key,
        job_slug: "follow-through-watchdog",
        subtype: "personal_errands",
        count: list.length,
        window_days: windowDays,
        examples,
        rule: {
          name: "Learned: personal errands only in the daily brief",
          description: `You snoozed or dismissed ${list.length} personal reminders in ${windowDays} days (${examples.join("; ")}). Proposed: keep personal errands in the daily brief instead of reminding through the day.`,
          rule_type: "briefing_pref",
          scope: "personal",
          target_system: "briefings",
          target_monitor: "follow_through",
          target_job: "follow-through-watchdog",
          conditions: { tags_any: ["personal"] },
          action: { type: "briefing_only" },
          priority: 150,
          enabled: false,
        },
        memory: `Prefers personal errands in the daily brief rather than reminders during the day (inferred from ${snoozes} snoozes and ${list.length - snoozes} dismissals in ${windowDays} days; unconfirmed).`,
        suggestion: `You've snoozed or dismissed ${list.length} personal reminders in ${windowDays} days — want personal errands only in the daily brief?`,
      });
      continue;
    }
    const [slug, subtype] = key.split(":") as [string, string];
    const jobSlug = slug === "unknown" ? null : slug;
    out.push({
      key,
      job_slug: jobSlug,
      subtype,
      count: list.length,
      window_days: windowDays,
      examples,
      rule: {
        name: `Learned: ${humanJob(jobSlug)} — keep "${humanCategory(subtype)}" out of alerts`,
        description: `You set aside ${list.length} "${humanCategory(subtype)}" findings in ${windowDays} days (${examples.join("; ")}). Proposed: keep them in the Findings list and the brief, not alerts. Confirm, edit, or discard.`,
        rule_type: "alert_policy",
        scope: "business",
        target_system: "alerts",
        target_monitor: subtype,
        target_job: jobSlug,
        conditions: { category: subtype },
        action: { type: "suppress_alert" },
        priority: 150,
        enabled: false,
      },
      memory: `Tends to set aside "${humanCategory(subtype)}" findings from ${humanJob(jobSlug)} (${list.length} in ${windowDays} days; unconfirmed).`,
      suggestion: `${humanJob(jobSlug)}: you've set aside ${list.length} "${humanCategory(subtype)}" findings in ${windowDays} days — should I stop alerting on those?`,
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

/** Explicit feedback outranks proposals: skip any proposal an enabled rule already covers, or that is already proposed. */
export function filterAlreadyCovered(proposals: LearningProposal[], rules: { name: string; enabled: boolean; pending_confirmation: boolean; target_monitor: string | null; target_job?: string | null; conditions: { category?: string; tags_any?: string[] } }[]): LearningProposal[] {
  return proposals.filter((p) => {
    const sameName = rules.some((r) => r.name === p.rule.name);
    if (sameName) return false;
    const explicit = rules.some((r) => r.enabled && !r.pending_confirmation && ((r.conditions.category && r.conditions.category === p.subtype) || (p.subtype === "personal_errands" && r.conditions.tags_any?.includes("personal")) || (r.target_monitor === p.subtype && (!r.target_job || r.target_job === p.job_slug))));
    return !explicit;
  });
}
