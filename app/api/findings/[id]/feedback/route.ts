import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { inferNarrowRule, loadFindingForRule } from "@/lib/jeff/rules/feedback";
import { createRule } from "@/lib/jeff/rules/store";
import { reprocessFindingsForRule } from "@/lib/jeff/rules/apply";
import { presentRule } from "@/lib/jeff/rules/present";
import { describeRule } from "@/lib/jeff/rules/schema";

export const dynamic = "force-dynamic";

const Body = z.object({
  verdict: z.enum(["useful", "not_useful", "wrong", "too_noisy", "dont_show", "change_rule", "already_knew"]),
  note: z.string().trim().max(500).optional(),
});

/**
 * POST /api/findings/{id}/feedback
 * Records the verdict. `dont_show` infers the narrowest rule from the
 * finding's own evidence (never a whole-monitor mute), applies it as Tier 1,
 * and reprocesses. `change_rule` returns the proposed narrow rule for the
 * editor without creating it.
 */
export const POST = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return apiError("invalid_id", 400);
  const body = await parseBody(req, Body);
  if (!body.ok) return body.response;
  const loaded = await loadFindingForRule(g.session.userId, id!);
  if (!loaded) return apiError("finding_not_found", 404);
  const admin = createAdminClient();
  const { data: fRow } = await admin.from("findings").select("job_id").eq("id", id!).eq("owner_id", g.session.userId).maybeSingle();
  const jobId = (fRow as { job_id?: string | null } | null)?.job_id ?? null;

  let ruleId: string | null = null;
  let created = null;
  let suppressed = 0;
  let proposed = null;
  const inferred = body.data.verdict === "dont_show" || body.data.verdict === "change_rule" || body.data.verdict === "too_noisy" || body.data.verdict === "already_knew" ? inferNarrowRule(loaded.finding, loaded.evidenceRow) : null;

  if (body.data.verdict === "dont_show") {
    if (!inferred) {
      await admin.from("findings").update({ status: "dismissed" }).eq("id", id!).eq("owner_id", g.session.userId);
    } else {
      const res = await createRule(g.session.userId, inferred, { source: "feedback", sourceQuote: `Don't show this again: ${loaded.finding.title}`, createdBy: "owner", pendingConfirmation: false });
      if (res.ok) {
        ruleId = res.rule.id;
        created = presentRule(res.rule);
        suppressed = (await reprocessFindingsForRule(g.session.userId, res.rule.id)).suppressed;
        await audit({ event: "rule_created", ownerId: g.session.userId, targetId: res.rule.id, request: req, metadata: { name: res.rule.name, source: "feedback", suppressed } });
      } else {
        await admin.from("findings").update({ status: "dismissed" }).eq("id", id!).eq("owner_id", g.session.userId);
      }
    }
  } else if (body.data.verdict === "change_rule" || body.data.verdict === "too_noisy") {
    proposed = inferred ? { ...inferred, summary: describeRule(inferred) } : null;
  } else if (body.data.verdict === "wrong" || body.data.verdict === "not_useful") {
    await admin.from("findings").update({ status: "dismissed" }).eq("id", id!).eq("owner_id", g.session.userId);
  } else if (body.data.verdict === "already_knew") {
    // Not wrong, not useful as an alert: acknowledge quietly so it stops competing for attention.
    await admin.from("findings").update({ status: "acknowledged" }).eq("id", id!).eq("owner_id", g.session.userId);
    proposed = inferred ? { ...inferred, summary: describeRule(inferred) } : null;
  } else if (body.data.verdict === "useful") {
    await admin.from("findings").update({ status: "accepted" }).eq("id", id!).eq("owner_id", g.session.userId);
  }

  const { error } = await admin.from("finding_feedback").insert({ owner_id: g.session.userId, finding_id: id, verdict: body.data.verdict, note: body.data.note ?? null, rule_id: ruleId, job_id: jobId });
  if (error) return apiError("feedback_failed", 500);
  await audit({ event: "finding_feedback", ownerId: g.session.userId, targetId: id, request: req, metadata: { verdict: body.data.verdict, rule_id: ruleId } });
  return json({ ok: true, verdict: body.data.verdict, rule: created, suppressed, proposed });
});
