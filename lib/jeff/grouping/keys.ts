/**
 * Entity-key derivation for context-aware alert grouping (pure, unit-testable).
 *
 * Structured relationships always win: a finding whose fingerprint carries the
 * portal client id, an obligation with related_client_id / related_goal_id, a
 * goal alert's ref_id. Name matching against the client map is the ONLY
 * semantic step, and it is used purely as a tie-breaker to attach a
 * free-text obligation or commitment to a client that is already known.
 */

export type EntityKind = "client" | "project" | "goal" | "mission" | "contact" | "campaign" | "workflow" | "issue" | "category";
export type IssueKind = "delivery" | "money" | "engagement" | "acquisition" | "goal" | "automation" | "follow_through" | "mixed";

export interface EntityKey {
  kind: EntityKind;
  id: string;
  name: string;
  /** structured = an id relationship; semantic = name/keyword match (tie-breaker only). */
  source: "structured" | "semantic";
}

export interface ClientLite {
  portal_client_id: string;
  name: string;
  slug?: string | null;
  email_domains?: string[];
}

/** Finding categories whose fingerprint is `<category>:<portal client id>[:...]`. */
export const CLIENT_FINGERPRINT_CATEGORIES = new Set([
  "portal_task_overdue",
  "client_unpaid_invoice",
  "lead_not_contacted",
  "client_engagement_drop",
  "client_missed_meeting",
  "client_negative_signal",
  "client_ad_spend_no_leads",
  "portal_notification_failure",
  "client_scope_creep",
]);

/** Category → issue family. Anything not listed is "mixed" (kept in the entity group, labelled generically). */
export const CATEGORY_ISSUE: Record<string, IssueKind> = {
  portal_task_overdue: "delivery",
  portal_stage_stalled: "delivery",
  onboarding_blocker: "delivery",
  portal_notification_failure: "delivery",
  client_unpaid_invoice: "money",
  failed_payment: "money",
  client_scope_creep: "money",
  cashflow_change: "money",
  client_engagement_drop: "engagement",
  client_missed_meeting: "engagement",
  client_negative_signal: "engagement",
  relationship_quiet: "engagement",
  lead_not_contacted: "acquisition",
  client_ad_spend_no_leads: "acquisition",
  lead_followup_gap: "acquisition",
  pipeline_aging: "acquisition",
  underperforming_acquisition: "acquisition",
  ad_spend_change: "acquisition",
  goal_trajectory: "goal",
  goal_coach: "goal",
  automation_failure: "automation",
  repeated_error: "automation",
  webhook_broken: "automation",
  missed_commitment: "follow_through",
  obligation_waiting_on_me: "follow_through",
  obligation_waiting_on_other: "follow_through",
  commitment_owed_by_me: "follow_through",
  commitment_owed_to_me: "follow_through",
};

export const ISSUE_LABEL: Record<IssueKind, string> = {
  delivery: "delivery",
  money: "billing",
  engagement: "engagement",
  acquisition: "lead flow",
  goal: "goal",
  automation: "automation",
  follow_through: "follow-through",
  mixed: "several signals",
};

export function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .slice(0, 60);
}

/** Issue family for an alert/finding category. */
export function issueOfCategory(category: string | null | undefined): IssueKind {
  if (!category) return "mixed";
  return CATEGORY_ISSUE[category] ?? "mixed";
}

/** Keyword tie-breaker for free-text items (obligations, commitments) that carry no category. */
export function issueOfText(text: string): IssueKind {
  const t = text.toLowerCase();
  if (/\b(invoice|payment|paid|pay|billing|deposit|refund|charge|balance|overdue balance)\b/.test(t)) return "money";
  if (/\b(lead|leads|ad(s)?|campaign|form|cpl|spend)\b/.test(t)) return "acquisition";
  if (/\b(meeting|call|check-?in|no response|unresponsive|reply|replied|feedback)\b/.test(t)) return "engagement";
  if (/\b(access|login|credential|crm|onboard|onboarding|launch|website|site|task|deliver|build|setup|set up|domain|dns|portal)\b/.test(t)) return "delivery";
  return "follow_through";
}

/** Resolves a client by exact name / slug / "Name:" title prefix (case-insensitive). Semantic — tie-breaker only. */
export function clientByName(text: string | null | undefined, clients: ClientLite[]): ClientLite | null {
  if (!text || !clients.length) return null;
  const t = text.toLowerCase();
  let best: ClientLite | null = null;
  for (const c of clients) {
    const name = c.name.toLowerCase();
    if (name.length < 4) continue;
    if (t === name || t.startsWith(`${name}:`) || t.startsWith(`${name} —`) || t.startsWith(`${name} -`) || t.includes(` ${name} `) || t.includes(`${name}'s`) || t.startsWith(`${name} `) || t.endsWith(` ${name}`)) {
      if (!best || c.name.length > best.name.length) best = c;
    }
  }
  return best;
}

export interface AlertKeyInput {
  kind: string;
  fingerprint: string;
  category: string | null;
  title: string;
  ref_id: string | null;
  /** From the underlying finding when known. */
  goal_id?: string | null;
  /** From the underlying obligation when known. */
  related_client_id?: string | null;
  related_goal_id?: string | null;
  related_mission_id?: string | null;
  counterparty?: string | null;
  /** From the underlying commitment when known. */
  commitment_counterparty?: string | null;
}

/** Primary entity for an alert, or null when it has no structured or safe semantic anchor. */
export function entityKeyForAlert(a: AlertKeyInput, clients: ClientLite[], goalNames: Map<string, string> = new Map()): EntityKey | null {
  const clientName = (id: string) => clients.find((c) => c.portal_client_id === id)?.name ?? `Client ${id}`;
  if (a.kind === "goal" && a.ref_id) return { kind: "goal", id: a.ref_id, name: goalNames.get(a.ref_id) ?? a.title.split(":")[0]!.trim(), source: "structured" };
  if (a.kind === "obligation") {
    if (a.related_client_id) return { kind: "client", id: a.related_client_id, name: clientName(a.related_client_id), source: "structured" };
    if (a.related_goal_id) return { kind: "goal", id: a.related_goal_id, name: goalNames.get(a.related_goal_id) ?? "Goal", source: "structured" };
    if (a.related_mission_id) return { kind: "mission", id: a.related_mission_id, name: "Mission", source: "structured" };
    const byName = clientByName(a.title, clients) ?? clientByName(a.counterparty, clients);
    if (byName) return { kind: "client", id: byName.portal_client_id, name: byName.name, source: "semantic" };
    if (a.counterparty) return { kind: "contact", id: slug(a.counterparty), name: a.counterparty, source: "structured" };
    return null;
  }
  if (a.kind === "commitment") {
    const who = a.commitment_counterparty ?? a.counterparty ?? null;
    const byName = clientByName(who, clients) ?? clientByName(a.title, clients);
    if (byName) return { kind: "client", id: byName.portal_client_id, name: byName.name, source: "semantic" };
    if (who) return { kind: "contact", id: slug(who), name: who, source: "structured" };
    return null;
  }
  if (a.kind === "finding") {
    const cat = a.category ?? a.fingerprint.split(":")[0] ?? "";
    const parts = a.fingerprint.split(":");
    if (CLIENT_FINGERPRINT_CATEGORIES.has(cat) && parts[1] && parts[1] !== "unknown" && parts[1] !== "none") {
      return { kind: "client", id: parts[1], name: clientName(parts[1]), source: "structured" };
    }
    if (a.goal_id) return { kind: "goal", id: a.goal_id, name: goalNames.get(a.goal_id) ?? "Goal", source: "structured" };
    if (["automation_failure", "repeated_error", "webhook_broken"].includes(cat) && parts[1]) return { kind: "workflow", id: parts.slice(1).join(":"), name: parts.slice(1).join(":"), source: "structured" };
    if (["ad_spend_change", "underperforming_acquisition"].includes(cat) && parts[1] === "meta" && parts[2]) return { kind: "campaign", id: `meta:${parts[2]}`, name: `Meta ad account ${parts[2]}`, source: "structured" };
    // Portal findings keyed by a stage/lead id: the client is named in the title ("Client: stage …").
    const byName = clientByName(a.title, clients);
    if (byName) return { kind: "client", id: byName.portal_client_id, name: byName.name, source: "semantic" };
    return null;
  }
  return null;
}

/** Group key = entity + issue family (a client can have a billing situation and a delivery situation at once). */
export function groupKeyOf(entity: EntityKey, issue: IssueKind): string {
  const family = entity.kind === "client" ? issue : "all";
  return `${entity.kind}:${entity.id}:${family}`;
}
