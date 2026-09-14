import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { audit } from "@/lib/audit";
import { listAlerts, surfacedAlerts, updateAlert, type AlertAction } from "@/lib/jeff/alerts/store";
import { listAlertGroups, updateAlertGroup, type GroupAction } from "@/lib/jeff/grouping/store";
import { latestBriefing } from "@/lib/jeff/briefings";
import { listCommitments } from "@/lib/jeff/commitments/store";
import { getSettings, updateSettings } from "@/lib/jeff/settings-store";
import { loadFreshness } from "@/lib/jeff/freshness-store";
import { freshnessSummary } from "@/lib/jeff/freshness";

/**
 * Ask Jeff tools for alerts, briefings, commitments, settings and data
 * freshness. Bounded, PII-minimised outputs; settings changes are Tier 1
 * only (the schema is the allow-list) and audited.
 */

export interface OpsToolContext {
  ownerId: string;
  request?: Request;
}

export const OPS_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "get_alerts",
    description: "Open alerts that deserve the owner's attention, most important first, with occurrences and evidence refs. Use for 'what should I focus on', 'anything urgent', 'what needs attention'. Includes data freshness.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "acknowledged", "snoozed", "dismissed", "resolved", "active"] },
        min_importance: { type: "string", enum: ["informational", "briefing", "important", "urgent"] },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_alert_groups",
    description:
      "Grouped situations: related alerts, findings and follow-through items bundled per client / goal / contact / workflow (e.g. 'Pure Bath of Michigan — 6 overdue portal tasks'). Each group carries a deterministic summary (oldest overdue, owner split, primary blocker), Jeff's interpretation when available, and its members with task, due date, days overdue, owner, priority, status and notes. Use for 'what's going on with <client>', 'what's the real problem', or to explain a grouped alert. Actions on a group: acknowledge, snooze, dismiss.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "open", "acknowledged", "snoozed", "dismissed", "resolved"] },
        entity: { type: "string", description: "Optional client / goal / contact name filter (case-insensitive contains)" },
        group_id: { type: "string", description: "Optional: only this group, with every member" },
        action: { type: "string", enum: ["acknowledge", "snooze", "dismiss", "reopen"], description: "Optional lifecycle action on group_id, on the owner's explicit request" },
        hours: { type: "integer", minimum: 1, maximum: 336 },
        limit: { type: "integer", minimum: 1, maximum: 30 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_briefing",
    description: "The latest daily brief or weekly/monthly review (sections: top attention, goals, today, business signals, financial, recommendations, changes, outcomes). Use to answer 'what should I focus on today' together with get_alerts.",
    input_schema: { type: "object", properties: { kind: { type: "string", enum: ["daily", "weekly", "monthly"] } }, additionalProperties: false },
  },
  {
    name: "get_commitments",
    description: "Open and overdue commitments extracted from conversations: who owes what to whom, due date, confidence and the context sentence (e.g. the linked estimate). Never includes message bodies.",
    input_schema: { type: "object", properties: { status: { type: "string", enum: ["open", "overdue", "done", "dismissed", "active"] } }, additionalProperties: false },
  },
  {
    name: "update_alert",
    description: "Acknowledge, snooze (hours), dismiss or resolve an alert on the owner's explicit request.",
    input_schema: {
      type: "object",
      properties: { alert_id: { type: "string" }, action: { type: "string", enum: ["acknowledge", "snooze", "dismiss", "resolve"] }, hours: { type: "integer", minimum: 1, maximum: 336 } },
      required: ["alert_id", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "get_settings",
    description: "The owner's briefing, notification and learning settings (timezone, brief time, quiet hours, minimum alert importance, scope toggles).",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: "update_settings",
    description: "Changes Tier-1 preferences only: timezone, daily brief time/enabled, weekly/monthly review, quiet hours, alert minimum importance, goal/opportunity/business/personal/financial notification toggles, learning toggles, brief_max_items. Security settings cannot be changed here.",
    input_schema: {
      type: "object",
      properties: {
        timezone: { type: "string" },
        daily_brief_enabled: { type: "boolean" },
        daily_brief_time: { type: "string", description: "HH:MM 24h" },
        weekly_review_enabled: { type: "boolean" },
        weekly_review_day: { type: "integer", minimum: 0, maximum: 6 },
        weekly_review_time: { type: "string" },
        monthly_review_enabled: { type: "boolean" },
        monthly_review_time: { type: "string" },
        quiet_hours_start: { type: "string" },
        quiet_hours_end: { type: "string" },
        alert_min_importance: { type: "string", enum: ["informational", "briefing", "important", "urgent"] },
        goal_alerts: { type: "boolean" },
        opportunity_alerts: { type: "boolean" },
        business_notifications: { type: "boolean" },
        personal_notifications: { type: "boolean" },
        financial_notifications: { type: "boolean" },
        learn_from_feedback: { type: "boolean" },
        auto_apply_safe_rules: { type: "boolean" },
        ask_before_major_changes: { type: "boolean" },
        brief_max_items: { type: "integer", minimum: 1, maximum: 10 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_data_freshness",
    description: "How fresh each connected source's data is (last successful sync, last error). Use before drawing conclusions from synced data and mention staleness in answers.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
];

const RANK: Record<string, number> = { informational: 0, briefing: 1, important: 2, actionable: 2.5, urgent: 3 };

export async function runOpsTool(name: string, input: Record<string, unknown>, ctx: OpsToolContext): Promise<unknown> {
  switch (name) {
    case "get_alerts": {
      const status = typeof input.status === "string" ? input.status : "active";
      const limit = Math.min(Number(input.limit ?? 15), 50);
      const rows = status === "active" ? await surfacedAlerts(ctx.ownerId, new Date(), limit * 2) : await listAlerts(ctx.ownerId, { status: [status as "open"], limit: limit * 2 });
      const min = typeof input.min_importance === "string" ? (RANK[input.min_importance] ?? 0) : 0;
      const freshness = await loadFreshness(ctx.ownerId).catch(() => []);
      return {
        alerts: rows
          .filter((a) => (RANK[a.importance] ?? 0) >= min)
          .slice(0, limit)
          .map((a) => ({ id: a.id, kind: a.kind, category: a.category, importance: a.importance, status: a.status, title: a.title, summary: a.summary, occurrences: a.occurrences, first_seen: a.first_seen, last_seen: a.last_seen, ref_id: a.ref_id, evidence: a.evidence.slice(0, 4), ...(a.kind === "group" ? { group_id: a.ref_id, member_count: a.occurrences, note: "One grouped situation; call get_alert_groups with group_id for the members." } : {}), ...(a.group_id ? { group_id: a.group_id } : {}) })),
        note: "Alerts of kind 'group' bundle several related signals under one item; their members are hidden (status grouped) and listed by get_alert_groups.",
        data_freshness: freshnessSummary(freshness),
      };
    }
    case "get_alert_groups": {
      const status = typeof input.status === "string" ? input.status : "active";
      const limit = Math.min(Number(input.limit ?? 10), 30);
      const groupId = typeof input.group_id === "string" && /^[0-9a-f-]{36}$/.test(input.group_id) ? input.group_id : null;
      const action = typeof input.action === "string" ? input.action : null;
      if (action) {
        if (!groupId) return { error: "group_id required for an action" };
        const hours = Math.min(Math.max(Number(input.hours ?? 24), 1), 336);
        const a: GroupAction | null = action === "snooze" ? { action: "snooze", until: new Date(Date.now() + hours * 3_600_000).toISOString() } : action === "acknowledge" || action === "dismiss" || action === "reopen" ? { action } : null;
        if (!a) return { error: "invalid action" };
        const row = await updateAlertGroup(ctx.ownerId, groupId, a);
        if (!row) return { error: "group_not_found" };
        await audit({ event: "alert_group_updated", ownerId: ctx.ownerId, targetId: groupId, request: ctx.request, metadata: { action, via: "chat" } });
        return { ok: true, group: { id: row.id, status: row.status, snoozed_until: row.snoozed_until } };
      }
      const rows = await listAlertGroups(ctx.ownerId, { status: status === "active" ? ["open", "acknowledged", "snoozed"] : [status as "open"], limit: 50 });
      const entity = typeof input.entity === "string" ? input.entity.toLowerCase() : null;
      const picked = rows.filter((g) => (groupId ? g.id === groupId : true) && (entity ? g.entity_name.toLowerCase().includes(entity) || g.title.toLowerCase().includes(entity) : true)).slice(0, limit);
      return {
        groups: picked.map((g) => ({
          id: g.id,
          entity: { kind: g.entity_kind, name: g.entity_name },
          issue: g.issue_kind,
          importance: g.importance,
          status: g.status,
          title: g.title,
          summary: g.summary,
          interpretation: g.interpretation,
          facts: g.facts,
          member_count: g.member_count,
          first_seen: g.first_seen,
          last_seen: g.last_seen,
          reopened_count: g.reopened_count,
          members: g.members.slice(0, groupId ? 60 : 12).map((m) => ({ kind: m.member_kind, id: m.member_id, title: m.title, key_source: m.key_source, due_at: m.detail.due_at, days_overdue: m.detail.days_overdue, owner: m.detail.owner, priority: m.detail.priority, status: m.detail.status, notes: m.detail.notes, blocking: m.detail.blocking, items: (m.detail.items ?? []).slice(0, 25) })),
        })),
        note: "Groups are explanatory bundles over existing records; every member keeps its own record. Remind-client and prepare-action are draft missions only (nothing is sent).",
      };
    }
    case "get_briefing": {
      const kind = (typeof input.kind === "string" ? input.kind : "daily") as "daily" | "weekly" | "monthly";
      const b = await latestBriefing(ctx.ownerId, kind);
      if (!b) return { briefing: null, note: `No ${kind} briefing generated yet. The owner can generate one from Briefings.` };
      return { briefing: { id: b.id, kind: b.kind, period_start: b.period_start, period_end: b.period_end, title: b.title, generated_at: b.created_at, sections: b.sections } };
    }
    case "get_commitments": {
      const status = typeof input.status === "string" ? input.status : "active";
      const rows = await listCommitments(ctx.ownerId, { status: status === "active" ? ["open", "overdue"] : [status as "open"], limit: 50 });
      return { commitments: rows.map((c) => ({ id: c.id, status: c.status, direction: c.direction, actor: c.actor, counterparty: c.counterparty, action: c.action_text, context: c.context_text, due_at: c.due_at, confidence: c.confidence, source_url: c.source_url })) };
    }
    case "update_alert": {
      const id = String(input.alert_id ?? "");
      const action = String(input.action ?? "");
      if (!/^[0-9a-f-]{36}$/.test(id)) return { error: "invalid alert_id" };
      const hours = Math.min(Math.max(Number(input.hours ?? 24), 1), 336);
      const a: AlertAction | null =
        action === "snooze"
          ? { action: "snooze", until: new Date(Date.now() + hours * 3_600_000).toISOString() }
          : action === "acknowledge" || action === "dismiss" || action === "resolve"
            ? { action }
            : null;
      if (!a) return { error: "invalid action" };
      const row = await updateAlert(ctx.ownerId, id, a);
      if (!row) return { error: "alert_not_found" };
      await audit({ event: "alert_updated", ownerId: ctx.ownerId, targetId: id, request: ctx.request, metadata: { action, via: "chat" } });
      return { ok: true, alert: { id: row.id, status: row.status, snoozed_until: row.snoozed_until } };
    }
    case "get_settings":
      return { settings: await getSettings(ctx.ownerId) };
    case "update_settings": {
      const res = await updateSettings(ctx.ownerId, input);
      if (!res.ok) return { error: res.reason };
      await audit({ event: "settings_updated", ownerId: ctx.ownerId, request: ctx.request, metadata: { changed: res.changed, via: "chat" } });
      return { ok: true, changed: res.changed, settings: res.settings, note: "Security settings (auth, MFA, access, approvals, secrets) are not changeable here by design." };
    }
    case "get_data_freshness": {
      const items = await loadFreshness(ctx.ownerId);
      return { summary: freshnessSummary(items), sources: items.map((f) => ({ provider: f.provider, name: f.display_name, level: f.level, text: f.text, last_success_at: f.last_success_at, last_error: f.last_error })) };
    }
    default:
      return undefined;
  }
}
