import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { redactString } from "@/lib/security/redact";
import { log } from "@/lib/security/log";
import { RuleInputSchema, RuleConditionSchema, RuleActionSchema, MemoryInputSchema, normalizeContent, type OperatingRule, type RuleInput, type MemoryInput } from "./schema";
import { classifyTier } from "./tiers";

/**
 * Persistence for operating rules and soft memories. All writes go through
 * the service role after the route/tool has verified the owner (aal2).
 */

const RULE_COLUMNS =
  "id, owner_id, name, description, rule_type, scope, target_system, target_monitor, target_job, conditions, action, priority, tier, enabled, pending_confirmation, source, source_quote, created_by, created_at, updated_at, last_triggered_at, trigger_count";

export function rowToRule(r: Record<string, unknown>): OperatingRule {
  const conditions = RuleConditionSchema.safeParse(r.conditions ?? {});
  const action = RuleActionSchema.safeParse(r.action ?? { type: "exclude" });
  return {
    id: String(r.id),
    owner_id: String(r.owner_id),
    name: String(r.name),
    description: (r.description as string | null) ?? undefined,
    rule_type: (r.rule_type as OperatingRule["rule_type"]) ?? "monitor_filter",
    scope: (r.scope as OperatingRule["scope"]) ?? "business",
    target_system: (r.target_system as OperatingRule["target_system"]) ?? "monitors",
    target_monitor: (r.target_monitor as string | null) ?? null,
    target_job: (r.target_job as string | null) ?? null,
    conditions: conditions.success ? conditions.data : {},
    action: action.success ? action.data : { type: "exclude" },
    priority: Number(r.priority ?? 100),
    tier: (Number(r.tier) === 2 ? 2 : 1) as 1 | 2,
    // A rule whose stored JSON fails validation is treated as disabled (fail closed).
    enabled: Boolean(r.enabled) && conditions.success && action.success,
    pending_confirmation: Boolean(r.pending_confirmation),
    source: (r.source as OperatingRule["source"]) ?? "chat",
    source_quote: (r.source_quote as string | null) ?? null,
    created_by: String(r.created_by ?? "owner"),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    last_triggered_at: (r.last_triggered_at as string | null) ?? null,
    trigger_count: Number(r.trigger_count ?? 0),
  };
}

export async function listRules(ownerId: string, opts: { enabledOnly?: boolean } = {}): Promise<OperatingRule[]> {
  const admin = createAdminClient();
  let q = admin.from("operating_rules").select(RULE_COLUMNS).eq("owner_id", ownerId).order("priority", { ascending: true }).order("created_at", { ascending: true });
  if (opts.enabledOnly) q = q.eq("enabled", true).eq("pending_confirmation", false);
  const { data, error } = await q;
  if (error) throw new Error(`rules_list_failed:${error.code ?? ""}:${redactString(error.message ?? "").slice(0, 120)}`);
  return (data ?? []).map((r) => rowToRule(r as Record<string, unknown>));
}

export async function getRule(ownerId: string, id: string): Promise<OperatingRule | null> {
  const admin = createAdminClient();
  const { data } = await admin.from("operating_rules").select(RULE_COLUMNS).eq("owner_id", ownerId).eq("id", id).maybeSingle();
  return data ? rowToRule(data as Record<string, unknown>) : null;
}

export interface CreateRuleOptions {
  source?: OperatingRule["source"];
  sourceQuote?: string | null;
  createdBy?: "owner" | "system" | "gomez";
  /** Force pending confirmation regardless of tier (used for Tier 2). */
  pendingConfirmation?: boolean;
}

export type CreateRuleResult = { ok: true; rule: OperatingRule; tier: 1 | 2; reason: string } | { ok: false; refused: true; reason: string } | { ok: false; refused?: false; reason: string };

/** Validates, tiers, and stores a rule. Tier 3 is refused; Tier 2 is stored disabled + pending. */
export async function createRule(ownerId: string, raw: unknown, opts: CreateRuleOptions = {}): Promise<CreateRuleResult> {
  const parsed = RuleInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: `invalid_rule:${parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ").slice(0, 300)}` };
  const input: RuleInput = parsed.data;
  const tier = classifyTier(input);
  if (tier.tier === 3) return { ok: false, refused: true, reason: tier.reason };
  const pending = opts.pendingConfirmation ?? tier.tier === 2;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("operating_rules")
    .insert({
      owner_id: ownerId,
      name: input.name,
      description: input.description ?? null,
      rule_type: input.rule_type,
      scope: input.scope,
      target_system: input.target_system,
      target_monitor: input.target_monitor ?? null,
      target_job: input.target_job ?? null,
      conditions: input.conditions,
      action: input.action,
      priority: input.priority,
      tier: tier.tier,
      enabled: pending ? false : input.enabled,
      pending_confirmation: pending,
      source: opts.source ?? "chat",
      source_quote: opts.sourceQuote ? redactString(opts.sourceQuote).slice(0, 500) : null,
      created_by: opts.createdBy ?? "owner",
    })
    .select(RULE_COLUMNS)
    .single();
  if (error) return { ok: false, reason: `rule_create_failed:${error.code ?? ""}` };
  return { ok: true, rule: rowToRule(data as Record<string, unknown>), tier: tier.tier, reason: tier.reason };
}

export async function updateRule(ownerId: string, id: string, patch: Partial<RuleInput> & { pending_confirmation?: boolean }): Promise<CreateRuleResult> {
  const existing = await getRule(ownerId, id);
  if (!existing) return { ok: false, reason: "rule_not_found" };
  const merged = RuleInputSchema.safeParse({
    name: patch.name ?? existing.name,
    description: patch.description ?? existing.description,
    rule_type: patch.rule_type ?? existing.rule_type,
    scope: patch.scope ?? existing.scope,
    target_system: patch.target_system ?? existing.target_system,
    target_monitor: patch.target_monitor === undefined ? existing.target_monitor : patch.target_monitor,
    target_job: patch.target_job === undefined ? existing.target_job : patch.target_job,
    conditions: patch.conditions ?? existing.conditions,
    action: patch.action ?? existing.action,
    priority: patch.priority ?? existing.priority,
    enabled: patch.enabled ?? existing.enabled,
  });
  if (!merged.success) return { ok: false, reason: `invalid_rule:${merged.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ").slice(0, 300)}` };
  const tier = classifyTier(merged.data);
  if (tier.tier === 3) return { ok: false, refused: true, reason: tier.reason };
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("operating_rules")
    .update({
      ...merged.data,
      target_monitor: merged.data.target_monitor ?? null,
      target_job: merged.data.target_job ?? null,
      description: merged.data.description ?? null,
      tier: tier.tier,
      pending_confirmation: patch.pending_confirmation ?? (patch.enabled === true ? false : existing.pending_confirmation),
    })
    .eq("owner_id", ownerId)
    .eq("id", id)
    .select(RULE_COLUMNS)
    .single();
  if (error) return { ok: false, reason: `rule_update_failed:${error.code ?? ""}` };
  return { ok: true, rule: rowToRule(data as Record<string, unknown>), tier: tier.tier, reason: tier.reason };
}

export async function deleteRule(ownerId: string, id: string): Promise<boolean> {
  const admin = createAdminClient();
  const { error, count } = await admin.from("operating_rules").delete({ count: "exact" }).eq("owner_id", ownerId).eq("id", id);
  if (error) throw new Error(`rule_delete_failed:${error.code ?? ""}`);
  return (count ?? 0) > 0;
}

export interface RuleEventInput {
  ruleId: string;
  findingId?: string | null;
  sourceItemId?: string | null;
  monitor?: string | null;
  effect: "excluded" | "reclassified" | "suppressed" | "allowed_by_exception" | "unsuppressed";
  detail?: string | null;
}

/** Batch-records rule decisions and bumps trigger counters. Never throws. */
export async function recordRuleEvents(ownerId: string, events: RuleEventInput[]): Promise<void> {
  if (!events.length) return;
  const admin = createAdminClient();
  try {
    const rows = events.slice(0, 2000).map((e) => ({
      owner_id: ownerId,
      rule_id: e.ruleId,
      finding_id: e.findingId ?? null,
      source_item_id: e.sourceItemId ?? null,
      monitor: e.monitor ?? null,
      effect: e.effect,
      detail: e.detail ? redactString(e.detail).slice(0, 200) : null,
    }));
    const { error } = await admin.from("rule_events").insert(rows);
    if (error) log.warn("rule_events_insert_failed", { message: error.message });
    const counts = new Map<string, number>();
    for (const e of events) counts.set(e.ruleId, (counts.get(e.ruleId) ?? 0) + 1);
    const now = new Date().toISOString();
    for (const [ruleId, n] of counts) {
      const { data } = await admin.from("operating_rules").select("trigger_count").eq("id", ruleId).maybeSingle();
      await admin
        .from("operating_rules")
        .update({ trigger_count: Number(data?.trigger_count ?? 0) + n, last_triggered_at: now })
        .eq("id", ruleId);
    }
  } catch (err) {
    log.warn("rule_events_failed", { message: err instanceof Error ? err.message : "unknown" });
  }
}

export async function listRuleEvents(ownerId: string, ruleId: string, limit = 20) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("rule_events")
    .select("id, effect, detail, monitor, created_at, finding_id, findings(title)")
    .eq("owner_id", ownerId)
    .eq("rule_id", ruleId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []).map((e) => ({
    id: Number(e.id),
    effect: String(e.effect),
    detail: (e.detail as string | null) ?? null,
    monitor: (e.monitor as string | null) ?? null,
    createdAt: String(e.created_at),
    findingId: (e.finding_id as string | null) ?? null,
    findingTitle: ((e as { findings?: { title?: string } | null }).findings?.title as string | undefined) ?? null,
  }));
}

/* ------------------------------------------------------------------ */
/* Memories                                                            */
/* ------------------------------------------------------------------ */

export interface Memory {
  id: string;
  content: string;
  category: MemoryInput["category"];
  scope: MemoryInput["scope"];
  source: OperatingRule["source"];
  confidence: number;
  active: boolean;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

const MEMORY_COLUMNS = "id, content, category, scope, source, confidence, active, created_at, updated_at, last_used_at";

export async function listMemories(ownerId: string, opts: { activeOnly?: boolean } = {}): Promise<Memory[]> {
  const admin = createAdminClient();
  let q = admin.from("memories").select(MEMORY_COLUMNS).eq("owner_id", ownerId).order("created_at", { ascending: false }).limit(300);
  if (opts.activeOnly) q = q.eq("active", true);
  const { data, error } = await q;
  if (error) throw new Error(`memories_list_failed:${error.code ?? ""}`);
  return (data ?? []) as Memory[];
}

/** Upserts a memory by normalized content (same idea twice → one row). */
export async function rememberMemory(ownerId: string, raw: unknown, opts: { source?: OperatingRule["source"]; sourceReference?: string } = {}): Promise<{ ok: true; memory: Memory; created: boolean } | { ok: false; reason: string }> {
  const parsed = MemoryInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: `invalid_memory:${parsed.error.issues.map((i) => i.message).join("; ").slice(0, 200)}` };
  const admin = createAdminClient();
  const normalized = normalizeContent(parsed.data.content);
  const { data: existing } = await admin.from("memories").select(MEMORY_COLUMNS).eq("owner_id", ownerId).eq("normalized_content", normalized).maybeSingle();
  if (existing) {
    const { data, error } = await admin
      .from("memories")
      .update({ content: parsed.data.content, category: parsed.data.category, scope: parsed.data.scope, confidence: parsed.data.confidence, active: true, last_used_at: new Date().toISOString() })
      .eq("id", existing.id)
      .select(MEMORY_COLUMNS)
      .single();
    if (error) return { ok: false, reason: `memory_update_failed:${error.code ?? ""}` };
    return { ok: true, memory: data as Memory, created: false };
  }
  const { data, error } = await admin
    .from("memories")
    .insert({
      owner_id: ownerId,
      content: parsed.data.content,
      normalized_content: normalized,
      category: parsed.data.category,
      scope: parsed.data.scope,
      confidence: parsed.data.confidence,
      source: opts.source ?? "chat",
      source_reference: opts.sourceReference ? redactString(opts.sourceReference).slice(0, 300) : null,
    })
    .select(MEMORY_COLUMNS)
    .single();
  if (error) return { ok: false, reason: `memory_create_failed:${error.code ?? ""}` };
  return { ok: true, memory: data as Memory, created: true };
}

export async function updateMemory(ownerId: string, id: string, patch: { content?: string; category?: MemoryInput["category"]; scope?: MemoryInput["scope"]; active?: boolean }): Promise<Memory | null> {
  const admin = createAdminClient();
  const update: Record<string, unknown> = { ...patch };
  if (patch.content) update.normalized_content = normalizeContent(patch.content);
  const { data, error } = await admin.from("memories").update(update).eq("owner_id", ownerId).eq("id", id).select(MEMORY_COLUMNS).maybeSingle();
  if (error) throw new Error(`memory_update_failed:${error.code ?? ""}`);
  return (data as Memory | null) ?? null;
}

/** Deletes by id, or by fuzzy content match (normalized substring). Returns the number removed. */
export async function forgetMemory(ownerId: string, opts: { id?: string; matching?: string }): Promise<{ removed: number; contents: string[] }> {
  const admin = createAdminClient();
  if (opts.id) {
    const { data } = await admin.from("memories").delete().eq("owner_id", ownerId).eq("id", opts.id).select("content");
    return { removed: data?.length ?? 0, contents: (data ?? []).map((d) => String(d.content)) };
  }
  if (opts.matching) {
    const needle = normalizeContent(opts.matching);
    if (needle.length < 3) return { removed: 0, contents: [] };
    const all = await listMemories(ownerId);
    const hits = all.filter((m) => normalizeContent(m.content).includes(needle) || needle.includes(normalizeContent(m.content)));
    if (!hits.length) return { removed: 0, contents: [] };
    const { data } = await admin
      .from("memories")
      .delete()
      .eq("owner_id", ownerId)
      .in(
        "id",
        hits.map((h) => h.id),
      )
      .select("content");
    return { removed: data?.length ?? 0, contents: (data ?? []).map((d) => String(d.content)) };
  }
  return { removed: 0, contents: [] };
}
