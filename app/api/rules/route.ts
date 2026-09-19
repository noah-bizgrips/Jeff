import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { createRule, listRules } from "@/lib/jeff/rules/store";
import { detectConflicts } from "@/lib/jeff/rules/conflicts";
import { reprocessFindingsForRule } from "@/lib/jeff/rules/apply";
import { presentRule } from "@/lib/jeff/rules/present";
import { RuleInputSchema } from "@/lib/jeff/rules/schema";

export const dynamic = "force-dynamic";

export const GET = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const rules = await listRules(g.session.userId);
  return json({ rules: rules.map(presentRule), conflicts: detectConflicts(rules) });
});

const Body = RuleInputSchema.extend({ source_quote: z.string().max(500).optional(), reprocess: z.boolean().default(true) });

/** POST creates a rule from the settings UI (source=settings). Tier 2 rules are enabled directly — the owner is the one clicking. */
export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const body = await parseBody(req, Body);
  if (!body.ok) return body.response;
  const { source_quote, reprocess, ...rule } = body.data;
  const res = await createRule(g.session.userId, rule, { source: "settings", sourceQuote: source_quote ?? null, createdBy: "owner", pendingConfirmation: false });
  if (!res.ok) return apiError(res.refused ? "rule_refused" : "rule_invalid", res.refused ? 403 : 400, { reason: res.reason });
  await audit({ event: "rule_created", ownerId: g.session.userId, targetId: res.rule.id, request: req, metadata: { name: res.rule.name, tier: res.tier, source: "settings" } });
  let suppressed = 0;
  if (reprocess && res.rule.enabled && (res.rule.action.type === "exclude" || res.rule.action.type === "suppress_alert")) {
    suppressed = (await reprocessFindingsForRule(g.session.userId, res.rule.id)).suppressed;
    if (suppressed) await audit({ event: "findings_reprocessed", ownerId: g.session.userId, targetId: res.rule.id, request: req, metadata: { suppressed } });
  }
  return json({ rule: presentRule(res.rule), tier: res.tier, suppressed }, { status: 201 });
});
