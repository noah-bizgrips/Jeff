/**
 * Deterministic group titles and summaries (pure). Everything here is counts
 * and ordering — "6 overdue portal tasks", "oldest 19 days overdue", "4 owed by
 * BizGrips, 2 by the client", "primary blocker: CRM access". The optional AI
 * interpretation (interpret.ts) sits on top and never replaces this.
 */
import { ISSUE_LABEL, type EntityKey, type IssueKind } from "./keys";

export interface MemberItem {
  title: string;
  due_at: string | null;
  days_overdue: number | null;
  owner: string | null;
  priority: string | null;
  status: string | null;
  notes: string | null;
  blocking: boolean;
  stage: string | null;
  url: string | null;
}

export interface MemberDetail {
  kind: "finding" | "obligation" | "commitment" | "goal";
  category: string | null;
  due_at: string | null;
  days_overdue: number | null;
  owner: string | null;
  priority: string | null;
  status: string | null;
  notes: string | null;
  blocking: boolean;
  source: string | null;
  href: string;
  /** Per-record rows (portal tasks, invoices, leads) when the member is a finding that lists them. */
  items?: MemberItem[];
  /** Number of underlying records the member represents (e.g. 6 overdue tasks). */
  count?: number;
}

export interface SummaryMember {
  member_kind: "alert" | "obligation";
  title: string;
  detail: MemberDetail;
  importance: string;
}

export interface SummaryFacts {
  member_count: number;
  /** Underlying records across members (tasks, invoices, leads, reminders). */
  record_count: number;
  oldest_overdue_days: number | null;
  primary_blocker: string | null;
  owner_split: { bizgrips: number; client: number; you: number; other: number };
  by_kind: Record<string, number>;
  by_category: Record<string, number>;
  sources: string[];
  urgent: number;
}

const CATEGORY_NOUN: Record<string, [string, string]> = {
  portal_task_overdue: ["overdue portal task", "overdue portal tasks"],
  portal_stage_stalled: ["stalled stage", "stalled stages"],
  portal_notification_failure: ["failed notification", "failed notifications"],
  client_unpaid_invoice: ["unpaid invoice", "unpaid invoices"],
  failed_payment: ["failed payment", "failed payments"],
  lead_not_contacted: ["uncontacted lead", "uncontacted leads"],
  client_ad_spend_no_leads: ["ad spend without leads", "ad spend without leads"],
  client_engagement_drop: ["engagement drop", "engagement drops"],
  client_missed_meeting: ["missed meeting", "missed meetings"],
  client_negative_signal: ["negative signal", "negative signals"],
  client_scope_creep: ["scope-creep signal", "scope-creep signals"],
  automation_failure: ["workflow failure", "workflow failures"],
  repeated_error: ["repeated error", "repeated errors"],
  webhook_broken: ["broken webhook", "broken webhooks"],
  underperforming_acquisition: ["underperforming campaign", "underperforming campaigns"],
  ad_spend_change: ["ad spend change", "ad spend changes"],
  missed_commitment: ["missed commitment", "missed commitments"],
};

function noun(category: string | null, n: number): string {
  const pair = category ? CATEGORY_NOUN[category] : undefined;
  if (pair) return n === 1 ? pair[0] : pair[1];
  const base = (category ?? "signal").replace(/_/g, " ");
  return n === 1 ? base : `${base}s`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Record count a member represents: listed items, else the finding's own count, else 1. */
export function recordCount(d: MemberDetail): number {
  if (d.items?.length) return d.items.length;
  if (typeof d.count === "number" && d.count > 0) return d.count;
  return 1;
}

export function computeFacts(members: SummaryMember[]): SummaryFacts {
  const facts: SummaryFacts = { member_count: members.length, record_count: 0, oldest_overdue_days: null, primary_blocker: null, owner_split: { bizgrips: 0, client: 0, you: 0, other: 0 }, by_kind: {}, by_category: {}, sources: [], urgent: 0 };
  const sources = new Set<string>();
  let blocker: { title: string; score: number } | null = null;
  for (const m of members) {
    const d = m.detail;
    facts.record_count += recordCount(d);
    facts.by_kind[d.kind] = (facts.by_kind[d.kind] ?? 0) + 1;
    if (d.category) facts.by_category[d.category] = (facts.by_category[d.category] ?? 0) + 1;
    if (d.source) sources.add(d.source);
    if (m.importance === "urgent") facts.urgent++;
    const rows = d.items?.length ? d.items : [{ days_overdue: d.days_overdue, owner: d.owner, blocking: d.blocking, title: m.title, priority: d.priority }];
    for (const r of rows) {
      if (r.days_overdue != null && (facts.oldest_overdue_days == null || r.days_overdue > facts.oldest_overdue_days)) facts.oldest_overdue_days = r.days_overdue;
      const owner = (r.owner ?? "").toLowerCase();
      if (owner === "bizgrips" || owner === "both") facts.owner_split.bizgrips++;
      else if (owner === "client") facts.owner_split.client++;
      else if (owner === "you" || owner === "me") facts.owner_split.you++;
      else if (owner) facts.owner_split.other++;
      // Primary blocker: a blocking record beats the oldest overdue one beats the highest priority.
      const score = (r.blocking ? 1000 : 0) + (r.days_overdue ?? 0) + (r.priority === "critical" ? 50 : r.priority === "high" ? 25 : 0);
      if (!blocker || score > blocker.score) blocker = { title: r.title, score };
    }
  }
  facts.sources = [...sources].sort();
  facts.primary_blocker = blocker && blocker.score > 0 ? blocker.title : null;
  return facts;
}

export function buildSummary(args: { entity: EntityKey; issue: IssueKind; members: SummaryMember[]; now: Date }): { title: string; summary: string; facts: SummaryFacts } {
  const { entity, issue, members } = args;
  const facts = computeFacts(members);
  const cats = Object.entries(facts.by_category).sort((a, b) => b[1] - a[1]);
  const obligations = facts.by_kind.obligation ?? 0;
  const commitments = facts.by_kind.commitment ?? 0;
  const goals = facts.by_kind.goal ?? 0;

  // Headline: one dominant category → "6 overdue portal tasks"; otherwise the issue family with a signal count.
  const parts: string[] = [];
  for (const [cat, n] of cats.slice(0, 2)) {
    const records = members.filter((m) => m.detail.category === cat).reduce((s, m) => s + recordCount(m.detail), 0);
    parts.push(cat === "portal_task_overdue" || cat === "client_unpaid_invoice" || cat === "lead_not_contacted" ? `${records} ${noun(cat, records)}` : `${n} ${noun(cat, n)}`);
  }
  if (obligations) parts.push(plural(obligations, "open follow-through item", "open follow-through items"));
  if (commitments) parts.push(plural(commitments, "commitment", "commitments"));
  if (goals) parts.push(plural(goals, "goal change", "goal changes"));
  const extra = cats.length > 2 ? ` +${cats.length - 2} more` : "";
  const headline = parts.length ? `${parts.slice(0, 2).join(" · ")}${parts.length > 2 ? ` +${parts.length - 2} more` : extra}` : `${facts.member_count} related ${ISSUE_LABEL[issue]} signals`;
  const title = `${entity.name} — ${headline}`;

  const lines: string[] = [];
  lines.push(`${facts.member_count} related signal${facts.member_count === 1 ? "" : "s"} across ${facts.sources.length ? facts.sources.join(", ") : "one source"} point at one ${entity.kind === "client" ? `${ISSUE_LABEL[issue]} situation` : "situation"} for ${entity.name}.`);
  if (facts.oldest_overdue_days != null && facts.oldest_overdue_days > 0) lines.push(`Oldest item is ${facts.oldest_overdue_days} day${facts.oldest_overdue_days === 1 ? "" : "s"} overdue.`);
  const split = facts.owner_split;
  const splitParts = [split.bizgrips ? `${split.bizgrips} owed by BizGrips` : null, split.client ? `${split.client} owed by the client` : null, split.you ? `${split.you} on you` : null, split.other ? `${split.other} waiting on others` : null].filter(Boolean);
  if (splitParts.length) lines.push(`Owner split: ${splitParts.join(", ")}.`);
  if (facts.primary_blocker) lines.push(`Primary blocker: ${facts.primary_blocker}.`);
  if (facts.urgent) lines.push(`${facts.urgent} of these ${facts.urgent === 1 ? "is" : "are"} urgent.`);
  return { title: title.slice(0, 300), summary: lines.join(" ").slice(0, 2000), facts };
}
