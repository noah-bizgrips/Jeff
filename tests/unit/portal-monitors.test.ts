import { describe, expect, it } from "vitest";
import type { SourceRow } from "@/lib/gomez/monitors/types";
import { portalTaskOverdue } from "@/lib/gomez/monitors/portal-task-overdue";
import { portalStageStalled } from "@/lib/gomez/monitors/portal-stage-stalled";
import { portalNotificationFailure } from "@/lib/gomez/monitors/portal-notification-failure";
import { leadNotContacted } from "@/lib/gomez/monitors/lead-not-contacted";
import { clientUnpaidInvoice } from "@/lib/gomez/monitors/client-unpaid-invoice";
import { clientAdSpendNoLeads } from "@/lib/gomez/monitors/client-ad-spend-no-leads";
import { runMonitors } from "@/lib/gomez/monitors";
import { summarizeClients } from "@/lib/gomez/clients/overview";
import { buildClientMap } from "@/lib/gomez/clients/map-core";

const NOW = new Date("2026-09-12T12:00:00Z");
const ctx = { now: NOW };
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

let seq = 0;
function r(provider: string, resource_type: string, metadata: Record<string, unknown>, extra: Partial<SourceRow> = {}): SourceRow {
  seq++;
  return {
    id: `row-${seq}`,
    provider,
    capability: null,
    resource_type,
    external_id: extra.external_id ?? `ext-${seq}`,
    title: extra.title ?? `${resource_type} ${seq}`,
    summary: null,
    author: null,
    source_url: extra.source_url ?? "https://portal.bizgrips.com/admin/#client/7",
    source_timestamp: extra.source_timestamp ?? null,
    tags: [],
    metadata,
  };
}

const client = r("portal", "client", { client_id: "7", slug: "austin-bath-co", status: "delivery" }, { external_id: "7", title: "Austin Bath Co" });
const churned = r("portal", "client", { client_id: "9", slug: "gone", status: "churned" }, { external_id: "9", title: "Gone Bath" });

describe("portal_task_overdue", () => {
  it("high severity when BizGrips owes, escalated by a blocking task; ignores churned clients and fresh client-owned tasks", () => {
    const rows = [
      client,
      churned,
      r("portal", "task", { client_id: "7", status: "not_started", owner: "BizGrips", due_at: ago(3), blocking: true }, { title: "Build page" }),
      r("portal", "task", { client_id: "7", status: "in_progress", owner: "Client", due_at: ago(2), blocking: false }, { title: "Send logo" }),
      r("portal", "task", { client_id: "7", status: "complete", owner: "BizGrips", due_at: ago(30) }),
      r("portal", "task", { client_id: "9", status: "not_started", owner: "BizGrips", due_at: ago(30) }),
    ];
    const out = portalTaskOverdue.run(rows, ctx);
    expect(out).toHaveLength(1);
    expect(out[0]!.fingerprint).toBe("portal_task_overdue:7");
    expect(out[0]!.severity).toBe("high");
    expect(out[0]!.metrics.owed_by_bizgrips).toBe(1);
    expect(out[0]!.metrics.owed_by_client_past_grace).toBe(0);
    expect(out[0]!.title).toContain("Austin Bath Co");
  });
  it("client-owned only: medium once past the grace period, nothing before", () => {
    expect(portalTaskOverdue.run([client, r("portal", "task", { client_id: "7", status: "not_started", owner: "Client", due_at: ago(3) })], ctx)).toHaveLength(0);
    const out = portalTaskOverdue.run([client, r("portal", "task", { client_id: "7", status: "not_started", owner: "Client", due_at: ago(10) })], ctx);
    expect(out[0]!.severity).toBe("medium");
  });
});

describe("portal_stage_stalled", () => {
  it("flags in-progress stages beyond their window or 14 days; not complete or fresh ones", () => {
    const rows = [
      client,
      r("portal", "stage", { client_id: "7", status: "in_progress", started_at: ago(20), window_days: 7, day_start: 0, day_end: 7 }, { external_id: "st1", title: "Kickoff" }),
      r("portal", "stage", { client_id: "7", status: "in_progress", started_at: ago(3), window_days: 7 }, { external_id: "st2" }),
      r("portal", "stage", { client_id: "7", status: "complete", started_at: ago(40), window_days: 7 }, { external_id: "st3" }),
      r("portal", "stage", { client_id: "7", status: "in_progress", started_at: ago(16), window_days: 0 }, { external_id: "st4" }),
    ];
    const out = portalStageStalled.run(rows, ctx);
    expect(out.map((f) => f.fingerprint).sort()).toEqual(["portal_stage_stalled:st1", "portal_stage_stalled:st4"]);
    expect(out.find((f) => f.fingerprint.endsWith("st1"))!.severity).toBe("high");
  });
});

describe("portal_notification_failure", () => {
  it("groups by client + channel within 7 days", () => {
    const rows = [
      client,
      r("portal", "notification", { client_id: "7", channel: "email", status: "bounced", reason: "mailbox full", event: "task_due" }, { source_timestamp: ago(1) }),
      r("portal", "notification", { client_id: "7", channel: "email", status: "failed", reason: "smtp", event: "task_due" }, { source_timestamp: ago(2) }),
      r("portal", "notification", { client_id: "7", channel: "sms", status: "failed", event: "task_due" }, { source_timestamp: ago(2) }),
      r("portal", "notification", { client_id: "7", channel: "email", status: "failed", event: "task_due" }, { source_timestamp: ago(20) }),
    ];
    const out = portalNotificationFailure.run(rows, ctx);
    expect(out).toHaveLength(2);
    const email = out.find((f) => f.fingerprint === "portal_notification_failure:7:email")!;
    expect(email.metrics.failures).toBe(2);
  });
});

describe("lead_not_contacted", () => {
  it("counts new leads older than 24h per active client", () => {
    const rows = [
      client,
      churned,
      r("portal", "lead", { client_id: "7", outcome: "new", source: "meta" }, { source_timestamp: ago(2), title: "Sam Rivera" }),
      r("portal", "lead", { client_id: "7", outcome: "new" }, { source_timestamp: ago(0.5) }),
      r("portal", "lead", { client_id: "7", outcome: "contacted" }, { source_timestamp: ago(5) }),
      r("portal", "lead", { client_id: "9", outcome: "new" }, { source_timestamp: ago(5) }),
    ];
    const out = leadNotContacted.run(rows, ctx);
    expect(out).toHaveLength(1);
    expect(out[0]!.metrics.leads_new_over_threshold).toBe(1);
    expect(out[0]!.observed_facts[0]).toContain("Sam Rivera");
    expect(out[0]!.severity).toBe("low");
  });
});

describe("client_unpaid_invoice", () => {
  it("only attributed unpaid invoices, grouped per client", () => {
    const rows = [
      client,
      r("stripe", "invoice", { client_id: "7", status: "past_due", amount_due: 250_000, currency: "usd", number: "INV-1", attribution: "stripe_customer" }),
      r("stripe", "invoice", { client_id: "7", status: "open", amount_due: 10_000, due_date: ago(3).slice(0, 10) }),
      r("stripe", "invoice", { client_id: "7", status: "open", amount_due: 10_000, due_date: new Date(NOW.getTime() + 5 * DAY).toISOString().slice(0, 10) }),
      r("stripe", "invoice", { status: "past_due", amount_due: 999_999 }),
      r("stripe", "invoice", { client_id: "7", status: "paid", amount_due: 5_000 }),
    ];
    const out = clientUnpaidInvoice.run(rows, ctx);
    expect(out).toHaveLength(1);
    expect(out[0]!.metrics.invoices).toBe(2);
    expect(out[0]!.metrics.outstanding_minor).toBe(260_000);
    expect(out[0]!.severity).toBe("high");
  });
});

describe("client_ad_spend_no_leads", () => {
  it("fires only with attributed spend ≥ $100 and zero leads in 7 days", () => {
    const spend = (cid: string | null, amount: number, days: number) => r("meta", "ad_insight", { ...(cid ? { client_id: cid } : {}), spend: amount, currency: "usd", campaign_name: "Bath Q3" }, { source_timestamp: ago(days) });
    expect(clientAdSpendNoLeads.run([client, spend(null, 50_000, 1)], ctx)).toHaveLength(0);
    expect(clientAdSpendNoLeads.run([client, spend("7", 5_000, 1)], ctx)).toHaveLength(0);
    expect(clientAdSpendNoLeads.run([client, spend("7", 20_000, 1), r("portal", "lead", { client_id: "7", outcome: "new" }, { source_timestamp: ago(1) })], ctx)).toHaveLength(0);
    const out = clientAdSpendNoLeads.run([client, spend("7", 20_000, 1), spend("7", 40_000, 3), spend("7", 90_000, 20)], ctx);
    expect(out).toHaveLength(1);
    expect(out[0]!.metrics.spend_minor).toBe(60_000);
    expect(out[0]!.severity).toBe("high");
  });
});

describe("integration with the monitor runner", () => {
  it("new monitors run alongside the existing ones", () => {
    const rows = [client, r("portal", "task", { client_id: "7", status: "not_started", owner: "BizGrips", due_at: ago(5) })];
    const { candidates, errors } = runMonitors(rows, NOW);
    expect(errors).toEqual([]);
    expect(candidates.some((c) => c.category === "portal_task_overdue")).toBe(true);
  });
});

describe("client overview summary", () => {
  it("summarises tasks, leads, billing and findings per client without PII", () => {
    const map = buildClientMap([{ provider: "portal", resource_type: "client", external_id: "7", title: "Austin Bath Co", metadata: { client_id: "7", slug: "austin-bath-co", status: "delivery" } }]);
    const rows = [
      { ...client, summary: null },
      r("portal", "task", { client_id: "7", status: "not_started", owner: "BizGrips", due_at: ago(2), is_overdue: true }),
      r("portal", "task", { client_id: "7", status: "not_started", owner: "Client", due_at: new Date(NOW.getTime() + 2 * DAY).toISOString() }),
      r("portal", "lead", { client_id: "7", outcome: "new", email_hash: "h" }, { source_timestamp: ago(3), title: "Sam Rivera" }),
      r("stripe", "invoice", { client_id: "7", status: "open", amount_due: 12_000, due_date: ago(1).slice(0, 10), currency: "usd" }),
    ];
    const [s] = summarizeClients(map, rows, [{ id: "f1", category: "portal_task_overdue", title: "Austin Bath Co: 1 overdue task", severity: "high", status: "open", evidence: [], metrics: {} }], NOW);
    expect(s!.tasks.overdue_bizgrips).toBe(1);
    expect(s!.tasks.due_next_7d).toBe(1);
    expect(s!.leads.new_uncontacted).toBe(1);
    expect(s!.billing?.unpaid_minor).toBe(12_000);
    expect(s!.open_findings[0]!.id).toBe("f1");
    expect(JSON.stringify(s)).not.toContain("@");
  });
});
