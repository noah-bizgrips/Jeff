/**
 * Brain state policy: every threshold, weight and timing the visualization
 * depends on lives here (spec §27). No component should hard-code
 * "if alerts > 3". Tune here.
 */

export type BrainMode = "watching" | "attention" | "opportunity" | "investigating" | "degraded";
export type BrainUrgency = "normal" | "important" | "urgent";
export type SourceTone = "danger" | "warning" | "opportunity" | "active" | "stale" | "neutral";

export const BRAIN_POLICY = {
  /** Attention pressure contributed by open alerts, by importance. */
  alertWeight: { urgent: 1.0, actionable: 0.65, important: 0.6, briefing: 0.0, informational: 0.0 } as Record<string, number>,
  /** Pressure from active goals by trajectory. */
  goalWeight: { severely_at_risk: 0.9, at_risk: 0.6, slightly_at_risk: 0.25, on_track: 0, unknown: 0 } as Record<string, number>,
  /** Obligations: base weight by priority; trivial items fall below the inclusion floor (§30). */
  obligationPriorityWeight: { critical: 1.0, high: 0.7, normal: 0.3, low: 0.08 } as Record<string, number>,
  obligationGoalBonus: 0.3,
  obligationClientBonus: 0.25,
  obligationMoneyBonus: 0.3,
  /** Extra pressure per overdue day, capped. */
  obligationOverduePerDay: 0.05,
  obligationOverdueCap: 0.35,
  /** Only obligations at or above this weight count as attention reasons. */
  obligationInclusionFloor: 0.45,
  /** Obligation weight at/above which the item is treated as important-level pressure. */
  obligationImportantFloor: 0.7,

  /** Finding categories/subtypes treated as opportunities (never attention). */
  opportunityCategories: ["automation_opportunity", "unused_software", "duplicate_tool", "referral_source_declining", "contact_resurfaced"] as readonly string[],
  opportunityThemes: ["opportunity", "anomaly"] as readonly string[],
  opportunitySubtypes: ["reactivation", "referral", "referral_source_declining", "unused_software", "duplicate_tool", "automation_opportunity", "opportunity"] as readonly string[],
  /** Minimum confidence for a finding to count as an opportunity signal. */
  opportunityMinConfidence: 0.5,

  /** Attention level (0–1) thresholds for the ambient state. */
  attentionImportantAt: 0.35,
  attentionUrgentAt: 0.9,
  /** Opportunity level threshold to enter the opportunity ambient state. */
  opportunityAt: 0.3,

  /** System health: a source counts as degraded when… */
  staleHours: 36,
  degradedStatuses: ["error", "reconnect_required"] as readonly string[],
  failedRunsWindowHours: 24,
  /** …and the brain shows "degraded" ambient state when health drops to/below this. */
  degradedHealthAt: 0.75,

  /** Pulse periods in ms by state (spec §10). */
  pulseMs: { quiet: 7000, watching: 5500, opportunity: 5000, attention: 3500, urgent: 2750, investigating: 2000, degraded: 5500 } as Record<string, number>,
  /** Color / glow interpolation durations (spec §25). */
  colorLerpMs: 600,
  haloLerpMs: 800,
  /** How long an "actually used" source stays illuminated after a chat answer. */
  retrievalFlashMs: 1500,
  /** One-time outward pulse when a new reason appears. */
  newReasonPulseMs: 1800,
  /** Client refresh cadence for the state. */
  refreshEveryMs: 60_000,
  refreshMinGapMs: 10_000,
} as const;

/** Palette used by the canvas for tones (matches the Jeff Black theme). */
export const BRAIN_COLORS: Record<SourceTone | "jeff" | "jeffBright" | "inactiveNode" | "inactiveEdge", string> = {
  jeff: "#4DA3FF",
  jeffBright: "#78BEFF",
  inactiveNode: "#45454D",
  inactiveEdge: "#202026",
  danger: "#E57777",
  warning: "#E4B669",
  opportunity: "#67C7D9",
  active: "#78BEFF",
  stale: "#E4B669",
  neutral: "#45454D",
};

export function pulsePeriodMs(mode: BrainMode, urgency: BrainUrgency, quiet: boolean): number {
  if (mode === "investigating") return BRAIN_POLICY.pulseMs.investigating!;
  if (mode === "attention") return urgency === "urgent" ? BRAIN_POLICY.pulseMs.urgent! : BRAIN_POLICY.pulseMs.attention!;
  if (mode === "opportunity") return BRAIN_POLICY.pulseMs.opportunity!;
  if (mode === "degraded") return BRAIN_POLICY.pulseMs.degraded!;
  return quiet ? BRAIN_POLICY.pulseMs.quiet! : BRAIN_POLICY.pulseMs.watching!;
}

/**
 * Whether the brain may animate. The OS "reduce motion" preference wins
 * unless the owner explicitly pressed play/pause in the graph controls.
 */
export function resolveMotion(prefersReducedMotion: boolean, override: boolean | null): boolean {
  return override ?? !prefersReducedMotion;
}
