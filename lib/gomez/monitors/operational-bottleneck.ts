import { evidenceOf, str, type CandidateFinding, type Monitor, type SourceRow } from "./types";

/** Calendar density: days in the next 7 with more than MAX_EVENTS events or more than MAX_HOURS booked. */
export const MAX_EVENTS = 5;
export const MAX_HOURS = 6;

export const operationalBottleneck: Monitor = {
  id: "operational_bottleneck",
  run(rows, ctx) {
    const start = ctx.now.getTime();
    const end = start + 7 * 86_400_000;
    const days = new Map<string, { events: SourceRow[]; hours: number }>();
    for (const r of rows) {
      if (r.resource_type !== "event" || !r.source_timestamp) continue;
      const s = Date.parse(r.source_timestamp);
      if (!(s >= start && s <= end)) continue;
      const endIso = str(r.metadata.end);
      const rawDur = endIso ? (Date.parse(endIso) - s) / 3_600_000 : 0.5;
      const dur = Number.isFinite(rawDur) && rawDur > 0 ? Math.min(rawDur, 12) : 0.5;
      const key = new Date(s).toISOString().slice(0, 10);
      const d = days.get(key) ?? { events: [], hours: 0 };
      d.events.push(r);
      d.hours += dur;
      days.set(key, d);
    }
    const out: CandidateFinding[] = [];
    for (const [day, d] of days) {
      if (d.events.length <= MAX_EVENTS && d.hours <= MAX_HOURS) continue;
      out.push({
        fingerprint: `operational_bottleneck:calendar:${day}`,
        category: "operational_bottleneck",
        title: `Heavy day on ${day}: ${d.events.length} events, ${d.hours.toFixed(1)}h booked`,
        observed_facts: d.events.slice(0, 8).map((e) => `${e.title ?? "Event"} at ${e.source_timestamp}`),
        metrics: { events: d.events.length, hours: Math.round(d.hours * 10) / 10, max_events: MAX_EVENTS, max_hours: MAX_HOURS, formula: "count(events on day), sum(end - start)" },
        interpretation: "Interpretation: little slack for follow-ups or surprises that day. Consider moving a non-critical meeting or blocking prep time.",
        evidence: d.events.slice(0, 8).map(evidenceOf),
        range_start: `${day}T00:00:00.000Z`,
        range_end: `${day}T23:59:59.999Z`,
        confidence: 0.85,
        limitations: "Uses synced Google/HighLevel calendars only; events without an end time count as 30 minutes.",
        severity: d.events.length > 8 || d.hours > 9 ? "medium" : "low",
        proposed_mission: null,
      });
    }
    return out;
  },
};
