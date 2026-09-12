import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { bareAddress, classifyAuthor, domainOf } from "./engine";
import { MONITOR_LABELS, resolveMonitorId, type RuleInput } from "./schema";
import type { SourceRow } from "@/lib/jeff/monitors/types";

/**
 * "Don't show this again" → the NARROWEST reasonable rule (spec §11).
 * Never a whole-monitor mute: we always anchor on the finding's own evidence
 * (exact sender → sender domain → subject prefix → amount ceiling).
 */

export interface FindingForRule {
  id: string;
  category: string;
  title: string;
  evidence: { source_item_id: string }[];
  metrics: Record<string, unknown>;
}

export function inferNarrowRule(finding: FindingForRule, evidenceRow: SourceRow | null): RuleInput | null {
  const monitor = resolveMonitorId(finding.category) ?? null;
  const label = monitor ? MONITOR_LABELS[monitor] : "monitors";
  const base = { rule_type: "monitor_filter" as const, scope: "business" as const, target_system: "monitors" as const, target_monitor: monitor, action: { type: "exclude" as const }, priority: 100, enabled: true };
  if (evidenceRow) {
    const sender = bareAddress(evidenceRow.author);
    const authorType = classifyAuthor(evidenceRow);
    if (sender) {
      const dom = domainOf(sender);
      const generic = /^(no-?reply|noreply|notifications?|info|hello|team|support|mailer-daemon)@/.test(sender);
      // Generic mailbox → the domain is the meaningful identity; personal address → exact match.
      if (generic && dom) {
        return { ...base, name: `Ignore ${dom} notifications in ${label}`.slice(0, 140), description: `Created from "Don't show this again" on: ${finding.title}`.slice(0, 1000), conditions: { source_type: evidenceRow.resource_type as RuleInput["conditions"]["source_type"], sender_domain: [dom], ...(authorType !== "human" ? { author_type: [authorType] } : {}) } };
      }
      return { ...base, name: `Ignore ${sender} in ${label}`.slice(0, 140), description: `Created from "Don't show this again" on: ${finding.title}`.slice(0, 1000), conditions: { source_type: evidenceRow.resource_type as RuleInput["conditions"]["source_type"], sender_matches: [sender] } };
    }
    const title = (evidenceRow.title ?? "").trim();
    const prefix = title.match(/^(\[[^\]]{2,60}\]|[A-Za-z0-9 _-]{4,40}:)/)?.[1];
    if (prefix) {
      return { ...base, name: `Ignore "${prefix}" ${evidenceRow.resource_type}s in ${label}`.slice(0, 140), description: `Created from "Don't show this again" on: ${finding.title}`.slice(0, 1000), conditions: { source_type: evidenceRow.resource_type as RuleInput["conditions"]["source_type"], subject_patterns: [`^${prefix}*`] } };
    }
    const meta = evidenceRow.metadata ?? {};
    const merchant = typeof meta.merchant_name === "string" ? meta.merchant_name : typeof meta.customerId === "string" ? meta.customerId : null;
    if (merchant) {
      return { ...base, name: `Ignore ${merchant} in ${label}`.slice(0, 140), description: `Created from "Don't show this again" on: ${finding.title}`.slice(0, 1000), conditions: { source_type: evidenceRow.resource_type as RuleInput["conditions"]["source_type"], subject_patterns: [`*${merchant}*`] } };
    }
  }
  const amount = typeof finding.metrics.amount_minor === "number" ? finding.metrics.amount_minor : typeof finding.metrics.total_minor === "number" ? finding.metrics.total_minor : null;
  if (amount != null && amount > 0) {
    return { ...base, name: `Ignore ${label} under $${(amount / 100).toFixed(0)}`.slice(0, 140), description: `Created from "Don't show this again" on: ${finding.title}`.slice(0, 1000), conditions: { amount_max: amount } };
  }
  // No safe narrow anchor → do not create a rule automatically.
  return null;
}

export async function loadFindingForRule(ownerId: string, findingId: string): Promise<{ finding: FindingForRule; evidenceRow: SourceRow | null } | null> {
  const admin = createAdminClient();
  const { data: f } = await admin.from("findings").select("id, category, title, evidence, metrics").eq("owner_id", ownerId).eq("id", findingId).maybeSingle();
  if (!f) return null;
  const first = (f.evidence as { source_item_id?: string }[] | null)?.[0]?.source_item_id;
  let evidenceRow: SourceRow | null = null;
  if (first) {
    const { data: row } = await admin.from("source_items").select("id, provider, capability, resource_type, external_id, title, summary, author, source_url, source_timestamp, tags, metadata").eq("id", first).maybeSingle();
    evidenceRow = (row as SourceRow | null) ?? null;
  }
  return { finding: f as FindingForRule, evidenceRow };
}
