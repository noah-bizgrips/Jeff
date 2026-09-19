import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { audit } from "@/lib/audit";
import { GOAL_PROMPT_MAX_CHARS, interpretGoal } from "./interpret";
import { formatMetricValue, formatTarget } from "./metrics";
import { TRAJECTORY_LABEL } from "./schema";
import { createDraftGoal, getGoal, latestSnapshot, listGoalMetrics, listGoals, listRecommendations, rowToMetric } from "./store";

/**
 * Ask Jeff tools for goals. Read tools return bounded, PII-free summaries
 * with provenance (source, formula, freshness); propose_goal creates a DRAFT
 * the owner must approve in Goals.
 */

export interface GoalToolContext {
  ownerId: string;
}

export const GOAL_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "list_goals",
    description: "Lists the owner's goals (draft, active, paused, achieved, missed) with the latest trajectory, primary metric progress, days remaining and the current constraint. Use for 'what are my goals' or 'how are my goals doing'.",
    input_schema: {
      type: "object",
      properties: { status: { type: "string", enum: ["draft", "active", "paused", "achieved", "missed", "archived", "all"] } },
      additionalProperties: false,
    },
  },
  {
    name: "get_goal_status",
    description: "Detailed status for one goal: every metric with its value, target, source, formula, freshness and limitations; trajectory with forecast and pace; the binding constraint; open recommendations. Use to answer 'are we likely to hit the goal' and 'what is stopping us'.",
    input_schema: {
      type: "object",
      properties: { goal_id: { type: "string" }, name_contains: { type: "string", maxLength: 80 } },
      additionalProperties: false,
    },
  },
  {
    name: "propose_goal",
    description: "Turns a natural-language goal — one sentence or a detailed multi-metric brief — into a structured DRAFT goal (metrics with cross-source definitions, targets, sources, assumptions, open questions). Pass the owner's full text verbatim, including every definition, exclusion and open question. Nothing is tracked until the owner reviews and approves it under Goals.",
    input_schema: {
      type: "object",
      properties: { sentence: { type: "string", minLength: 8, maxLength: GOAL_PROMPT_MAX_CHARS } },
      required: ["sentence"],
      additionalProperties: false,
    },
  },
];

function summarizeSnapshot(snap: Awaited<ReturnType<typeof latestSnapshot>>, primaryKey: string | null) {
  if (!snap) return { trajectory: "unknown", label: TRAJECTORY_LABEL.unknown, note: "Not refreshed yet." };
  const p = primaryKey ? snap.metrics?.[primaryKey] : null;
  return {
    trajectory: snap.trajectory,
    label: TRAJECTORY_LABEL[snap.trajectory] ?? snap.trajectory,
    taken_at: snap.taken_at,
    elapsed_pct: snap.elapsed_pct,
    completion_pct: snap.completion_pct,
    observed_pace_per_day: snap.observed_pace,
    required_pace_per_day: snap.required_pace,
    forecast: snap.forecast,
    constraint_key: snap.constraint_key,
    primary: p ? { key: p.key, value: formatMetricValue(p), target: formatTarget(p), freshness: p.freshness } : null,
  };
}

export async function runGoalTool(name: string, input: Record<string, unknown>, ctx: GoalToolContext): Promise<unknown> {
  switch (name) {
    case "list_goals": {
      const status = typeof input.status === "string" ? input.status : "all";
      const goals = await listGoals(ctx.ownerId, status === "all" ? undefined : [status as "active"]);
      const out = [];
      for (const g of goals.slice(0, 20)) {
        const [snap, metrics] = await Promise.all([latestSnapshot(g.id), listGoalMetrics(g.id)]);
        const primary = metrics.find((m) => m.is_primary) ?? metrics[0] ?? null;
        const remaining = g.end_date ? Math.max(0, Math.round((Date.parse(g.end_date) - Date.now()) / 86_400_000)) : null;
        out.push({ id: g.id, name: g.name, status: g.status, scope: g.scope, start_date: g.start_date, end_date: g.end_date, days_remaining: remaining, unresolved_ambiguities: g.ambiguities.filter((a) => !a.resolution).length, ...summarizeSnapshot(snap, primary?.key ?? null) });
      }
      return { goals: out, note: out.length ? undefined : "No goals yet. Offer to propose one from a sentence the owner gives you." };
    }
    case "get_goal_status": {
      let goal = typeof input.goal_id === "string" ? await getGoal(ctx.ownerId, input.goal_id) : null;
      if (!goal && typeof input.name_contains === "string") {
        const needle = input.name_contains.toLowerCase();
        goal = (await listGoals(ctx.ownerId)).find((g) => g.name.toLowerCase().includes(needle) || g.prompt_text.toLowerCase().includes(needle)) ?? null;
      }
      if (!goal) return { error: "goal_not_found", hint: "Call list_goals first." };
      const [snap, metricRows, recs] = await Promise.all([latestSnapshot(goal.id), listGoalMetrics(goal.id), listRecommendations(goal.id)]);
      const metrics = metricRows.map((row) => {
        const def = rowToMetric(row, goal!.interpretation);
        const r = snap?.metrics?.[row.key];
        return {
          key: row.key,
          name: row.name,
          value: r ? formatMetricValue(r) : row.current_value == null ? "—" : String(row.current_value),
          target: formatTarget(def),
          meets_target: r?.meets_target ?? null,
          is_primary: row.is_primary,
          is_constraint: row.is_constraint,
          source: r?.source ?? Object.values(def.inputs).map((i) => `${i.provider} ${i.resource_type}`).join(" + "),
          formula: def.formula,
          time_range: r?.time_range ?? null,
          last_updated: r?.last_updated ?? row.current_computed_at,
          sample_size: r?.sample_size ?? null,
          freshness: r?.freshness ?? "missing",
          limitations: r?.limitations ?? def.limitations,
        };
      });
      const primary = metricRows.find((m) => m.is_primary) ?? metricRows[0] ?? null;
      return {
        goal: { id: goal.id, name: goal.name, status: goal.status, prompt_text: goal.prompt_text, start_date: goal.start_date, end_date: goal.end_date, assumptions: goal.assumptions, unresolved_ambiguities: goal.ambiguities.filter((a) => !a.resolution).map((a) => a.question) },
        trajectory: summarizeSnapshot(snap, primary?.key ?? null),
        metrics,
        recommendations: recs.filter((r) => r.status === "proposed").slice(0, 5).map((r) => ({ id: r.id, title: r.title, why: r.why, requires_approval: r.requires_approval, jeff_can_prepare: r.jeff_can_prepare })),
        guidance: "Answer with the trajectory label, the primary metric vs target, the binding constraint, and data freshness. Say what is unknown; never claim precision the sample size does not support.",
      };
    }
    case "propose_goal": {
      const sentence = String(input.sentence ?? "").trim();
      if (sentence.length < 8) return { error: "sentence_too_short" };
      const { interpretation, usedModel, notes } = await interpretGoal(ctx.ownerId, sentence);
      const goal = await createDraftGoal(ctx.ownerId, sentence, interpretation, { usedModel, notes });
      await audit({ event: "goal_created", ownerId: ctx.ownerId, targetId: goal.id, metadata: { via: "chat", metrics: interpretation.metrics.map((m) => m.key), ambiguities: interpretation.ambiguities.length } });
      return {
        draft_goal_id: goal.id,
        name: interpretation.name,
        timeframe: interpretation.timeframe,
        metrics: interpretation.metrics.map((m) => ({ key: m.key, name: m.name, target: formatTarget(m), sources: Object.values(m.inputs).map((i) => `${i.provider} ${i.resource_type}`), formula: m.formula })),
        assumptions: interpretation.assumptions,
        ambiguities: interpretation.ambiguities.map((a) => ({ question: a.question, options: a.options })),
        notes,
        next_step: "Tell the owner the draft is saved under Goals and list the ambiguities they need to resolve before approving. Do not claim the goal is being tracked yet.",
      };
    }
    default:
      return undefined;
  }
}
