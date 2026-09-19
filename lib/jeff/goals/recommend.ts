import type { GoalMetric, MetricResult } from "./schema";
import type { TrajectoryResult } from "./trajectory";
import { formatMetricValue, formatTarget } from "./metrics";

/**
 * Rule-based recommendations for goals. Pure. Each recommendation explains
 * why it matters, the evidence, the expected mechanism, the downside, what
 * Jeff can prepare, and whether approval is required. No ROI claims.
 */

export interface RecommendationCandidate {
  fingerprint: string;
  title: string;
  why: string;
  evidence: { kind: string; ref: string; detail: string }[];
  mechanism: string;
  downside: string;
  jeff_can_prepare: string;
  requires_approval: boolean;
  mission: { title: string; goal: string };
}

export interface RecommendInput {
  goalId: string;
  goalName: string;
  primary: GoalMetric;
  definitions: GoalMetric[];
  metrics: Record<string, MetricResult>;
  trajectory: TrajectoryResult;
  drivers: { key: string; name: string; value: number | null; implied_target: number | null }[];
}

export function recommendForGoal(input: RecommendInput): RecommendationCandidate[] {
  const out: RecommendationCandidate[] = [];
  const t = input.trajectory;
  const atRisk = t.trajectory === "at_risk" || t.trajectory === "severely_at_risk" || t.trajectory === "slightly_at_risk";
  const primaryRes = input.metrics[input.primary.key];

  // 1. Missing data sources block measurement — the highest-leverage fix is usually connecting them.
  const missing = Object.values(input.metrics).filter((m) => m.freshness === "missing");
  if (missing.length) {
    const providers = Array.from(new Set(missing.flatMap((m) => m.limitations.filter((l) => l.endsWith("not connected")))));
    if (providers.length) {
      out.push({
        fingerprint: `connect:${providers.sort().join(",")}`,
        title: `Connect ${providers.map((p) => p.replace(" not connected", "")).join(" and ")} to measure this goal`,
        why: `${missing.map((m) => m.key).join(", ")} cannot be computed until the source is connected, so trajectory is partly unknown.`,
        evidence: missing.map((m) => ({ kind: "metric", ref: m.key, detail: m.limitations.join("; ") })),
        mechanism: "Once the source syncs, the metric fills in and the trajectory label stops being 'not enough data'.",
        downside: "None beyond setup time; connections are read-only.",
        jeff_can_prepare: "Nothing to prepare — this is a one-time authorization in Connections.",
        requires_approval: false,
        mission: { title: `Connect ${providers.join(", ")}`, goal: `Authorize ${providers.join(" and ")} in Connections so the goal "${input.goalName}" can measure ${missing.map((m) => m.key).join(", ")}.` },
      });
    }
  }

  // 2. Driver constraint (funnel) recommendations.
  if (atRisk && t.constraint_key) {
    const d = input.drivers.find((x) => x.key === t.constraint_key);
    if (d) {
      const templates: Record<string, Omit<RecommendationCandidate, "fingerprint" | "evidence">> = {
        qualified_leads: {
          title: "Lead volume is the constraint — review acquisition before anything downstream",
          why: t.constraint_reason ?? "Fewer new leads than the funnel needs.",
          mechanism: "More qualified leads entering the pipeline is the only driver that compounds through booking and close rates.",
          downside: "Acquisition spend changes affect CAC; any budget change needs your approval.",
          jeff_can_prepare: "A report of lead sources by volume and conversion over the goal window, plus a draft plan for the weakest channel.",
          requires_approval: true,
          mission: { title: "Analyze lead sources and propose an acquisition adjustment", goal: `Compare lead volume and conversion by source for "${input.goalName}"; propose (do not execute) an adjustment. No budget changes without approval.` },
        },
        booked_appointments: {
          title: "Booked calls are the constraint — tighten lead → booking",
          why: t.constraint_reason ?? "Leads are not converting into booked appointments at the needed rate.",
          mechanism: "Faster first response and a simpler booking step raise the booked rate without more spend.",
          downside: "Automation changes touch client-facing flows; test with synthetic contacts first.",
          jeff_can_prepare: "A response-time audit for recent leads and a draft follow-up sequence for review.",
          requires_approval: true,
          mission: { title: "Audit lead response time and draft a booking follow-up sequence", goal: `Measure time-to-first-response for recent leads and draft (do not send) a follow-up sequence to lift booked appointments for "${input.goalName}".` },
        },
        signed: {
          title: "Close rate is the constraint — review proposals and stalled opportunities",
          why: t.constraint_reason ?? "Booked calls are not becoming signed clients at the needed rate.",
          mechanism: "Surfacing stalled opportunities and follow-up gaps recovers deals already in the pipeline.",
          downside: "Outreach to prospects is a client-facing action and requires approval.",
          jeff_can_prepare: "A list of open opportunities past their usual stage age with the last touch and a suggested next step each.",
          requires_approval: true,
          mission: { title: "Prepare a stalled-opportunity follow-up list", goal: `List open opportunities with no activity in 3+ days and draft a next step per opportunity for "${input.goalName}". No messages sent.` },
        },
      };
      const tpl = templates[d.key];
      if (tpl) out.push({ fingerprint: `driver:${d.key}`, evidence: [{ kind: "driver", ref: d.key, detail: `${d.value ?? "—"} vs implied ${d.implied_target ?? "—"}` }], ...tpl });
    }
  }

  // 3. Constraint violations (CAC, sign→payment, margin…).
  for (const v of t.violations) {
    const def = input.definitions.find((m) => m.key === v.key);
    const res = input.metrics[v.key];
    if (!def || !res) continue;
    const base = { fingerprint: `violation:${v.key}`, evidence: [{ kind: "metric", ref: v.key, detail: `${formatMetricValue(res)} vs ${formatTarget(def)} · ${res.source}` }] };
    if (v.key === "cac") {
      out.push({
        ...base,
        title: "Acquisition cost is above target",
        why: `CAC is ${formatMetricValue(res)} against ${formatTarget(def)}.`,
        mechanism: "Shifting spend toward the campaigns with the lowest cost per won client lowers blended CAC.",
        downside: "Reallocating budget can reduce volume; changes need your approval and are executed only outside Jeff.",
        jeff_can_prepare: "A campaign-level cost-per-client breakdown for the goal window.",
        requires_approval: true,
        mission: { title: "Break down CAC by campaign", goal: `Compute cost per won client by Meta campaign for "${input.goalName}" and propose a reallocation for review.` },
      });
    } else if (v.key === "sign_to_first_payment_days") {
      out.push({
        ...base,
        title: "Sign → first payment is slower than target",
        why: `Median time is ${formatMetricValue(res)} against ${formatTarget(def)}.`,
        mechanism: "Sending the first invoice at signing and adding a payment reminder shortens the gap without changing pricing.",
        downside: "Invoice timing changes are client-facing; keep them approval-gated.",
        jeff_can_prepare: "A list of signed clients with days-to-first-payment and the invoicing step each is waiting on.",
        requires_approval: true,
        mission: { title: "Audit sign-to-payment delays", goal: `For clients won in the goal window, list days from won to first paid Stripe charge and identify where the delay occurs for "${input.goalName}".` },
      });
    } else {
      out.push({
        ...base,
        title: `${def.name} is outside its limit`,
        why: `${def.name} is ${formatMetricValue(res)} against ${formatTarget(def)}.`,
        mechanism: "Investigating the inputs behind this metric usually reveals a single driver to fix.",
        downside: "Depends on the fix; Jeff only prepares analysis here.",
        jeff_can_prepare: `An evidence bundle for ${def.name} over the goal window.`,
        requires_approval: false,
        mission: { title: `Investigate ${def.name}`, goal: `Analyze why ${def.name} is ${formatMetricValue(res)} versus ${formatTarget(def)} for "${input.goalName}" and propose options.` },
      });
    }
  }

  // 4. Pace gap on the primary metric without a clearer constraint.
  if (atRisk && !t.constraint_key && primaryRes && t.required_pace != null && t.observed_pace != null) {
    out.push({
      fingerprint: "pace:primary",
      title: `Pace is behind on ${input.primary.name}`,
      why: `Observed ${t.observed_pace}/day vs required ${t.required_pace}/day with ${t.remaining_days} days left.`,
      evidence: [{ kind: "metric", ref: input.primary.key, detail: `${formatMetricValue(primaryRes)} of ${formatTarget(input.primary)} · ${primaryRes.source}` }],
      mechanism: "Identifying which funnel stage is thinnest turns a pace problem into a specific fix.",
      downside: "None for analysis; actions that follow may need approval.",
      jeff_can_prepare: "A funnel breakdown for the goal window with the weakest stage highlighted.",
      requires_approval: false,
      mission: { title: `Find the constraint behind ${input.primary.name}`, goal: `Break the funnel for "${input.goalName}" into stages and identify the weakest conversion step.` },
    });
  }

  return out.slice(0, 5);
}
