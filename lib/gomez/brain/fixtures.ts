/**
 * Canned brain inputs for the dev harness (/brain-lab) and the unit tests.
 * Each scenario is real aggregator input, so the lab shows exactly what the
 * production code would compute — not hand-drawn states.
 */
import type { BrainAlertInput, BrainConnectionInput, BrainFindingInput, BrainGoalInput, BrainJobRunInput, BrainObligationInput, BrainStateInput } from "./state";

export const FIXTURE_NOW = new Date("2026-09-13T15:00:00.000Z");

const hoursAgo = (h: number) => new Date(FIXTURE_NOW.getTime() - h * 3_600_000).toISOString();
const daysAgo = (d: number) => hoursAgo(d * 24);

export function conn(provider: string, extra: Partial<BrainConnectionInput> = {}): BrainConnectionInput {
  const caps = provider === "google" ? ["gmail", "drive", "calendar"] : provider === "meta" ? ["ads", "pages", "instagram"] : [];
  return { provider, capabilities: caps, status: "connected", freshness_level: "fresh", freshness_text: `Synced 12m ago`, age_hours: 0.2, ...extra };
}

export const HEALTHY_CONNECTIONS: BrainConnectionInput[] = [conn("google"), conn("slack"), conn("stripe"), conn("plaid"), conn("highlevel"), conn("portal"), conn("github")];

export function alert(id: string, importance: string, title: string, extra: Partial<BrainAlertInput> = {}): BrainAlertInput {
  return { id, kind: "finding", category: null, importance, status: "open", title, summary: null, ref_id: null, evidence: [], first_seen: hoursAgo(3), ...extra };
}

export function finding(id: string, category: string, title: string, extra: Partial<BrainFindingInput> = {}): BrainFindingInput {
  return { id, category, title, status: "open", severity: "medium", confidence: 0.7, metrics: {}, evidence: [], goal_id: null, created_at: hoursAgo(2), ...extra };
}

export function goal(id: string, name: string, trajectory: string, extra: Partial<BrainGoalInput> = {}): BrainGoalInput {
  return { id, name, status: "active", trajectory, constraint_key: null, sources: ["stripe"], ...extra };
}

export function obligation(id: string, title: string, extra: Partial<BrainObligationInput> = {}): BrainObligationInput {
  return { id, title, status: "open", bucket: "overdue", priority: "normal", scope: "business", due_at: daysAgo(2), related_goal_id: null, related_client_id: null, has_money: false, source_provider: "google", ...extra };
}

export function run(slug: string, name: string, status: string, extra: Partial<BrainJobRunInput> = {}): BrainJobRunInput {
  return { job_slug: slug, job_name: name, status, mode: "scheduled", sources: ["stripe", "highlevel"], finished_at: status === "running" || status === "queued" ? null : hoursAgo(1), error: status === "failed" ? "provider timeout" : null, ...extra };
}

export function base(over: Partial<BrainStateInput> = {}): BrainStateInput {
  return { now: FIXTURE_NOW, alerts: [], findings: [], goals: [], obligations: [], connections: HEALTHY_CONNECTIONS, jobRuns: [], ...over };
}

export interface BrainScenario {
  id: string;
  title: string;
  spec: string;
  input: BrainStateInput;
  /** Client activity to simulate on top of the computed state. */
  activity?: { kind: "ask" | "scan" | "job"; sources: string[] };
}

export const SCENARIOS: BrainScenario[] = [
  { id: "quiet", title: "Quiet (nothing connected)", spec: "§35 zero state", input: base({ connections: [] }) },
  { id: "watching", title: "Watching", spec: "§10 default", input: base() },
  {
    id: "attention",
    title: "3 things need attention",
    spec: "§36",
    input: base({
      alerts: [
        alert("a1", "important", "Invoice #1042 is 9 days past due", { category: "client_unpaid_invoice", evidence: [{ provider: "stripe" }] }),
        alert("a2", "important", "4 leads not contacted in 48h", { category: "lead_followup_gap", evidence: [{ provider: "highlevel" }] }),
      ],
      obligations: [obligation("o1", "Send Northwind the revised proposal", { priority: "high", related_client_id: "c1", due_at: daysAgo(1) })],
    }),
  },
  {
    id: "urgent",
    title: "Urgent",
    spec: "§10 urgent pulse",
    input: base({
      alerts: [alert("u1", "urgent", "Stripe payout failed — bank account rejected", { category: "failed_payment", evidence: [{ provider: "stripe" }] })],
      goals: [goal("g1", "Reach $40k MRR by December", "severely_at_risk", { sources: ["stripe", "highlevel"] })],
    }),
  },
  {
    id: "opportunity",
    title: "Opportunity",
    spec: "§37",
    input: base({
      findings: [
        finding("f1", "blind_spot", "3 past clients showed buying signals this week", { metrics: { theme: "opportunity", subtype: "reactivation" }, evidence: [{ provider: "highlevel" }], confidence: 0.82 }),
        finding("f2", "unused_software", "Two seats on Notion have been idle for 60 days", { evidence: [{ provider: "plaid" }], confidence: 0.6 }),
      ],
    }),
  },
  {
    id: "degraded",
    title: "Degraded (system only)",
    spec: "§38 no business pressure",
    input: base({
      connections: [conn("google", { status: "reconnect_required", freshness_level: "error", freshness_text: "Reconnect required" }), conn("slack", { freshness_level: "stale", freshness_text: "Last synced 3 days ago", age_hours: 71 }), conn("stripe"), conn("plaid")],
      jobRuns: [run("blind-spot-scanner", "Blind Spot Scanner", "failed")],
    }),
  },
  {
    id: "investigating",
    title: "Investigating (job running)",
    spec: "§39",
    input: base({ jobRuns: [run("client-health", "Client Health", "running", { sources: ["highlevel", "portal"] })] }),
  },
  {
    id: "ask",
    title: "Ask Gomez in flight",
    spec: "§16 retrieval",
    input: base(),
    activity: { kind: "ask", sources: ["stripe", "plaid"] },
  },
  {
    id: "scan",
    title: "Blind-spot scan (financial stage)",
    spec: "§17 scanning",
    input: base({ alerts: [alert("a1", "important", "Invoice #1042 is 9 days past due", { category: "client_unpaid_invoice", evidence: [{ provider: "stripe" }] })] }),
    activity: { kind: "scan", sources: ["stripe", "plaid"] },
  },
  {
    id: "mixed",
    title: "Mixed: attention + opportunity + stale",
    spec: "§8 coexisting tones, §40 precedence",
    input: base({
      alerts: [alert("a1", "important", "Invoice #1042 is 9 days past due", { category: "client_unpaid_invoice", evidence: [{ provider: "stripe" }] })],
      findings: [finding("f1", "blind_spot", "3 past clients showed buying signals this week", { metrics: { theme: "opportunity", subtype: "reactivation" }, evidence: [{ provider: "highlevel" }], confidence: 0.82 })],
      connections: [conn("google"), conn("slack", { freshness_level: "stale", freshness_text: "Last synced 3 days ago", age_hours: 71 }), conn("stripe"), conn("plaid"), conn("highlevel")],
    }),
  },
  {
    id: "noise",
    title: "Noise filtered (suppressed GitHub findings)",
    spec: "§36 suppressed_by_rule = 0",
    input: base({
      findings: [
        finding("s1", "repeated_error", "CI flake on main", { status: "suppressed_by_rule", evidence: [{ provider: "github" }] }),
        finding("s2", "repeated_error", "Dependabot noise", { status: "dismissed", evidence: [{ provider: "github" }] }),
        finding("s3", "automation_opportunity", "Resolved already", { status: "resolved", evidence: [{ provider: "github" }] }),
      ],
      alerts: [alert("x1", "important", "Old alert", { status: "dismissed", evidence: [{ provider: "github" }] }), alert("x2", "important", "Acknowledged alert", { status: "acknowledged", evidence: [{ provider: "github" }] })],
    }),
  },
];
