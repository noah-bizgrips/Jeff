import { MONITORS } from "@/lib/jeff/monitors";
import type { CandidateFinding, Monitor, SourceRow } from "@/lib/jeff/monitors/types";
import { clientIdOf, clientIndex, DAY, groupBy, isActiveClient, str } from "@/lib/jeff/monitors/portal-shared";
import { money, num, tsOf } from "@/lib/jeff/monitors/finance-shared";
import type { DetectorContext, DetectorSpec } from "./types";
import type { ExtendedContext } from "@/lib/jeff/monitors/types";
import { contactResurfaced, importantDate, referralSourceDeclining, relationshipQuiet } from "@/lib/jeff/monitors/relationship-radar";
import { timeAllocationMismatch } from "@/lib/jeff/monitors/time-allocation";
import { attentionFragmentation } from "@/lib/jeff/monitors/attention-cost";
import { personalProjectStalled, personalRenewalDue } from "@/lib/jeff/monitors/personal-projects";
import { annualRenewalUpcoming, duplicateTool, newRecurringCharge, priceIncrease, unusedSoftware } from "@/lib/jeff/monitors/expense-creep";
import { duplicateLeadEvents, manualRepetition, repeatedError, webhookBroken } from "@/lib/jeff/monitors/automation-audit";
import { clientEngagementDrop, clientMissedMeeting, clientNegativeSignal } from "@/lib/jeff/monitors/client-health";

/**
 * Detector registry: the only way a Job may "do" anything. Wraps the existing
 * pure monitors, adds job-only custom detectors, and names the `special`
 * subsystems (goals, blind spots) the runner invokes itself.
 *
 * Extension point for run C: append DetectorSpec entries here (pure functions
 * over DetectorContext) — no other file needs to know about them.
 */

const MONITOR_SOURCES: Record<string, string[]> = {
  lead_followup_gap: ["highlevel"],
  pipeline_aging: ["highlevel"],
  missed_commitment: ["google", "highlevel", "slack"],
  automation_failure: ["n8n"],
  operational_bottleneck: ["google"],
  failed_payment: ["stripe"],
  cashflow_change: ["stripe", "plaid"],
  recurring_expense_change: ["plaid", "stripe"],
  ad_spend_change: ["meta"],
  underperforming_acquisition: ["meta"],
  portal_task_overdue: ["portal"],
  portal_stage_stalled: ["portal"],
  portal_notification_failure: ["portal"],
  lead_not_contacted: ["portal"],
  client_unpaid_invoice: ["stripe", "portal"],
  client_ad_spend_no_leads: ["meta", "portal"],
};

const MONITOR_LABELS: Record<string, string> = {
  lead_followup_gap: "Lead follow-up gaps",
  pipeline_aging: "Pipeline aging",
  missed_commitment: "Open commitments",
  automation_failure: "Automation failures",
  operational_bottleneck: "Calendar bottlenecks",
  failed_payment: "Failed / overdue payments",
  cashflow_change: "Cash-flow changes",
  recurring_expense_change: "Recurring expense changes",
  ad_spend_change: "Ad spend changes",
  underperforming_acquisition: "Underperforming acquisition",
  portal_task_overdue: "Overdue portal tasks",
  portal_stage_stalled: "Stalled onboarding stages",
  portal_notification_failure: "Client notification failures",
  lead_not_contacted: "Leads not contacted",
  client_unpaid_invoice: "Unpaid client invoices",
  client_ad_spend_no_leads: "Ad spend without leads",
};

function wrapMonitor(m: Monitor): DetectorSpec {
  return {
    id: m.id,
    label: MONITOR_LABELS[m.id] ?? m.id,
    kind: "monitor",
    sources: MONITOR_SOURCES[m.id] ?? [],
    categories: [m.id],
    run: (ctx) => m.run(ctx.rows, { now: ctx.now }),
  };
}

/* ------------------------------------------------------------------ */
/* Custom detector: client scope creep (§87 acceptance)                */
/* ------------------------------------------------------------------ */

export const SCOPE_CREEP_MIN_TASKS = 8;
export const SCOPE_CREEP_MIN_DAYS = 30;
/** Flag when a client's share of completed portal work exceeds its share of collected revenue by this many points. */
export const SCOPE_CREEP_GAP_POINTS = 25;

/**
 * Compares each client's share of BizGrips-owned portal work (completed +
 * in-progress tasks in the window, a proxy for effort) with its share of
 * Stripe revenue collected (paid invoices + succeeded charges attributed to
 * the client). Hours are not tracked anywhere, so task counts are the
 * effort proxy and the limitation says so.
 */
export function clientScopeCreep(rows: SourceRow[], now: Date, windowDays = SCOPE_CREEP_MIN_DAYS): CandidateFinding[] {
  const since = now.getTime() - windowDays * DAY;
  const idx = clientIndex(rows);
  const tasks = rows.filter((r) => r.provider === "portal" && r.resource_type === "task" && str(r.metadata.owner) !== "Client" && str(r.metadata.status) !== "not_started");
  const recentTasks = tasks.filter((r) => {
    const t = Date.parse(str(r.metadata.completed_at) ?? str(r.metadata.started_at) ?? r.source_timestamp ?? "");
    return Number.isFinite(t) && t >= since;
  });
  const revenueRows = rows.filter((r) => {
    if (r.provider !== "stripe" || !clientIdOf(r)) return false;
    const t = tsOf(r);
    if (t == null || t < since) return false;
    if (r.resource_type === "invoice") return str(r.metadata.status) === "paid";
    if (r.resource_type === "charge") return str(r.metadata.status) === "succeeded" && !r.metadata.refunded;
    return false;
  });
  const workBy = groupBy(recentTasks, clientIdOf);
  const revBy = groupBy(revenueRows, clientIdOf);
  const totalWork = recentTasks.length;
  const totalRev = revenueRows.reduce((s, r) => s + num(r.metadata.amount_paid ?? r.metadata.amount), 0);
  if (totalWork < SCOPE_CREEP_MIN_TASKS) return [];
  const currency = str(revenueRows[0]?.metadata.currency)?.toUpperCase() ?? "USD";
  const out: CandidateFinding[] = [];
  for (const [clientId, work] of workBy) {
    if (clientId === "unknown" || !isActiveClient(idx, clientId)) continue;
    const rev = (revBy.get(clientId) ?? []).reduce((s, r) => s + num(r.metadata.amount_paid ?? r.metadata.amount), 0);
    const workShare = (work.length / totalWork) * 100;
    const revShare = totalRev > 0 ? (rev / totalRev) * 100 : 0;
    const gap = workShare - revShare;
    if (work.length < 3 || gap < SCOPE_CREEP_GAP_POINTS) continue;
    const name = idx.get(clientId)?.name ?? `Client ${clientId}`;
    const evidence = [...work.slice(0, 6), ...(revBy.get(clientId) ?? []).slice(0, 3)].map((r) => ({ source_item_id: r.id, provider: r.provider, external_id: r.external_id, url: r.source_url, title: r.title }));
    out.push({
      fingerprint: `client_scope_creep:${clientId}`,
      category: "client_scope_creep",
      title: `${name}: ${Math.round(workShare)}% of BizGrips work vs ${Math.round(revShare)}% of revenue (last ${windowDays}d)`,
      observed_facts: [
        `${work.length} of ${totalWork} BizGrips-owned portal tasks worked in the last ${windowDays} days belong to ${name}.`,
        totalRev > 0 ? `${money(rev, currency)} of ${money(totalRev, currency)} collected in Stripe in the same window is attributed to ${name}.` : `No Stripe revenue attributed to any client in the window.`,
      ],
      metrics: {
        work_share_pct: Math.round(workShare * 10) / 10,
        revenue_share_pct: Math.round(revShare * 10) / 10,
        gap_points: Math.round(gap * 10) / 10,
        tasks: work.length,
        revenue_minor: rev,
        currency,
        formula: "gap = (client tasks / all BizGrips tasks) − (client paid revenue / all paid revenue), both over the window",
      },
      interpretation: `${name} is consuming a much larger share of delivery effort than of collected revenue. That can be normal early in an engagement (setup-heavy phase) or a sign of scope creep / under-billing; check the contract scope and whether unbilled work is accumulating.`,
      evidence,
      range_start: new Date(since).toISOString(),
      range_end: now.toISOString(),
      confidence: totalRev > 0 ? 0.6 : 0.4,
      limitations: "Effort is approximated by portal task counts (no time tracking exists); revenue attribution depends on the client email map. Onboarding phases are naturally task-heavy.",
      severity: gap >= 40 ? "high" : "medium",
      proposed_mission: { title: `Review scope and billing for ${name}`, goal: `Compare the delivered work for ${name} in the last ${windowDays} days against the contracted scope and invoices; prepare a summary of unbilled or out-of-scope work for the owner to review.` },
    });
  }
  return out;
}

/** Adapts an ExtendedContext detector (rows, ctx) to the job DetectorContext. */
function ext(fn: (rows: DetectorContext["rows"], ctx: ExtendedContext) => ReturnType<NonNullable<DetectorSpec["run"]>>): NonNullable<DetectorSpec["run"]> {
  return (ctx) => fn(ctx.rows, { now: ctx.now, ownerEmail: ctx.ownerEmail ?? null, goals: ctx.goals ?? [], memories: ctx.memories ?? [], obligations: ctx.obligations ?? [], config: { timezone: ctx.timezone, ...ctx.job.config } });
}

export const ANALYSTS: DetectorSpec[] = [
  // Relationship Radar
  { id: "relationship_quiet", label: "Important relationships going quiet", kind: "custom", sources: ["google", "highlevel", "slack"], categories: ["relationship_quiet"], needs: ["memories", "owner"], run: ext(relationshipQuiet) },
  { id: "referral_source_declining", label: "Referral sources drying up", kind: "custom", sources: ["highlevel"], categories: ["referral_source_declining"], needs: ["owner"], run: ext(referralSourceDeclining) },
  { id: "contact_resurfaced", label: "Contacts resurfacing after long silence", kind: "custom", sources: ["google", "slack", "highlevel"], categories: ["contact_resurfaced"], needs: ["owner"], run: ext(contactResurfaced) },
  { id: "important_date", label: "Important dates (explicit calendar entries)", kind: "custom", sources: ["google"], categories: ["important_date"], run: ext(importantDate) },
  // Time Allocation / Attention Cost
  { id: "time_allocation_mismatch", label: "Calendar time vs top goal", kind: "custom", sources: ["google"], categories: ["time_allocation_mismatch"], needs: ["goals", "owner"], run: ext(timeAllocationMismatch) },
  { id: "attention_fragmentation", label: "Fragmented weeks and missing focus blocks", kind: "custom", sources: ["google"], categories: ["attention_fragmentation"], needs: ["owner"], run: ext(attentionFragmentation) },
  // Personal Project Tracker
  { id: "personal_project_stalled", label: "Stalled personal projects", kind: "custom", sources: ["google"], categories: ["personal_project_stalled"], needs: ["goals", "memories"], run: ext(personalProjectStalled) },
  { id: "personal_renewal_due", label: "Personal renewals due", kind: "custom", sources: ["plaid"], categories: ["personal_renewal_due"], needs: ["memories"], run: ext(personalRenewalDue) },
  // Expense Creep Hunter
  { id: "new_recurring_charge", label: "New recurring charges", kind: "custom", sources: ["plaid"], categories: ["new_recurring_charge"], run: ext(newRecurringCharge) },
  { id: "duplicate_tool", label: "Overlapping tools", kind: "custom", sources: ["plaid"], categories: ["duplicate_tool"], run: ext(duplicateTool) },
  { id: "price_increase", label: "Price increases", kind: "custom", sources: ["plaid"], categories: ["price_increase"], run: ext(priceIncrease) },
  { id: "unused_software", label: "Possibly unused software", kind: "custom", sources: ["plaid", "google"], categories: ["unused_software"], run: ext(unusedSoftware) },
  { id: "annual_renewal_upcoming", label: "Annual renewals coming up", kind: "custom", sources: ["plaid"], categories: ["annual_renewal_upcoming"], run: ext(annualRenewalUpcoming) },
  // Automation Auditor
  { id: "webhook_broken", label: "Broken notification channels", kind: "custom", sources: ["portal"], categories: ["webhook_broken"], run: ext(webhookBroken) },
  { id: "repeated_error", label: "Workflows failing repeatedly", kind: "custom", sources: ["n8n"], categories: ["repeated_error"], run: ext(repeatedError) },
  { id: "duplicate_lead_events", label: "Duplicate lead events", kind: "custom", sources: ["portal"], categories: ["automation_opportunity"], run: ext(duplicateLeadEvents) },
  { id: "manual_repetition", label: "Repeated manual work", kind: "custom", sources: ["portal", "google"], categories: ["manual_repetition"], needs: ["owner"], run: ext(manualRepetition) },
  // Client Health Analyst
  { id: "client_engagement_drop", label: "Client communication dropping", kind: "custom", sources: ["portal", "google", "highlevel"], categories: ["client_engagement_drop"], run: ext(clientEngagementDrop) },
  { id: "client_missed_meeting", label: "Cancelled / missed client meetings", kind: "custom", sources: ["portal", "highlevel"], categories: ["client_missed_meeting"], run: ext(clientMissedMeeting) },
  { id: "client_negative_signal", label: "Negative language in client messages", kind: "custom", sources: ["portal", "google", "highlevel"], categories: ["client_negative_signal"], needs: ["owner"], run: ext(clientNegativeSignal) },
];

const CUSTOM: DetectorSpec[] = [
  ...ANALYSTS,
  {
    id: "client_scope_creep",
    label: "Client scope creep (work vs revenue)",
    kind: "custom",
    sources: ["portal", "stripe"],
    categories: ["client_scope_creep"],
    run: (ctx: DetectorContext) => clientScopeCreep(ctx.rows, ctx.now, Number(ctx.job.config.window_days ?? SCOPE_CREEP_MIN_DAYS)),
  },
];

/** Subsystems the runner invokes itself (not pure over rows). */
const SPECIAL: DetectorSpec[] = [
  { id: "goal_trajectory", label: "Goal trajectory & recommendations", kind: "special", sources: [], categories: ["goal_trajectory"] },
  { id: "goal_coach", label: "Weekly goal coaching (constraint, indicator, next step)", kind: "special", sources: [], categories: ["goal_coach"] },
  { id: "blind_spots", label: "Blind spots (find what I'm missing)", kind: "special", sources: [], categories: ["blind_spot"] },
  { id: "quiet_client", label: "Clients going quiet", kind: "special", sources: ["portal", "highlevel", "google", "stripe"], categories: ["blind_spot"] },
  // Run B fills these in; keeping the ids reserved so jobs/rules can reference them now.
  { id: "follow_through", label: "Follow-Through (open obligations)", kind: "special", sources: [], categories: ["obligation"] },
];

export const DETECTOR_SPECS: DetectorSpec[] = [...MONITORS.map(wrapMonitor), ...CUSTOM, ...SPECIAL];

const BY_ID = new Map(DETECTOR_SPECS.map((d) => [d.id, d]));

export function getDetector(id: string): DetectorSpec | undefined {
  return BY_ID.get(id) ?? (id === "open_commitments" ? BY_ID.get("missed_commitment") : undefined);
}

export function detectorIds(): string[] {
  return DETECTOR_SPECS.map((d) => d.id);
}

/** Categories the global monitor runner may auto-resolve (everything a shared monitor emits). */
export const MONITOR_CATEGORIES = new Set(MONITORS.map((m) => m.id));
