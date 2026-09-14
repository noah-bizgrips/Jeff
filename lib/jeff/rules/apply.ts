import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorMessage, log } from "@/lib/security/log";
import { matchesRule, subjectFromCandidate, type MatchSubject, type SubjectContext } from "./engine";
import { decide } from "./precedence";
import { getRule, listRules, recordRuleEvents, createRule } from "./store";
import type { OperatingRule } from "./schema";
import { loadClientLeadIndex } from "@/lib/jeff/clients/client-leads-store";
import type { CandidateFinding, EvidenceRef, SourceRow } from "@/lib/jeff/monitors/types";

/**
 * Applying rules to EXISTING findings (retroactive reprocessing) and undoing
 * that. Historical evidence is never deleted; findings move to
 * `suppressed_by_rule` with a pointer to the rule and their previous status,
 * so the change is reversible and explainable.
 */

const ACTIVE_STATUSES = ["new", "open", "reviewing", "accepted", "acknowledged", "in_progress", "monitoring", "action_planned", "action_in_progress"];

interface FindingRow {
  id: string;
  category: string;
  title: string;
  status: string;
  confidence: number | null;
  severity: "info" | "low" | "medium" | "high";
  evidence: EvidenceRef[];
  metrics: Record<string, unknown>;
}

async function loadActiveFindings(ownerId: string): Promise<FindingRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("findings").select("id, category, title, status, confidence, severity, evidence, metrics").eq("owner_id", ownerId).in("status", ACTIVE_STATUSES).limit(2000);
  if (error) throw new Error(`findings_load_failed:${error.code ?? ""}`);
  return (data ?? []) as FindingRow[];
}

async function loadEvidenceRows(ids: string[]): Promise<Map<string, SourceRow>> {
  const map = new Map<string, SourceRow>();
  if (!ids.length) return map;
  const admin = createAdminClient();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await admin
      .from("source_items")
      .select("id, provider, capability, resource_type, external_id, title, summary, author, source_url, source_timestamp, tags, metadata")
      .in("id", ids.slice(i, i + 200));
    for (const r of data ?? []) map.set(r.id, r as SourceRow);
  }
  return map;
}

/** Builds a match subject for a stored finding from its first evidence record. */
export function subjectFromFindingRow(f: FindingRow, rows: Map<string, SourceRow>, ctx: SubjectContext = {}): MatchSubject {
  const candidate: CandidateFinding = {
    fingerprint: "",
    category: f.category as CandidateFinding["category"],
    title: f.title,
    observed_facts: [],
    metrics: f.metrics ?? {},
    interpretation: "",
    evidence: f.evidence ?? [],
    range_start: null,
    range_end: null,
    confidence: f.confidence ?? 0,
    limitations: "",
    severity: f.severity,
    proposed_mission: null,
  };
  return subjectFromCandidate(candidate, rows, ctx);
}

/**
 * Suppresses every active finding that an `exclude`/`suppress_alert` rule
 * matches — but only where the full rule set still decides "excluded", so a
 * more specific `include` exception keeps its findings visible.
 */
export async function reprocessFindingsForRule(ownerId: string, ruleId: string): Promise<{ suppressed: number; findingIds: string[] }> {
  const rule = await getRule(ownerId, ruleId);
  if (!rule || !rule.enabled) return { suppressed: 0, findingIds: [] };
  if (rule.action.type !== "exclude" && rule.action.type !== "suppress_alert") return { suppressed: 0, findingIds: [] };
  const allRules = await listRules(ownerId, { enabledOnly: true });
  const findings = await loadActiveFindings(ownerId);
  const rows = await loadEvidenceRows(findings.flatMap((f) => (f.evidence ?? []).slice(0, 1).map((e) => e.source_item_id)));
  // Only rules that look at client leads need the (portal ↔ CRM) index.
  const ctx: SubjectContext = allRules.some((r) => r.conditions.client_lead != null) ? { clientLeads: await loadClientLeadIndex(ownerId).catch(() => null) } : {};
  const admin = createAdminClient();
  const hits: string[] = [];
  const events: Parameters<typeof recordRuleEvents>[1] = [];
  for (const f of findings) {
    const subject = subjectFromFindingRow(f, rows, ctx);
    if (!matchesRule(rule, subject)) continue;
    const verdict = decide(allRules, subject);
    if (rule.action.type === "exclude" && (!verdict.excluded || verdict.decidedBy?.id !== rule.id)) {
      if (verdict.decidedBy && verdict.decidedBy.id !== rule.id && verdict.decidedBy.action.type === "include") {
        events.push({ ruleId: verdict.decidedBy.id, findingId: f.id, monitor: f.category, effect: "allowed_by_exception", detail: `kept by "${verdict.decidedBy.name}"` });
      }
      continue;
    }
    const { error } = await admin
      .from("findings")
      .update({ status: "suppressed_by_rule", suppressed_by_rule_id: rule.id, suppressed_at: new Date().toISOString(), previous_status: f.status })
      .eq("id", f.id)
      .eq("owner_id", ownerId);
    if (error) {
      log.warn("finding_suppress_failed", { findingId: f.id, message: error.message });
      continue;
    }
    hits.push(f.id);
    events.push({ ruleId: rule.id, findingId: f.id, monitor: f.category, effect: "suppressed", detail: f.title.slice(0, 120) });
  }
  await recordRuleEvents(ownerId, events);
  return { suppressed: hits.length, findingIds: hits };
}

/** Restores findings suppressed by a rule to their previous active status. */
export async function undoRuleSuppression(ownerId: string, ruleId: string): Promise<{ restored: number }> {
  const admin = createAdminClient();
  const { data } = await admin.from("findings").select("id, previous_status, title, category").eq("owner_id", ownerId).eq("suppressed_by_rule_id", ruleId).eq("status", "suppressed_by_rule");
  let restored = 0;
  const events: Parameters<typeof recordRuleEvents>[1] = [];
  for (const f of data ?? []) {
    const status = f.previous_status && ACTIVE_STATUSES.includes(f.previous_status) ? f.previous_status : "open";
    const { error } = await admin.from("findings").update({ status, suppressed_by_rule_id: null, suppressed_at: null, previous_status: null }).eq("id", f.id);
    if (!error) {
      restored++;
      events.push({ ruleId, findingId: f.id, monitor: f.category, effect: "unsuppressed", detail: String(f.title).slice(0, 120) });
    }
  }
  await recordRuleEvents(ownerId, events);
  return { restored };
}

/** Explains why a finding is suppressed/excluded, from the rule trace. */
export async function explainFinding(ownerId: string, findingId: string) {
  const admin = createAdminClient();
  const { data: f } = await admin.from("findings").select("id, title, status, suppressed_by_rule_id, suppressed_at").eq("owner_id", ownerId).eq("id", findingId).maybeSingle();
  if (!f) return null;
  const { data: events } = await admin.from("rule_events").select("effect, detail, created_at, operating_rules(name, created_at)").eq("owner_id", ownerId).eq("finding_id", findingId).order("created_at", { ascending: false }).limit(10);
  const rule = f.suppressed_by_rule_id ? await getRule(ownerId, f.suppressed_by_rule_id) : null;
  return {
    finding: { id: f.id, title: f.title, status: f.status },
    suppressedBy: rule ? { id: rule.id, name: rule.name, createdAt: rule.created_at, source: rule.source } : null,
    events: (events ?? []).map((e) => ({
      effect: e.effect,
      detail: e.detail,
      at: e.created_at,
      rule: (e as { operating_rules?: { name?: string; created_at?: string } | null }).operating_rules?.name ?? null,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Seeded system rules                                                 */
/* ------------------------------------------------------------------ */

export const GITHUB_NOTIFICATION_RULE_NAME = "Ignore GitHub repo notifications in Open commitments";
export const CLIENT_LEAD_RULE_NAME = "Client leads are the client's responsibility — don't flag follow-ups for leads that belong to a client portal client";
/** Monitors the client-lead rule silences: follow-up nagging, not client-health or ad-spend accounting. */
export const CLIENT_LEAD_RULE_MONITORS = ["lead_followup_gap", "pipeline_aging", "lead_not_contacted", "missed_commitment"] as const;

const SYSTEM_RULE_SEEDS: { name: string; input: Record<string, unknown>; reprocess: boolean }[] = [
  {
    name: GITHUB_NOTIFICATION_RULE_NAME,
    reprocess: false,
    input: {
      name: GITHUB_NOTIFICATION_RULE_NAME,
      description: "Repository notification emails (pull requests, issues, deployments, bot activity) are operational noise, not human commitments. Work happens in GitHub, not in an email reply.",
      rule_type: "monitor_filter",
      scope: "business",
      target_system: "monitors",
      target_monitor: "missed_commitment",
      conditions: { source_type: "email", sender_matches: ["notifications@github.com", "noreply@github.com", "*@github.com"], author_type: ["bot", "system"] },
      action: { type: "exclude" },
      priority: 50,
      enabled: true,
    },
  },
  {
    name: CLIENT_LEAD_RULE_NAME,
    reprocess: true,
    input: {
      name: CLIENT_LEAD_RULE_NAME,
      description:
        "A lead that came in through a client's lead sources (a homeowner wanting a bathroom) is the client's to follow up, not yours. Jeff only applies this to leads it can trace to a client portal record (portal lead ↔ HighLevel contact id, hashed email, phone + client, or a lead-source routing key); agency leads — people who might hire BizGrips — are still flagged. Disable this rule to be nagged about client leads again.",
      rule_type: "monitor_filter",
      scope: "business",
      target_system: "monitors",
      target_monitor: null,
      conditions: { client_lead: true, monitors: [...CLIENT_LEAD_RULE_MONITORS] },
      action: { type: "exclude" },
      priority: 50,
      enabled: true,
    },
  },
];

/**
 * Creates the default Tier-1 system rules once per owner so the built-in
 * behaviour is visible and editable in Memory & Rules. Idempotent by name; a
 * rule the owner disabled stays disabled. Rules flagged `reprocess` suppress
 * matching findings the first time they are seeded.
 */
export async function ensureSystemRules(ownerId: string, existing?: OperatingRule[]): Promise<OperatingRule[]> {
  let rules = existing ?? (await listRules(ownerId));
  for (const seed of SYSTEM_RULE_SEEDS) {
    if (rules.some((r) => r.created_by === "system" && r.name === seed.name)) continue;
    const res = await createRule(ownerId, seed.input, { source: "system", createdBy: "system" });
    if (!res.ok) {
      log.warn("system_rule_seed_failed", { name: seed.name.slice(0, 40), reason: res.reason });
      continue;
    }
    rules = [...rules, res.rule];
    if (seed.reprocess) {
      try {
        const { suppressed } = await reprocessFindingsForRule(ownerId, res.rule.id);
        log.info("system_rule_seeded", { name: seed.name.slice(0, 40), suppressed });
      } catch (err) {
        log.warn("system_rule_reprocess_failed", { name: seed.name.slice(0, 40), message: errorMessage(err) });
      }
    }
  }
  return rules;
}
