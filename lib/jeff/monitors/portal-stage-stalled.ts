import { evidenceOf, type CandidateFinding, type Monitor } from "./types";
import { DAY, clientIndex, clientLabel, isActiveClient, str } from "./portal-shared";

/**
 * A stage in progress longer than its own day window, or longer than
 * STALL_DAYS regardless of window. One finding per stalled stage.
 */
export const STALL_DAYS = 14;

export const portalStageStalled: Monitor = {
  id: "portal_stage_stalled",
  run(rows, ctx) {
    const now = ctx.now.getTime();
    const idx = clientIndex(rows);
    const out: CandidateFinding[] = [];
    for (const r of rows) {
      if (r.provider !== "portal" || r.resource_type !== "stage") continue;
      if (str(r.metadata.status) !== "in_progress") continue;
      const clientId = str(r.metadata.client_id);
      if (!isActiveClient(idx, clientId)) continue;
      const started = str(r.metadata.started_at);
      if (!started) continue;
      const ageDays = (now - Date.parse(started)) / DAY;
      const windowDays = typeof r.metadata.window_days === "number" ? r.metadata.window_days : 0;
      const overWindow = windowDays > 0 && ageDays > windowDays;
      const overStall = ageDays > STALL_DAYS;
      if (!overWindow && !overStall) continue;
      const name = clientLabel(idx, clientId);
      const age = Math.round(ageDays);
      const excess = windowDays > 0 ? Math.round(ageDays - windowDays) : null;
      out.push({
        fingerprint: `portal_stage_stalled:${r.external_id}`,
        category: "portal_stage_stalled",
        title: `${name}: stage "${r.title}" has been in progress ${age} days${windowDays ? ` (planned ${windowDays})` : ""}`,
        observed_facts: [
          `Stage "${r.title}" for ${name} started ${started.slice(0, 10)} and is still in progress after ${age} days.`,
          windowDays ? `The plan allots ${windowDays} days to this stage (days ${String(r.metadata.day_start)}–${String(r.metadata.day_end)}).` : "The stage has no planned window.",
        ],
        metrics: { age_days: Math.round(ageDays * 10) / 10, planned_days: windowDays || null, days_over_plan: excess, stall_threshold_days: STALL_DAYS, formula: "age = now - started_at; stalled = age > planned window OR age > stall threshold" },
        interpretation: "Interpretation: a stage that outlives its window usually means a task inside it is blocked — check the overdue tasks for this client before assuming the client is disengaged.",
        evidence: [evidenceOf(r)],
        range_start: started,
        range_end: ctx.now.toISOString(),
        confidence: 0.8,
        limitations: "Stage windows come from the template; a deliberately extended engagement will look stalled. Stages completed after the last sync clear on the next run.",
        severity: overWindow && ageDays > windowDays * 2 ? "high" : "medium",
        proposed_mission: { title: `Unstick "${r.title}" for ${name}`, goal: `Review why stage "${r.title}" for ${name} is ${age} days in, list the open tasks holding it, and propose the next concrete step. Do not contact the client.` },
      });
    }
    return out;
  },
};
