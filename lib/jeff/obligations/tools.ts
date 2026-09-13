import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { getSettings } from "@/lib/jeff/settings-store";
import { interpretReminder, toObligationInput } from "./interpret";
import { explainCompletion } from "./completion";
import { applyAction, countBuckets, createObligation, getObligation, listEvents, listObligations } from "./store";
import { bucketOf, type ObligationRow } from "./types";
import { searchEvidence } from "./watchdog";

/**
 * Ask Jeff tools for Follow-Through. "Stop reminding me" dismisses (never
 * completes); "mark done" completes; "did I ever…" searches evidence.
 */

export interface ObligationToolContext {
  ownerId: string;
  request?: Request;
}

export const OBLIGATION_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "create_reminder",
    description:
      "Creates an Open Obligation from a natural-language reminder ('Remind me tomorrow to send Brian the proposal and keep reminding me until I do'). Returns the structured interpretation: due date, tracking mode (once/persistent/important/critical), what would count as completion, and any ambiguities. Persistent reminders stay alive until completed, dismissed or cancelled.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The owner's exact sentence" },
        scope: { type: "string", enum: ["business", "personal", "financial"], description: "Override the inferred scope" },
        tracking_mode: { type: "string", enum: ["once", "persistent", "important", "critical"], description: "Override the inferred tracking mode" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "list_obligations",
    description: "Lists open obligations: what's overdue, waiting on the owner, waiting on someone else, possibly complete (needs confirmation), or snoozed. Use for 'what's still waiting on me?', 'what am I overdue on?', 'what needs follow-through?'.",
    input_schema: {
      type: "object",
      properties: {
        bucket: { type: "string", enum: ["all", "overdue", "waiting_on_me", "waiting_on_other", "possibly_complete", "snoozed", "done"] },
        scope: { type: "string", enum: ["business", "personal", "financial", "all"] },
        limit: { type: "integer", minimum: 1, maximum: 40 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "complete_obligation",
    description: "Marks an obligation done because the owner says the underlying thing happened ('mark the dentist thing done', 'yes that completed it'). Match by id or by title words.",
    input_schema: { type: "object", properties: { id: { type: "string" }, match: { type: "string", description: "Title words when no id is known" } }, additionalProperties: false },
  },
  {
    name: "snooze_obligation",
    description: "Snoozes an obligation until a time ('snooze the Calendly cancellation until Monday'). No reminders until then; tracking resumes afterwards.",
    input_schema: { type: "object", properties: { id: { type: "string" }, match: { type: "string" }, until: { type: "string", description: "ISO timestamp, or natural language like 'Monday' / 'tomorrow' / 'in 3 days'" } }, required: ["until"], additionalProperties: false },
  },
  {
    name: "dismiss_obligation",
    description: "Stops tracking an obligation WITHOUT marking it complete ('stop reminding me about this', 'stop tracking that', 'drop it'). Use cancel_obligation when the task is intentionally no longer required.",
    input_schema: { type: "object", properties: { id: { type: "string" }, match: { type: "string" }, note: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "cancel_obligation",
    description: "Cancels an obligation because the task is no longer required ('never mind, we're not doing that').",
    input_schema: { type: "object", properties: { id: { type: "string" }, match: { type: "string" }, note: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "explain_completion",
    description: "Explains why Jeff marked an obligation done (or why it is still open): the evidence record, source and completion rule. Use for 'why did you mark this done?'.",
    input_schema: { type: "object", properties: { id: { type: "string" }, match: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "did_i_do",
    description: "Searches connected data for evidence that something was done ('did I ever send Brian that proposal?', 'did I pay the vendor invoice?'). Returns the evidence tier (high/medium/low/uncertain) and references; never a guess.",
    input_schema: { type: "object", properties: { question: { type: "string" } }, required: ["question"], additionalProperties: false },
  },
];

function present(o: ObligationRow, now: Date) {
  return {
    id: o.id,
    title: o.title,
    bucket: bucketOf(o, now),
    status: o.status,
    due_at: o.due_at,
    snoozed_until: o.snoozed_until,
    tracking_mode: o.tracking_mode,
    priority: o.priority,
    scope: o.scope,
    origin: o.origin,
    waiting_on: o.waiting_on,
    counterparty: o.counterparty,
    reminder_count: o.reminder_count,
    last_reminded_at: o.last_reminded_at,
    completion_rule: o.completion_strategy.description ?? o.completion_strategy.kind,
    completion_question: o.completion_question,
    related_goal_id: o.related_goal_id,
    related_mission_id: o.related_mission_id,
    source_url: o.source_url,
  };
}

async function resolve(ownerId: string, input: Record<string, unknown>): Promise<ObligationRow | { error: string; candidates?: { id: string; title: string }[] }> {
  if (typeof input.id === "string") {
    const o = await getObligation(ownerId, input.id);
    return o ?? { error: "obligation_not_found" };
  }
  const match = typeof input.match === "string" ? input.match.toLowerCase().split(/\W+/).filter((w) => w.length > 2) : [];
  if (!match.length) return { error: "id_or_match_required" };
  const live = await listObligations(ownerId, { live: true, limit: 300 });
  const scored = live
    .map((o) => ({ o, score: match.filter((w) => o.title.toLowerCase().includes(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { error: "no_matching_obligation" };
  if (scored.length > 1 && scored[0]!.score === scored[1]!.score) return { error: "ambiguous_match", candidates: scored.slice(0, 5).map((x) => ({ id: x.o.id, title: x.o.title })) };
  return scored[0]!.o;
}

export async function runObligationTool(name: string, input: Record<string, unknown>, ctx: ObligationToolContext): Promise<unknown> {
  const now = new Date();
  switch (name) {
    case "create_reminder": {
      const settings = await getSettings(ctx.ownerId);
      const text = String(input.text ?? "").slice(0, 1000);
      if (!text.trim()) return { error: "text_required" };
      const interp = interpretReminder(text, now, settings.timezone);
      if (typeof input.scope === "string") interp.scope = input.scope as typeof interp.scope;
      if (typeof input.tracking_mode === "string") interp.tracking_mode = input.tracking_mode as typeof interp.tracking_mode;
      const { row, created } = await createObligation(ctx.ownerId, toObligationInput(interp, "jeff"), { actor: "owner", now });
      return { created, obligation: present(row, now), interpretation: { due_at: interp.due_at, tracking_mode: interp.tracking_mode, completion_evidence: interp.completion_strategy.description, completion_uncertain: interp.completion_uncertain, cadence: interp.cadence, ambiguities: interp.ambiguities, stop_when: "completed, dismissed or cancelled" } };
    }
    case "list_obligations": {
      const bucket = typeof input.bucket === "string" ? input.bucket : "all";
      const limit = Math.min(Number(input.limit ?? 20), 40);
      const rows = bucket === "done" ? await listObligations(ctx.ownerId, { statuses: ["completed", "dismissed", "cancelled"], limit: 100 }) : await listObligations(ctx.ownerId, { live: true, scope: typeof input.scope === "string" ? input.scope : undefined, limit: 300 });
      const counts = countBuckets(rows, now);
      const items = rows.map((o) => present(o, now)).filter((p) => bucket === "all" || bucket === "done" || p.bucket === bucket);
      return { counts, items: items.slice(0, limit), omitted: Math.max(0, items.length - limit) };
    }
    case "complete_obligation":
    case "snooze_obligation":
    case "dismiss_obligation":
    case "cancel_obligation": {
      const target = await resolve(ctx.ownerId, input);
      if ("error" in target) return target;
      let action;
      if (name === "complete_obligation") action = { action: "complete" as const };
      else if (name === "dismiss_obligation") action = { action: "dismiss" as const, note: typeof input.note === "string" ? input.note.slice(0, 500) : undefined };
      else if (name === "cancel_obligation") action = { action: "cancel" as const, note: typeof input.note === "string" ? input.note.slice(0, 500) : undefined };
      else {
        const settings = await getSettings(ctx.ownerId);
        const raw = String(input.until ?? "");
        const iso = !Number.isNaN(Date.parse(raw)) ? new Date(raw).toISOString() : (await import("./interpret")).parseDue(`by ${raw}`, now, settings.timezone).iso;
        if (!iso) return { error: "could_not_parse_until" };
        action = { action: "snooze" as const, until: iso };
      }
      const row = await applyAction(ctx.ownerId, target.id, action, { actor: "owner", now, request: ctx.request });
      return row ? { ok: true, obligation: present(row, now), note: name === "dismiss_obligation" ? "Dismissed = no longer tracked. Not recorded as completed." : undefined } : { error: "update_failed" };
    }
    case "explain_completion": {
      const target = await resolve(ctx.ownerId, input);
      if ("error" in target) {
        // Also allow explaining completed items.
        if (typeof input.id === "string") {
          const o = await getObligation(ctx.ownerId, input.id);
          if (o) return { explanation: explainCompletion(o), evidence: o.completion_evidence, events: (await listEvents(ctx.ownerId, o.id, 10)).map((e) => ({ kind: e.kind, at: e.created_at })) };
        }
        return target;
      }
      return { explanation: explainCompletion(target), evidence: target.completion_evidence, events: (await listEvents(ctx.ownerId, target.id, 10)).map((e) => ({ kind: e.kind, at: e.created_at })) };
    }
    case "did_i_do": {
      const q = String(input.question ?? "").slice(0, 400);
      const { assessment, strategy } = await searchEvidence(ctx.ownerId, q, now);
      return { strategy, tier: assessment.tier, confidence: assessment.confidence, explanation: assessment.explanation, evidence: assessment.evidence.map((e) => ({ provider: e.provider, title: e.title, url: e.url, observed_at: e.observed_at, reason: e.reason })), unavailable_sources: assessment.unavailable };
    }
    default:
      return undefined;
  }
}
