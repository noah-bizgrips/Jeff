import type { BriefingKind } from "./schedule";
import type { BriefingSummary, BriefingItem } from "./schema";
import { money } from "@/lib/jeff/alerts/engine";

/**
 * Deterministic evidence bundle → deterministic briefing (the template).
 * Everything here is math and ordering; the model (compose.ts) only rewrites
 * this into prose and may drop items, never invent them.
 */

export interface BundleAlert {
  id: string;
  kind: string;
  category: string | null;
  importance: "informational" | "briefing" | "important" | "urgent" | "actionable";
  title: string;
  summary: string | null;
  ref_id: string | null;
  occurrences: number;
  status: string;
}

export interface BundleGoal {
  id: string;
  name: string;
  trajectory: string;
  trajectory_label: string;
  primary: string | null;
  constraint: string | null;
  days_remaining: number | null;
  change: string | null;
}

export interface BundleEvent {
  title: string;
  start: string | null;
  location: string | null;
  attendees: number | null;
}

export interface BundleCommitment {
  id: string;
  action_text: string;
  context_text: string | null;
  due_at: string | null;
  direction: "owed_by_me" | "owed_to_me";
  status: string;
}

export interface BundleFinding {
  id: string;
  category: string;
  title: string;
  severity: string;
  status: string;
  created_at: string;
  proposed_mission: { title: string; goal: string } | null;
}

export interface BundleFinance {
  stripe_inflow: number | null;
  stripe_prev_inflow: number | null;
  plaid_inflow: number | null;
  plaid_outflow: number | null;
  plaid_prev_inflow: number | null;
  plaid_prev_outflow: number | null;
  open_invoices_count: number;
  open_invoices_minor: number;
  failed_charges_count: number;
  mrr_minor: number | null;
}

export interface BundleMission {
  id: string;
  code: string;
  title: string;
  status: string;
  completed_at: string | null;
}

export interface BundleOutcome {
  mission_id: string;
  mission_title: string;
  metric_label: string;
  direction: string;
  delta_pct: number | null;
  limitations: string | null;
}

export interface BriefingBundle {
  kind: BriefingKind;
  period_start: string;
  period_end: string;
  timezone: string;
  owner_first_name: string;
  now: Date;
  alerts: BundleAlert[];
  goals: BundleGoal[];
  events_today: BundleEvent[];
  commitments: BundleCommitment[];
  findings: BundleFinding[];
  finance: BundleFinance | null;
  missions: BundleMission[];
  outcomes: BundleOutcome[];
  freshness: string[];
  /** Soft memories (communication style, priorities) — plain text. */
  memories: string[];
  /** Names of briefing rules that apply. */
  briefing_rules: string[];
  /** Max attention items (owner setting, overridable by memory). */
  max_items: number;
}

const IMPORTANCE_RANK: Record<BundleAlert["importance"], number> = { informational: 0, briefing: 1, important: 2, actionable: 2.5, urgent: 3 };
const CLIENT_CATEGORIES = new Set(["lead_followup_gap", "pipeline_aging", "commitment_owed_by_me", "commitment_owed_to_me", "onboarding_blocker"]);
const FINANCE_CATEGORIES = new Set(["failed_payment", "cashflow_change", "recurring_expense_change"]);

/** Reads a "no more than N items" style preference out of memories. */
const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

export function maxItemsFromMemories(memories: string[], fallback: number): number {
  const NUM = "(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)";
  const lead = new RegExp(`(?:no more than|at most|max(?:imum)?(?: of)?|under|fewer than|keep (?:it|them) to)\\s+${NUM}\\s+(?:main |top |key )?(?:items|bullets|points|things)`, "i");
  const trail = new RegExp(`${NUM}\\s+(?:main |top |key )?(?:items|bullets|points)\\s+(?:max|maximum|or fewer|at most|tops)`, "i");
  for (const m of memories) {
    const hit = m.match(lead) ?? m.match(trail);
    if (hit) {
      const raw = hit[1]!.toLowerCase();
      const n = WORD_NUMBERS[raw] ?? Number(raw);
      if (n >= 1 && n <= 10) return n;
    }
  }
  return fallback;
}

function alertItem(a: BundleAlert): BriefingItem {
  return { title: a.title, detail: (a.summary ?? "").slice(0, 600), ref_kind: a.kind === "goal" ? "goal" : a.kind === "commitment" ? "commitment" : a.ref_id ? "finding" : "alert", ref_id: a.ref_id ?? a.id, importance: a.importance };
}

/**
 * Attention ordering (product decision, deterministic): goals at risk first
 * (what the owner is trying to accomplish), then client/pipeline signals,
 * then financial, then everything else — each group by importance.
 */
export function rankAttention(alerts: BundleAlert[], goals: BundleGoal[]): BriefingItem[] {
  const open = alerts.filter((a) => ["open", "acknowledged"].includes(a.status));
  const goalItems: BriefingItem[] = goals
    .filter((g) => ["slightly_at_risk", "at_risk", "severely_at_risk"].includes(g.trajectory))
    .sort((a, b) => riskRank(b.trajectory) - riskRank(a.trajectory))
    .map((g) => ({
      title: `${g.name}: ${g.trajectory_label.toLowerCase()}`,
      detail: [g.primary, g.constraint ? `constraint: ${g.constraint}` : null, g.days_remaining != null ? `${g.days_remaining} days remaining` : null].filter(Boolean).join(" · "),
      ref_kind: "goal" as const,
      ref_id: g.id,
      importance: (g.trajectory === "severely_at_risk" ? "urgent" : "important") as BriefingItem["importance"],
    }));
  const goalAlertIds = new Set(goalItems.map((g) => g.ref_id));
  const nonGoal = open.filter((a) => !(a.kind === "goal" && goalAlertIds.has(a.ref_id)));
  const byImportance = (xs: BundleAlert[]) => [...xs].sort((a, b) => IMPORTANCE_RANK[b.importance] - IMPORTANCE_RANK[a.importance] || b.occurrences - a.occurrences);
  const client = byImportance(nonGoal.filter((a) => a.category && CLIENT_CATEGORIES.has(a.category)));
  const finance = byImportance(nonGoal.filter((a) => a.category && FINANCE_CATEGORIES.has(a.category)));
  const rest = byImportance(nonGoal.filter((a) => !(a.category && (CLIENT_CATEGORIES.has(a.category) || FINANCE_CATEGORIES.has(a.category)))));
  // Urgent items from any group jump ahead of merely important ones in other groups.
  const ordered = [...goalItems, ...client.map(alertItem), ...finance.map(alertItem), ...rest.map(alertItem)];
  const urgent = ordered.filter((i) => i.importance === "urgent");
  const others = ordered.filter((i) => i.importance !== "urgent");
  // Keep goal items first even when not urgent; then urgent alerts; then the rest.
  const goalsFirst = others.filter((i) => i.ref_kind === "goal");
  const remaining = others.filter((i) => i.ref_kind !== "goal");
  return [...goalsFirst, ...urgent.filter((u) => u.ref_kind !== "goal"), ...remaining];
}

function riskRank(t: string) {
  return ({ slightly_at_risk: 1, at_risk: 2, severely_at_risk: 3 } as Record<string, number>)[t] ?? 0;
}

function pct(cur: number | null, prev: number | null): string | null {
  if (cur == null || prev == null || prev === 0) return null;
  const p = ((cur - prev) / prev) * 100;
  return `${p >= 0 ? "+" : ""}${Math.round(p)}% vs prior period`;
}

function fmtTime(iso: string | null, timezone: string): string {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return "";
  }
}

/** The deterministic briefing. Never empty; never invents data. */
export function buildTemplate(b: BriefingBundle): BriefingSummary {
  const attentionAll = rankAttention(b.alerts, b.goals);
  const top = attentionAll.slice(0, b.max_items);
  const omitted = Math.max(0, attentionAll.length - top.length);
  const greetingName = b.owner_first_name ? `, ${b.owner_first_name}` : "";
  const title = b.kind === "daily" ? `Daily brief · ${b.period_start}` : b.kind === "weekly" ? `Weekly operating review · ${b.period_start} → ${b.period_end}` : `Monthly owner review · ${b.period_start.slice(0, 7)}`;

  const today: BriefingItem[] = [
    ...b.events_today.map((e) => ({ title: `${fmtTime(e.start, b.timezone)} ${e.title}`.trim(), detail: [e.location, e.attendees ? `${e.attendees} attendees` : null].filter(Boolean).join(" · "), ref_kind: "none" as const, ref_id: null, importance: "briefing" as const })),
    ...b.commitments
      .filter((c) => c.status === "open" || c.status === "overdue")
      .slice(0, 8)
      .map((c) => ({
        title: `${c.status === "overdue" ? "Overdue" : "Due"}: ${c.action_text}`,
        detail: c.context_text ?? "",
        ref_kind: "commitment" as const,
        ref_id: c.id,
        importance: (c.status === "overdue" && c.direction === "owed_by_me" ? "important" : "briefing") as BriefingItem["importance"],
      })),
  ];

  const signals: BriefingItem[] = b.findings
    .filter((f) => ["open", "new", "accepted", "reviewing", "monitoring"].includes(f.status) && !FINANCE_CATEGORIES.has(f.category))
    .slice(0, 8)
    .map((f) => ({ title: f.title, detail: `${f.category.replace(/_/g, " ")} · ${f.severity}`, ref_kind: "finding" as const, ref_id: f.id, importance: "briefing" as const }));

  const financial: BriefingSummary["financial"] = [];
  if (b.finance) {
    const f = b.finance;
    if (f.stripe_inflow != null) financial.push({ label: "Collected (Stripe)", value: money(f.stripe_inflow), change: pct(f.stripe_inflow, f.stripe_prev_inflow), note: null });
    if (f.mrr_minor != null) financial.push({ label: "MRR (active subscriptions)", value: money(f.mrr_minor), change: null, note: null });
    if (f.open_invoices_count) financial.push({ label: "Open invoices", value: `${f.open_invoices_count} · ${money(f.open_invoices_minor)}`, change: null, note: null });
    if (f.failed_charges_count) financial.push({ label: "Failed charges", value: String(f.failed_charges_count), change: null, note: "see alerts" });
    if (f.plaid_inflow != null) financial.push({ label: "Bank inflow", value: money(f.plaid_inflow), change: pct(f.plaid_inflow, f.plaid_prev_inflow), note: null });
    if (f.plaid_outflow != null) financial.push({ label: "Bank outflow", value: money(f.plaid_outflow), change: pct(f.plaid_outflow, f.plaid_prev_outflow), note: null });
  }

  const recommends: BriefingItem[] = [
    ...b.goals.filter((g) => g.constraint && ["at_risk", "severely_at_risk", "slightly_at_risk"].includes(g.trajectory)).slice(0, 3).map((g) => ({ title: `Work the constraint on "${g.name}"`, detail: `The binding constraint is ${g.constraint}. Review the goal's recommendations and prepare a mission.`, ref_kind: "goal" as const, ref_id: g.id, importance: "actionable" as const })),
    ...b.findings.filter((f) => f.proposed_mission && ["open", "new", "accepted"].includes(f.status)).slice(0, 3).map((f) => ({ title: f.proposed_mission!.title, detail: f.proposed_mission!.goal.slice(0, 400), ref_kind: "finding" as const, ref_id: f.id, importance: "actionable" as const })),
  ].slice(0, 5);

  const summary: BriefingSummary = {
    title,
    greeting: b.kind === "daily" ? `Good morning${greetingName}.` : b.kind === "weekly" ? `Your week in review${greetingName}.` : `Your month in review${greetingName}.`,
    top_attention: top,
    goals: b.goals.map((g) => ({ goal_id: g.id, name: g.name, trajectory: g.trajectory_label, progress: g.primary ?? "no primary metric yet", constraint: g.constraint, change: g.change })),
    today: b.kind === "daily" ? today.slice(0, 12) : [],
    business_signals: signals,
    financial,
    recommends,
    changes: [],
    wins: [],
    misses: [],
    outcomes: b.outcomes.map((o) => ({ title: `${o.mission_title}: ${o.metric_label} ${o.direction}${o.delta_pct != null ? ` (${o.delta_pct >= 0 ? "+" : ""}${Math.round(o.delta_pct)}%)` : ""}`, detail: o.limitations ?? "", ref_kind: "mission" as const, ref_id: o.mission_id, importance: "informational" as const })),
    freshness: b.freshness,
    omitted_count: omitted,
    applied_preferences: [...b.briefing_rules, ...(b.max_items !== 3 ? [`Attention items capped at ${b.max_items}`] : [])],
  };

  if (b.kind !== "daily") {
    const resolved = b.findings.filter((f) => f.status === "resolved");
    const opened = b.findings.filter((f) => ["open", "new"].includes(f.status));
    summary.changes = [
      ...(resolved.length ? [{ title: `${resolved.length} finding${resolved.length === 1 ? "" : "s"} resolved`, detail: resolved.slice(0, 5).map((f) => f.title).join("; "), ref_kind: "none" as const, ref_id: null, importance: "informational" as const }] : []),
      ...(opened.length ? [{ title: `${opened.length} new finding${opened.length === 1 ? "" : "s"}`, detail: opened.slice(0, 5).map((f) => f.title).join("; "), ref_kind: "none" as const, ref_id: null, importance: "briefing" as const }] : []),
      ...b.goals.filter((g) => g.change).map((g) => ({ title: g.name, detail: g.change!, ref_kind: "goal" as const, ref_id: g.id, importance: "briefing" as const })),
    ];
    summary.wins = [...b.missions.filter((m) => m.status === "completed").map((m) => `Completed: ${m.title}`), ...b.goals.filter((g) => g.trajectory === "on_track").map((g) => `${g.name} is on track`)].slice(0, 10);
    summary.misses = [...b.goals.filter((g) => ["at_risk", "severely_at_risk"].includes(g.trajectory)).map((g) => `${g.name}: ${g.trajectory_label.toLowerCase()}${g.constraint ? ` (${g.constraint})` : ""}`), ...b.commitments.filter((c) => c.status === "overdue" && c.direction === "owed_by_me").map((c) => `Overdue: ${c.action_text}`)].slice(0, 10);
    if (b.kind === "monthly" && !financial.length) financial.push({ label: "Financial metrics", value: "insufficient data", change: null, note: "Connect Stripe / Financial Accounts and let a full month sync." });
  }
  return summary;
}
