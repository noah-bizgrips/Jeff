import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { getAlert, updateAlert } from "@/lib/jeff/alerts/store";
import { inferNarrowRule, loadFindingForRule } from "@/lib/jeff/rules/feedback";
import { createRule } from "@/lib/jeff/rules/store";
import { reprocessFindingsForRule } from "@/lib/jeff/rules/apply";
import { presentRule } from "@/lib/jeff/rules/present";
import { describeRule } from "@/lib/jeff/rules/schema";

export const dynamic = "force-dynamic";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("acknowledge") }),
  z.object({ action: z.literal("snooze"), until: z.string().datetime().optional(), hours: z.number().int().min(1).max(24 * 14).optional() }),
  z.object({ action: z.literal("dismiss") }),
  z.object({ action: z.literal("resolve") }),
  z.object({ action: z.literal("reopen") }),
  /** Mute: dismiss + infer the narrowest rule from the underlying finding (never a monitor mute). */
  z.object({ action: z.literal("mute") }),
  /** Change rule: return the proposed narrow rule without creating it. */
  z.object({ action: z.literal("propose_rule") }),
]);

export const PATCH = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return apiError("invalid_id", 400);
  const body = await parseBody(req, Body);
  if (!body.ok) return body.response;
  const alert = await getAlert(g.session.userId, id!);
  if (!alert) return apiError("alert_not_found", 404);
  const now = new Date();

  if (body.data.action === "mute" || body.data.action === "propose_rule") {
    if (alert.kind !== "finding" || !alert.ref_id) return apiError("not_a_finding_alert", 400);
    const loaded = await loadFindingForRule(g.session.userId, alert.ref_id);
    const inferred = loaded ? inferNarrowRule(loaded.finding, loaded.evidenceRow) : null;
    if (body.data.action === "propose_rule") return json({ proposed: inferred ? { ...inferred, summary: describeRule(inferred) } : null });
    let rule = null;
    let suppressed = 0;
    if (inferred) {
      const res = await createRule(g.session.userId, inferred, { source: "feedback", sourceQuote: `Mute alert: ${alert.title}`, createdBy: "owner", pendingConfirmation: false });
      if (res.ok) {
        rule = presentRule(res.rule);
        suppressed = (await reprocessFindingsForRule(g.session.userId, res.rule.id)).suppressed;
        await audit({ event: "rule_created", ownerId: g.session.userId, targetId: res.rule.id, request: req, metadata: { name: res.rule.name, source: "feedback", suppressed } });
      }
    }
    const updated = await updateAlert(g.session.userId, id!, { action: "dismiss" }, now);
    await audit({ event: "alert_updated", ownerId: g.session.userId, targetId: id, request: req, metadata: { action: "mute", rule: rule?.name ?? null } });
    return json({ alert: updated, rule, suppressed });
  }

  const action = body.data.action === "snooze" ? { action: "snooze" as const, until: body.data.until ?? new Date(now.getTime() + (body.data.hours ?? 24) * 3_600_000).toISOString() } : { action: body.data.action };
  const updated = await updateAlert(g.session.userId, id!, action, now);
  await audit({ event: "alert_updated", ownerId: g.session.userId, targetId: id, request: req, metadata: { action: body.data.action } });
  return json({ alert: updated });
});
