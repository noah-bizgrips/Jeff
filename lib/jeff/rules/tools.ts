import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { audit } from "@/lib/audit";
import { redactString } from "@/lib/security/redact";
import { interpretFeedback, RuleInterpretationSchema } from "./interpret";
import { describeRule, MONITOR_IDS, MONITOR_LABELS, RuleInputSchema, resolveMonitorId } from "./schema";
import { createRule, forgetMemory, getRule, listMemories, listRules, rememberMemory, updateRule } from "./store";
import { explainFinding, reprocessFindingsForRule, undoRuleSuppression } from "./apply";
import { detectConflicts } from "./conflicts";
import { classifyTier } from "./tiers";

/**
 * Ask Jeff tools for memories and operating rules. These are the only way
 * the model can change Jeff's behaviour, and every change goes through the
 * same validation, tiering and audit as the UI.
 */

export interface MemoryRuleToolContext {
  ownerId: string;
}

const RULE_JSON_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", maxLength: 140 },
    description: { type: "string", maxLength: 1000 },
    rule_type: { type: "string", enum: ["monitor_filter", "alert_policy", "briefing_pref", "classification"] },
    scope: { type: "string", enum: ["business", "personal", "financial", "all"] },
    target_system: { type: "string", enum: ["monitors", "alerts", "briefings", "chat"] },
    target_monitor: { type: ["string", "null"], description: `One of ${MONITOR_IDS.join(", ")} (aliases like open_commitments accepted) or null for all monitors` },
    conditions: {
      type: "object",
      properties: {
        source_type: { type: "string", enum: ["email", "message", "contact", "opportunity", "event", "file", "charge", "invoice", "transaction", "subscription", "any"] },
        provider: { type: "string" },
        sender_matches: { type: "array", items: { type: "string" }, description: "exact addresses, *@domain, or bare domains" },
        sender_domain: { type: "array", items: { type: "string" } },
        author_type: { type: "array", items: { type: "string", enum: ["human", "bot", "system"] } },
        subject_patterns: { type: "array", items: { type: "string" }, description: "case-insensitive substrings; * wildcard allowed" },
        tags_any: { type: "array", items: { type: "string" } },
        metadata_equals: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } },
        amount_min: { type: "integer", description: "minor units (cents)" },
        amount_max: { type: "integer", description: "minor units (cents)" },
        confidence_max: { type: "number" },
        category: { type: "string" },
        severity_min: { type: "string", enum: ["info", "low", "medium", "high"] },
      },
      additionalProperties: false,
    },
    action: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["exclude", "include", "set_severity", "set_importance", "suppress_alert", "require_min_confidence", "escalate"] },
        severity: { type: "string", enum: ["info", "low", "medium", "high"] },
        level: { type: "string", enum: ["informational", "briefing", "important", "urgent", "actionable"] },
        value: { type: "number" },
      },
      required: ["type"],
      additionalProperties: false,
    },
    priority: { type: "integer" },
  },
  required: ["name", "conditions", "action"],
  additionalProperties: false,
} as const;

export const MEMORY_RULE_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "remember_preference",
    description:
      "Stores a durable soft memory about how the owner thinks, works, prioritises or wants Jeff to behave (e.g. 'prefers reports under 10 bullets', 'pipeline value is not revenue'). Use for 'remember that…' statements and preferences that are not deterministic rules.",
    input_schema: {
      type: "object",
      properties: {
        content: { type: "string", maxLength: 1000 },
        category: { type: "string", enum: ["preference", "definition", "working_style", "priority", "dislike", "business_context", "personal_context", "communication_style", "exception"] },
        scope: { type: "string", enum: ["business", "personal", "financial", "all"] },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
  {
    name: "forget_memory",
    description: "Deletes a stored memory/preference by id or by matching text ('forget that I prefer…').",
    input_schema: { type: "object", properties: { id: { type: "string" }, matching: { type: "string", maxLength: 300 } }, additionalProperties: false },
  },
  {
    name: "list_memories",
    description: "Lists what Jeff remembers about the owner (preferences, definitions, priorities, dislikes).",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: "list_rules",
    description: "Lists the owner's operating rules (name, target monitor, conditions summary, enabled, trigger count) and any rule conflicts.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: "interpret_rule",
    description:
      "Turns behavioural feedback in natural language ('stop flagging GitHub emails as commitments', 'never alert me about failed payments under $50', 'actually, alert me about failed production deploys') into a proposed structured operating rule, memory, or forget request. ALWAYS call this first for feedback about what Jeff should or should not show/flag/alert; then call apply_rule with the returned rule. Pass the owner's exact sentence.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", maxLength: 2000, description: "The owner's exact words" },
        proposed_rule: { ...RULE_JSON_SCHEMA, description: "Optional: your own structured interpretation if the sentence is unusual; it will be validated and tiered." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "apply_rule",
    description:
      "Creates an operating rule. Tier 1 (safe/reversible) rules are applied immediately and existing matching findings are moved to suppressed_by_rule; Tier 2 rules are stored pending the owner's confirmation; Tier 3 (security/approvals/secrets/money) are refused. Returns exactly what changed so you can tell the owner.",
    input_schema: {
      type: "object",
      properties: { rule: RULE_JSON_SCHEMA, source_quote: { type: "string", maxLength: 500 }, confirmed: { type: "boolean", description: "true when the owner has explicitly confirmed a Tier 2 rule" } },
      required: ["rule"],
      additionalProperties: false,
    },
  },
  {
    name: "update_rule",
    description: "Enables, disables, confirms (Tier 2), or edits an existing rule by id. Use 'undo' to restore findings a rule suppressed.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        enabled: { type: "boolean" },
        confirm: { type: "boolean" },
        undo_suppression: { type: "boolean" },
        name: { type: "string", maxLength: 140 },
        conditions: RULE_JSON_SCHEMA.properties.conditions,
        action: RULE_JSON_SCHEMA.properties.action,
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "explain_finding_decision",
    description: "Explains why a finding was suppressed/excluded: which rule matched, when it was created, and the trace of rule events.",
    input_schema: { type: "object", properties: { finding_id: { type: "string" } }, required: ["finding_id"], additionalProperties: false },
  },
];

function ruleSummary(r: Awaited<ReturnType<typeof listRules>>[number]) {
  return {
    id: r.id,
    name: r.name,
    summary: describeRule(r),
    target_monitor: r.target_monitor ? (MONITOR_LABELS[resolveMonitorId(r.target_monitor) ?? "missed_commitment"] ?? r.target_monitor) : "all monitors",
    enabled: r.enabled,
    pending_confirmation: r.pending_confirmation,
    tier: r.tier,
    source: r.source,
    created_at: r.created_at,
    trigger_count: r.trigger_count,
    last_triggered_at: r.last_triggered_at,
  };
}

/** Returns undefined when the tool name is not one of ours. */
export async function runMemoryRuleTool(name: string, input: Record<string, unknown>, ctx: MemoryRuleToolContext): Promise<unknown> {
  switch (name) {
    case "remember_preference": {
      const res = await rememberMemory(ctx.ownerId, { content: input.content, category: input.category ?? "preference", scope: input.scope ?? "business" }, { source: "chat" });
      if (!res.ok) return { error: res.reason };
      await audit({ event: "memory_created", ownerId: ctx.ownerId, targetId: res.memory.id, metadata: { category: res.memory.category, scope: res.memory.scope, created: res.created } });
      return { stored: { id: res.memory.id, content: res.memory.content, category: res.memory.category, scope: res.memory.scope }, created: res.created, note: "Visible and editable under Memory & Rules." };
    }
    case "forget_memory": {
      const res = await forgetMemory(ctx.ownerId, { id: typeof input.id === "string" ? input.id : undefined, matching: typeof input.matching === "string" ? input.matching : undefined });
      if (res.removed) await audit({ event: "memory_deleted", ownerId: ctx.ownerId, metadata: { removed: res.removed } });
      return { removed: res.removed, contents: res.contents };
    }
    case "list_memories": {
      const items = await listMemories(ctx.ownerId, { activeOnly: true });
      return { memories: items.map((m) => ({ id: m.id, content: m.content, category: m.category, scope: m.scope, source: m.source, created_at: m.created_at })) };
    }
    case "list_rules": {
      const rules = await listRules(ctx.ownerId);
      return { rules: rules.map(ruleSummary), conflicts: detectConflicts(rules) };
    }
    case "interpret_rule": {
      const text = String(input.text ?? "").slice(0, 2000);
      const deterministic = interpretFeedback(text);
      if (deterministic) return { interpretation: deterministic, tier: deterministic.rule ? classifyTier(deterministic.rule) : undefined };
      if (input.proposed_rule && typeof input.proposed_rule === "object") {
        const parsed = RuleInputSchema.safeParse(input.proposed_rule);
        if (!parsed.success) return { interpretation: { kind: "clarify", confidence: 0.3, question: `The proposed rule was invalid: ${parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ").slice(0, 200)}`, summary: "invalid proposed rule" } };
        const interp = RuleInterpretationSchema.parse({ kind: "rule", confidence: 0.6, rule: parsed.data, summary: describeRule(parsed.data) });
        return { interpretation: interp, tier: classifyTier(parsed.data) };
      }
      return {
        interpretation: { kind: "clarify", confidence: 0.3, question: "I couldn't map that to a specific monitor or pattern. Which monitor (e.g. Open commitments, Failed payments) and which pattern (sender, subject, amount) should it apply to?", summary: "needs clarification" },
        hint: "You may call interpret_rule again with a proposed_rule once the owner clarifies.",
      };
    }
    case "apply_rule": {
      const raw = input.rule;
      const confirmed = input.confirmed === true;
      const parsed = RuleInputSchema.safeParse(raw);
      if (!parsed.success) return { error: "invalid_rule", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 10) };
      const tier = classifyTier(parsed.data);
      if (tier.tier === 3) {
        await audit({ event: "rule_refused", ownerId: ctx.ownerId, metadata: { name: parsed.data.name, reason: tier.reason } });
        return { refused: true, reason: tier.reason };
      }
      const res = await createRule(ctx.ownerId, parsed.data, { source: "chat", sourceQuote: typeof input.source_quote === "string" ? input.source_quote : null, createdBy: "owner", pendingConfirmation: tier.tier === 2 && !confirmed });
      if (!res.ok) return { error: res.reason, refused: res.refused ?? false };
      await audit({ event: "rule_created", ownerId: ctx.ownerId, targetId: res.rule.id, metadata: { name: res.rule.name, tier: res.tier, target_monitor: res.rule.target_monitor, pending: res.rule.pending_confirmation } });
      if (res.rule.pending_confirmation) {
        return { created: ruleSummary(res.rule), applied: false, needs_confirmation: true, reason: tier.reason, question: `${tier.reason} Should I enable "${res.rule.name}"?` };
      }
      let reprocessed = { suppressed: 0, findingIds: [] as string[] };
      if (res.rule.action.type === "exclude" || res.rule.action.type === "suppress_alert") {
        reprocessed = await reprocessFindingsForRule(ctx.ownerId, res.rule.id);
        if (reprocessed.suppressed) await audit({ event: "findings_reprocessed", ownerId: ctx.ownerId, targetId: res.rule.id, metadata: { suppressed: reprocessed.suppressed } });
      }
      return {
        created: ruleSummary(res.rule),
        applied: true,
        reprocessed_findings: reprocessed.suppressed,
        note: `Rule "${res.rule.name}" is active on ${res.rule.target_monitor ? MONITOR_LABELS[resolveMonitorId(res.rule.target_monitor) ?? "missed_commitment"] : "all monitors"}. ${reprocessed.suppressed} existing finding(s) moved to suppressed_by_rule (reversible). The owner can review or change it under Memory & Rules.`,
      };
    }
    case "update_rule": {
      const id = String(input.id ?? "");
      const existing = await getRule(ctx.ownerId, id);
      if (!existing) return { error: "rule_not_found" };
      if (input.undo_suppression === true) {
        const r = await undoRuleSuppression(ctx.ownerId, id);
        await audit({ event: "rule_updated", ownerId: ctx.ownerId, targetId: id, metadata: { undo_suppression: true, restored: r.restored } });
        return { restored: r.restored };
      }
      const patch: Record<string, unknown> = {};
      if (typeof input.enabled === "boolean") patch.enabled = input.enabled;
      if (input.confirm === true) {
        patch.enabled = true;
        patch.pending_confirmation = false;
      }
      if (typeof input.name === "string") patch.name = input.name;
      if (input.conditions && typeof input.conditions === "object") patch.conditions = input.conditions;
      if (input.action && typeof input.action === "object") patch.action = input.action;
      const res = await updateRule(ctx.ownerId, id, patch);
      if (!res.ok) return { error: res.reason, refused: res.refused ?? false };
      await audit({ event: res.rule.enabled ? "rule_updated" : "rule_disabled", ownerId: ctx.ownerId, targetId: id, metadata: { enabled: res.rule.enabled, confirmed: input.confirm === true } });
      let reprocessed = 0;
      if (res.rule.enabled && !existing.enabled && (res.rule.action.type === "exclude" || res.rule.action.type === "suppress_alert")) {
        reprocessed = (await reprocessFindingsForRule(ctx.ownerId, id)).suppressed;
      }
      return { rule: ruleSummary(res.rule), reprocessed_findings: reprocessed };
    }
    case "explain_finding_decision": {
      const r = await explainFinding(ctx.ownerId, String(input.finding_id ?? ""));
      if (!r) return { error: "finding_not_found" };
      return redactString(JSON.stringify(r)) ? r : r;
    }
    default:
      return undefined;
  }
}
