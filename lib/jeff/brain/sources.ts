/**
 * Client-safe mappings between providers / capabilities / tools / scan
 * stages and the brain's visual source ids (lib/jeff/sources.ts).
 * Deterministic: nothing here guesses.
 */
import { SOURCES } from "@/lib/jeff/sources";

const CAPABILITY_TO_SOURCE: Record<string, Record<string, string>> = {
  google: { gmail: "gmail", drive: "drive", calendar: "calendar" },
  meta: { ads: "metaads", pages: "facebook", instagram: "instagram" },
};

/** All visual sources for a provider (google → gmail, drive, calendar). */
export function sourcesForProvider(provider: string, capabilities?: string[] | null): string[] {
  const byCap = CAPABILITY_TO_SOURCE[provider];
  if (byCap) {
    const caps = capabilities?.length ? capabilities : Object.keys(byCap);
    return caps.map((c) => byCap[c]).filter((s): s is string => !!s);
  }
  const hits = SOURCES.filter((s) => s.provider === provider).map((s) => s.id);
  return hits.length ? hits : [];
}

/** Best single visual source for a provider + optional capability/resource. */
export function sourceForProvider(provider: string, capability?: string | null): string | null {
  const byCap = CAPABILITY_TO_SOURCE[provider];
  if (byCap && capability && byCap[capability]) return byCap[capability]!;
  const list = sourcesForProvider(provider);
  return list[0] ?? null;
}

/** Findings/alerts categories → the sources they are about. Used when evidence carries no provider. */
export const CATEGORY_SOURCES: Record<string, string[]> = {
  lead_followup_gap: ["leadconnector"],
  lead_not_contacted: ["portal", "leadconnector"],
  pipeline_aging: ["leadconnector"],
  missed_commitment: ["gmail", "slack"],
  operational_bottleneck: ["calendar"],
  attention_fragmentation: ["calendar"],
  time_allocation_mismatch: ["calendar"],
  failed_payment: ["stripe"],
  client_unpaid_invoice: ["stripe", "portal"],
  cashflow_change: ["stripe", "plaid"],
  recurring_expense_change: ["plaid", "stripe"],
  new_recurring_charge: ["plaid", "stripe"],
  duplicate_tool: ["plaid", "stripe"],
  price_increase: ["plaid", "stripe"],
  unused_software: ["plaid", "stripe"],
  annual_renewal_upcoming: ["plaid", "stripe"],
  ad_spend_change: ["metaads"],
  underperforming_acquisition: ["metaads"],
  client_ad_spend_no_leads: ["metaads", "portal"],
  automation_failure: ["n8n"],
  webhook_broken: ["portal", "n8n"],
  repeated_error: ["n8n"],
  duplicate_lead_events: ["leadconnector", "portal"],
  manual_repetition: ["gmail"],
  portal_task_overdue: ["portal"],
  portal_stage_stalled: ["portal"],
  portal_notification_failure: ["portal"],
  quiet_client: ["portal"],
  client_engagement_drop: ["portal", "gmail"],
  client_missed_meeting: ["calendar", "leadconnector"],
  client_negative_signal: ["gmail", "slack"],
  relationship_quiet: ["gmail", "calendar"],
  relationship_promise: ["gmail", "slack"],
  referral_source_declining: ["leadconnector"],
  contact_resurfaced: ["gmail"],
  important_date: ["calendar"],
  personal_project_stalled: ["notion", "calendar"],
  personal_renewal_due: ["plaid"],
  goal_trajectory: [],
  goal_coach: [],
  blind_spot: [],
  obligation: [],
};

/** Ask Jeff tool names → sources they actually read. */
export function sourcesForTools(tools: string[], connected: string[]): string[] {
  const out = new Set<string>();
  const has = (s: string) => connected.includes(s);
  for (const t of tools) {
    switch (t) {
      case "search_slack":
        if (has("slack")) out.add("slack");
        break;
      case "list_payments":
        if (has("stripe")) out.add("stripe");
        break;
      case "get_financial_summary":
        if (has("stripe")) out.add("stripe");
        if (has("plaid")) out.add("plaid");
        break;
      case "get_crm_pipeline":
        if (has("leadconnector")) out.add("leadconnector");
        break;
      case "get_calendar_context":
        if (has("calendar")) out.add("calendar");
        break;
      case "get_ad_performance":
        if (has("metaads")) out.add("metaads");
        break;
      case "search_sources":
        connected.forEach((s) => out.add(s));
        break;
      case "list_clients":
      case "get_client_overview":
        if (has("portal")) out.add("portal");
        break;
      default:
        break; // memory/rules/goals/alerts/briefings/jobs tools read Jeff's own tables, not a source
    }
  }
  return [...out];
}

/** Blind-spot scan progress stage → sources being examined (labelled "scanning", not retrieval). */
export function sourcesForScanStage(stage: string, connected: string[], goalSources: string[] = []): string[] {
  const has = (list: string[]) => list.filter((s) => connected.includes(s));
  switch (stage) {
    case "reviewing_goals":
      return has(goalSources);
    case "business_signals":
      return has(["leadconnector", "portal"]);
    case "commitments":
      return has(["gmail", "slack"]);
    case "obligations":
      return has(["calendar", "notion"]);
    case "financial":
      return has(["stripe", "plaid"]);
    case "patterns":
    case "novel":
    case "ranking":
      return connected;
    default:
      return [];
  }
}

/** Job declared provider sources → visual sources. */
export function sourcesForJob(providerSources: string[], connected: string[]): string[] {
  const out = new Set<string>();
  for (const p of providerSources) for (const s of sourcesForProvider(p)) if (connected.includes(s)) out.add(s);
  return [...out];
}
