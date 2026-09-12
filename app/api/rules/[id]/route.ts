import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { deleteRule, getRule, listRuleEvents, updateRule } from "@/lib/jeff/rules/store";
import { reprocessFindingsForRule, undoRuleSuppression } from "@/lib/jeff/rules/apply";
import { presentRule } from "@/lib/jeff/rules/present";
import { RuleActionSchema, RuleConditionSchema, RuleTypeSchema, ScopeSchema } from "@/lib/jeff/rules/schema";

export const dynamic = "force-dynamic";

const Id = z.string().uuid();

export const GET = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  if (!Id.safeParse(id).success) return apiError("invalid_id", 400);
  const rule = await getRule(g.session.userId, id!);
  if (!rule) return apiError("rule_not_found", 404);
  const events = await listRuleEvents(g.session.userId, id!, 20);
  return json({ rule: presentRule(rule), events });
});

const Patch = z
  .object({
    name: z.string().trim().min(3).max(140).optional(),
    description: z.string().trim().max(1000).optional(),
    rule_type: RuleTypeSchema.optional(),
    scope: ScopeSchema.optional(),
    target_monitor: z.string().max(60).nullable().optional(),
    conditions: RuleConditionSchema.optional(),
    action: RuleActionSchema.optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    enabled: z.boolean().optional(),
    confirm: z.boolean().optional(),
  })
  .strict();

export const PATCH = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  if (!Id.safeParse(id).success) return apiError("invalid_id", 400);
  const body = await parseBody(req, Patch);
  if (!body.ok) return body.response;
  const before = await getRule(g.session.userId, id!);
  if (!before) return apiError("rule_not_found", 404);
  const { confirm, ...patch } = body.data;
  const res = await updateRule(g.session.userId, id!, { ...patch, ...(confirm ? { enabled: true, pending_confirmation: false } : {}) });
  if (!res.ok) return apiError(res.refused ? "rule_refused" : "rule_invalid", res.refused ? 403 : 400, { reason: res.reason });
  await audit({ event: res.rule.enabled ? "rule_updated" : "rule_disabled", ownerId: g.session.userId, targetId: id, request: req, metadata: { fields: Object.keys(patch), confirmed: !!confirm } });
  let suppressed = 0;
  if (res.rule.enabled && (!before.enabled || confirm) && (res.rule.action.type === "exclude" || res.rule.action.type === "suppress_alert")) {
    suppressed = (await reprocessFindingsForRule(g.session.userId, id!)).suppressed;
  }
  return json({ rule: presentRule(res.rule), suppressed });
});

/** DELETE removes the rule; findings it suppressed are restored first so nothing stays hidden by a rule that no longer exists. */
export const DELETE = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  if (!Id.safeParse(id).success) return apiError("invalid_id", 400);
  const rule = await getRule(g.session.userId, id!);
  if (!rule) return apiError("rule_not_found", 404);
  const restored = (await undoRuleSuppression(g.session.userId, id!)).restored;
  await deleteRule(g.session.userId, id!);
  await audit({ event: "rule_deleted", ownerId: g.session.userId, targetId: id, request: req, metadata: { name: rule.name, restored } });
  return json({ ok: true, restored });
});
