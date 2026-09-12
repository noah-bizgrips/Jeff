import { z } from "zod";
import { MONITOR_IDS, MONITOR_LABELS, RuleInputSchema, resolveMonitorId, type RuleCondition, type RuleInput } from "./schema";

/**
 * Deterministic natural-language → rule interpretation for the common
 * feedback patterns. Pure and testable. When it cannot produce a confident
 * rule it returns `null` and the caller may fall back to a model-produced
 * `RuleInterpretation` (validated by the same Zod schema).
 */

export const RuleInterpretationSchema = z
  .object({
    kind: z.enum(["rule", "memory", "forget", "clarify", "unsupported"]),
    confidence: z.number().min(0).max(1),
    rule: RuleInputSchema.optional(),
    memory: z.object({ content: z.string().min(3).max(1000), category: z.string().max(40), scope: z.string().max(20) }).optional(),
    forget: z.object({ matching: z.string().min(2).max(300) }).optional(),
    question: z.string().max(400).optional(),
    summary: z.string().max(400),
  })
  .strict();
export type RuleInterpretation = z.infer<typeof RuleInterpretationSchema>;

const MONITOR_HINTS: [RegExp, (typeof MONITOR_IDS)[number]][] = [
  [/failed .{0,25}payment|payment.{0,12}fail|declined|past[- ]due|overdue invoice|unpaid invoice/i, "failed_payment"],
  [/open commitment|commitment|missed commitment|promise|follow[- ]?up email|deadline email/i, "missed_commitment"],
  [/lead follow|follow[- ]?up gap|quiet lead|leads? (?:that|who) (?:have|has)n't|no follow|leads? older than/i, "lead_followup_gap"],
  [/pipeline ag|stale (?:deal|opportunit)|aging/i, "pipeline_aging"],
  [/\binvoice/i, "failed_payment"],
  [/cash[- ]?flow/i, "cashflow_change"],
  [/recurring (?:expense|charge|subscription)|subscription change/i, "recurring_expense_change"],
  [/calendar|bottleneck|too many meetings|booked/i, "operational_bottleneck"],
  [/automation fail|workflow fail|n8n/i, "automation_failure"],
];

const NEGATIVE = /\b(don't|do not|dont|stop|never|no longer|quit|ignore|exclude|hide|mute|suppress|not (?:flag|show|alert|treat|include|count))\b/i;
const POSITIVE_EXCEPTION = /\b(actually|but|except|still|do want|i want to (?:be )?(?:alerted|notified|see)|start showing|show me|alert me (?:about|when|if)|notify me)\b/i;
const MEMORY_CUE = /^(?:please )?(?:remember|note|keep in mind|for future reference|fyi:?|i prefer|i like|i don't like|i consider|i think of|treat .* as|my (?:preference|rule of thumb) is)/i;
const FORGET_CUE = /^(?:please )?(?:forget|delete|remove|drop)\b(?: that| the)? (?:preference|memory|rule|note)?/i;

function moneyToMinor(text: string): { min?: number; max?: number } | null {
  const m = text.match(/\b(under|below|less than|smaller than|up to|over|above|more than|greater than|at least|worth (?:more|less) than)\s+\$?\s?([\d,]+(?:\.\d{1,2})?)\s*(k)?\b/i);
  if (!m) return null;
  let amount = Number(m[2]!.replace(/,/g, ""));
  if (m[3]) amount *= 1000;
  const minor = Math.round(amount * 100);
  const op = m[1]!.toLowerCase();
  if (/under|below|less|smaller|up to|worth less/.test(op)) return { max: minor };
  return { min: minor };
}

function senderConditions(text: string): Partial<RuleCondition> {
  const cond: Partial<RuleCondition> = {};
  const emails = [...text.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)].map((m) => m[0].toLowerCase());
  if (emails.length) cond.sender_matches = [...new Set(emails)];
  if (/\b(github|git ?repo(?:sitory)?|repo(?:sitory)? (?:changes?|notifications?|updates?)|pull requests?)\b/i.test(text)) {
    cond.sender_matches = [...new Set([...(cond.sender_matches ?? []), "notifications@github.com", "noreply@github.com", "*@github.com"])];
    cond.author_type = ["bot", "system"];
  } else if (/\b(bot|automated|notification emails?|system emails?|automatic)\b/i.test(text)) {
    cond.author_type = ["bot", "system"];
  }
  const domain = text.match(/\bfrom\s+(?:@|the domain\s+)?([a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2,})?)\b/i);
  if (domain && !emails.length) cond.sender_domain = [domain[1]!.toLowerCase()];
  if (/\b(vercel)\b/i.test(text)) cond.sender_domain = [...new Set([...(cond.sender_domain ?? []), "vercel.com"])];
  if (/\b(slack notification|slack email)/i.test(text)) cond.sender_domain = [...new Set([...(cond.sender_domain ?? []), "slack.com"])];
  return cond;
}

function sourceType(text: string): RuleCondition["source_type"] | undefined {
  if (/\b(email|emails|inbox|mail)\b/i.test(text)) return "email";
  if (/\b(invoice)s?\b/i.test(text)) return "invoice";
  if (/\b(charge|payment)s?\b/i.test(text)) return "charge";
  if (/\btransaction/i.test(text)) return "transaction";
  if (/\b(calendar|event|meeting)s?\b/i.test(text)) return "event";
  if (/\b(opportunit|deal|lead)/i.test(text)) return "opportunity";
  return undefined;
}

function guessMonitor(text: string): (typeof MONITOR_IDS)[number] | null {
  for (const [re, id] of MONITOR_HINTS) if (re.test(text)) return id;
  const direct = text.match(/\b([a-z_]+)\s+monitor\b/i);
  if (direct) return resolveMonitorId(direct[1]);
  return null;
}

function titleCase(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function describeConditions(c: Partial<RuleCondition>): string {
  const parts: string[] = [];
  if (/github/.test(JSON.stringify(c.sender_matches ?? []))) parts.push("GitHub repo notifications");
  else if (c.sender_matches?.length) parts.push(`emails from ${c.sender_matches.join(", ")}`);
  else if (c.sender_domain?.length) parts.push(`emails from ${c.sender_domain.join(", ")}`);
  else if (c.author_type?.length) parts.push(`${c.author_type.join("/")} notifications`);
  if (c.subject_patterns?.length) parts.push(`subjects matching "${c.subject_patterns.join('", "')}"`);
  if (c.amount_max != null) parts.push(`under $${(c.amount_max / 100).toLocaleString()}`);
  if (c.amount_min != null) parts.push(`over $${(c.amount_min / 100).toLocaleString()}`);
  if (c.tags_any?.length) parts.push(`tagged ${c.tags_any.join(", ")}`);
  return parts.join(" ");
}

/**
 * Returns a structured interpretation of an owner sentence, or null when the
 * deterministic parser is not confident.
 */
export function interpretFeedback(text: string): RuleInterpretation | null {
  const t = text.trim();
  if (!t) return null;

  if (FORGET_CUE.test(t)) {
    const matching = t.replace(FORGET_CUE, "").replace(/^(?:that|about|the)\s+/i, "").replace(/[.!]+$/, "").trim();
    if (matching.length >= 2) return { kind: "forget", confidence: 0.8, forget: { matching }, summary: `Forget the memory matching "${matching}".` };
    return { kind: "clarify", confidence: 0.4, question: "Which memory or preference should I forget?", summary: "Ambiguous forget request." };
  }

  const monitor = guessMonitor(t);
  const negative = NEGATIVE.test(t);
  // "Never alert me about…" is a suppression; "Actually, alert me about…" is an exception.
  const exception = POSITIVE_EXCEPTION.test(t) && (!negative || /^\s*(actually|but|except|still)\b/i.test(t));
  const money = moneyToMinor(t);
  const senders = senderConditions(t);
  const src = sourceType(t);
  const hasPattern = !!(senders.sender_matches?.length || senders.sender_domain?.length || senders.author_type?.length || money);

  // Briefing preferences → memory (soft) since briefing engine is a later phase.
  if (/\b(briefs?|briefings?|reports?|summar(?:y|ies)|updates?)\b/i.test(t) && /\b(short|concise|no more than|at most|max(?:imum)?|fewer|bullets?|items?|high[- ]level|detail)\b/i.test(t)) {
    return { kind: "memory", confidence: 0.85, memory: { content: t.replace(/^(?:remember|note) (?:that )?/i, "").replace(/[.!]+$/, ""), category: "communication_style", scope: "all" }, summary: "Stored as a communication preference for briefings and reports." };
  }

  // Exception: re-include something specific, escalate importance.
  if (exception && (monitor || hasPattern)) {
    const conditions: RuleCondition = { ...senders, ...(src ? { source_type: src } : {}) };
    const subjectHints: string[] = [];
    if (/deploy/i.test(t)) subjectHints.push("*deploy*");
    if (/fail/i.test(t)) subjectHints.push("*fail*");
    if (/security|secret|vulnerab/i.test(t)) subjectHints.push("*security*");
    if (subjectHints.length) conditions.subject_patterns = subjectHints;
    if (money?.min != null) conditions.amount_min = money.min;
    const escalate = /\balert|notify|important|urgent|immediately\b/i.test(t);
    const rule: RuleInput = RuleInputSchema.parse({
      name: `Always ${escalate ? "alert on" : "include"} ${describeConditions(conditions) || "matching items"}${monitor ? ` in ${MONITOR_LABELS[monitor]}` : ""}`.slice(0, 140),
      description: t.slice(0, 1000),
      rule_type: escalate ? "alert_policy" : "monitor_filter",
      target_system: "monitors",
      target_monitor: monitor,
      conditions,
      action: escalate ? { type: "include" } : { type: "include" },
      priority: 10,
    });
    const escalation: RuleInput | null = escalate ? RuleInputSchema.parse({ ...rule, name: `${rule.name} → important`.slice(0, 140), rule_type: "alert_policy", action: { type: "escalate", level: /urgent|immediately/i.test(t) ? "urgent" : "important" }, priority: 11 }) : null;
    return { kind: "rule", confidence: 0.8, rule, summary: `Exception: ${rule.name}.${escalation ? " Marked important." : ""}` };
  }

  // Suppression / exclusion.
  if (negative && (monitor || hasPattern)) {
    const conditions: RuleCondition = { ...senders };
    if (src) conditions.source_type = src;
    if (money?.max != null) conditions.amount_max = money.max;
    if (money?.min != null) conditions.amount_min = money.min;
    if (/\b(optional)\b/i.test(t) && (src === "event" || monitor === "operational_bottleneck")) conditions.tags_any = ["optional"];
    if (/\btest (?:transaction|payment|charge|mode)/i.test(t)) conditions.metadata_equals = { livemode: false };
    if (/\blow[- ]confidence\b/i.test(t)) {
      const n = t.match(/(0?\.\d+)/);
      const value = n ? Number(n[1]) : 0.45;
      const rule = RuleInputSchema.parse({ name: `Require confidence ≥ ${value}${monitor ? ` in ${MONITOR_LABELS[monitor]}` : ""}`, description: t.slice(0, 1000), target_monitor: monitor, conditions: {}, action: { type: "require_min_confidence", value } });
      return { kind: "rule", confidence: 0.75, rule, summary: rule.name };
    }
    const alertOnly = /\b(alert|notify|ping|interrupt)\b/i.test(t) && !/\b(flag|show|treat|list|include|count)\b/i.test(t);
    const rule = RuleInputSchema.parse({
      name: titleCase(`${alertOnly ? "don't alert on" : "ignore"} ${describeConditions(conditions) || "matching items"}${monitor ? ` in ${MONITOR_LABELS[monitor]}` : ""}`).slice(0, 140),
      description: t.slice(0, 1000),
      rule_type: alertOnly ? "alert_policy" : "monitor_filter",
      target_system: alertOnly ? "alerts" : "monitors",
      target_monitor: monitor,
      conditions,
      action: alertOnly ? { type: "suppress_alert" } : { type: "exclude" },
    });
    return { kind: "rule", confidence: hasPattern ? 0.85 : 0.6, rule, summary: rule.name };
  }

  if (MEMORY_CUE.test(t)) {
    const content = t.replace(/^(?:please )?(?:remember|note|keep in mind|for future reference|fyi:?)\s*(?:that\s+)?/i, "").replace(/[.!]+$/, "").trim();
    const category = /\bprefer|like|want\b/i.test(content) ? "preference" : /\bconsider|is not|isn't|means|counts? as|define/i.test(content) ? "definition" : /\bpriorit|important|matters?\b/i.test(content) ? "priority" : /\bdon't like|hate|annoy|noise\b/i.test(content) ? "dislike" : "business_context";
    const scope = /\bpersonal|family|home|health\b/i.test(content) ? "personal" : /\bmoney|finance|revenue|cash|expense|budget\b/i.test(content) ? "financial" : "business";
    return { kind: "memory", confidence: 0.8, memory: { content, category, scope }, summary: `Remembered: ${content}` };
  }

  if (negative && !monitor && !hasPattern) {
    return { kind: "clarify", confidence: 0.4, question: "Which monitor or pattern should this apply to? For example: GitHub notification emails in Open commitments, or failed payments under $50.", summary: "Too broad to apply safely." };
  }
  return null;
}
