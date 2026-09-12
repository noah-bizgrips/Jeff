import { describe, expect, it } from "vitest";
import { mapClient, mapLead, mapNotification, mapStage, mapTask, clientAdminUrl } from "@/lib/integrations/sync/portal-mappers";
import { buildClientsItems, buildLeadsItems, buildNotificationItems, buildTasksItems } from "@/lib/integrations/sync/portal";
import type { PortalExport } from "@/lib/integrations/providers/portal";

const BASE = "https://portal.bizgrips.com";
const NOW = new Date("2026-09-12T12:00:00Z");

const res = <T>(rows: T[]) => ({ truncated: false, rows });

function sampleExport(): PortalExport {
  return {
    server_time: "2026-09-12T12:00:00Z",
    since: "1970-01-01T00:00:00Z",
    clients: res([{ id: 7, slug: "austin-bath-co", name: "Austin Bath Co", status: "delivery", ghl_contact_id: "ghl_7", day_zero: "2026-08-01", plan_days: 90, timezone: "America/Chicago", business_phone_last4: "0001", created_at: "2026-08-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" }]),
    client_stages: res([{ id: 70, client_id: 7, position: 1, title: "Kickoff", day_start: 0, day_end: 7, status: "in_progress", started_at: "2026-08-01T00:00:00Z", completed_at: null, changed_at: "2026-08-01T00:00:00Z" }]),
    client_tasks: res([
      { id: 700, client_id: 7, client_stage_id: 70, position: 1, title: "Send logo", owner: "Client", blocking: 1, due_at: "2026-09-01T00:00:00Z", status: "not_started", category: "onboarding", assignee_email_hash: "abc", assignee_email_domain: "austinbath.com", created_at: "2026-08-02T00:00:00Z", changed_at: "2026-08-02T00:00:00Z" },
      { id: 701, client_id: 7, client_stage_id: 70, position: 2, title: "Build page", owner: "BizGrips", blocking: 0, due_at: "2026-12-01T00:00:00Z", status: "complete", completed_at: "2026-08-20T00:00:00Z", category: "delivery", created_at: "2026-08-02T00:00:00Z", changed_at: "2026-08-20T00:00:00Z" },
    ]),
    leads: res([
      { id: 1, client_id: 7, first_name: "Sam", last_name: "Rivera", phone_last4: "9876", email_hash: "hash-sam", email_domain: "example.com", source: "meta", ghl_contact_id: "c1", outcome: "new", submitted_at: "2026-09-10T00:00:00Z", created_at: "2026-09-10T00:00:00Z", updated_at: "2026-09-10T00:00:00Z", deleted_at: null },
      { id: 2, client_id: 7, first_name: "Gone", last_name: "Lead", phone_last4: "1111", email_hash: null, email_domain: null, source: "meta", outcome: "lost", submitted_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-11T00:00:00Z", deleted_at: "2026-09-11T00:00:00Z" },
    ]),
    lead_sources: res([{ id: 5, client_id: 7, source_type: "meta_page", routing_key: "123456789012345", meta_form_id: null, sheet_id: null, active: 1, created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z" }]),
    appointments: res([{ id: 9, lead_id: 1, client_id: 7, ghl_appointment_id: "ap1", starts_at: "2026-09-14T15:00:00Z", status: "scheduled", created_at: "2026-09-11T00:00:00Z", updated_at: "2026-09-11T00:00:00Z" }]),
    notification_log: res([
      { id: 50, event: "task_due", channel: "email", client_id: 7, client_name: "Austin Bath Co", title: "Reminder for [email]", status: "bounced", reason: "mailbox full", recipient_hash: "rh", sent_at: "2026-09-11T00:00:00Z" },
      { id: 51, event: "task_due", channel: "push", client_id: 7, client_name: "Austin Bath Co", title: "Reminder", status: "sent", reason: null, recipient_hash: "rh2", sent_at: "2026-09-11T00:00:00Z" },
      { id: 52, event: "task_due", channel: "sms", client_id: 7, client_name: "Austin Bath Co", title: "Reminder", status: "queued", reason: null, recipient_hash: "rh3", sent_at: "2026-09-12T09:00:00Z" },
    ]),
    events: res([{ id: 900, client_id: 7, task_id: 700, stage_id: 70, type: "task_started", at: "2026-09-05T00:00:00Z", actor: "person", subject: "Granted portal access to [email]" }]),
    client_users: res([{ id: 30, client_id: 7, role: "primary", status: "active", email_hash: "hash-jordan", email_domain: "austinbath.com", invited_at: "2026-08-01T00:00:00Z", first_login_at: null, last_login_at: null, changed_at: "2026-08-01T00:00:00Z" }]),
  };
}

describe("portal mappers", () => {
  it("maps a client with the admin deep link and identifiers, no raw phone", () => {
    const it = mapClient(sampleExport().clients.rows[0]!, BASE);
    expect(it.provider).toBe("portal");
    expect(it.resource_type).toBe("client");
    expect(it.external_id).toBe("7");
    expect(it.source_url).toBe("https://portal.bizgrips.com/admin/#client/7");
    expect(it.metadata.ghl_contact_id).toBe("ghl_7");
    expect(it.metadata.business_phone_last4).toBe("0001");
    expect(JSON.stringify(it)).not.toMatch(/\+1\d{10}|@/);
  });

  it("computes overdue tasks and keeps owner/blocking", () => {
    const [overdue, done] = sampleExport().client_tasks.rows.map((t) => mapTask(t, BASE, NOW, "Kickoff"));
    expect(overdue!.metadata.is_overdue).toBe(true);
    expect(overdue!.metadata.overdue_days).toBeGreaterThan(10);
    expect(overdue!.metadata.owner).toBe("Client");
    expect(overdue!.metadata.blocking).toBe(true);
    expect(overdue!.metadata.stage_title).toBe("Kickoff");
    expect(done!.metadata.is_overdue).toBe(false);
    expect(JSON.stringify(overdue)).not.toContain("instructions");
  });

  it("stage age and window", () => {
    const st = mapStage(sampleExport().client_stages.rows[0]!, BASE, NOW);
    expect(st.metadata.window_days).toBe(7);
    expect(st.metadata.age_days).toBeGreaterThan(40);
  });

  it("lead keeps name + hashed email + last4 only", () => {
    const l = mapLead(sampleExport().leads.rows[0]!, BASE);
    expect(l.title).toBe("Sam Rivera");
    expect(l.metadata.email_hash).toBe("hash-sam");
    expect(l.metadata.phone_last4).toBe("9876");
    expect("address" in l.metadata).toBe(false);
    expect("project_notes" in l.metadata).toBe(false);
  });

  it("keeps only failed/bounced/stuck notifications", () => {
    const rows = sampleExport().notification_log.rows;
    expect(mapNotification(rows[0]!, BASE, NOW)?.metadata.status).toBe("bounced");
    expect(mapNotification(rows[1]!, BASE, NOW)).toBeNull();
    expect(mapNotification(rows[2]!, BASE, NOW)?.metadata.status).toBe("stuck");
    expect(mapNotification({ ...rows[2]!, sent_at: "2026-09-12T11:30:00Z" }, BASE, NOW)).toBeNull();
  });

  it("clientAdminUrl handles missing ids", () => {
    expect(clientAdminUrl(BASE, null)).toBeNull();
    expect(clientAdminUrl(`${BASE}/`, 3)).toBe(`${BASE}/admin/#client/3`);
  });
});

describe("portal sync builders", () => {
  it("clients capability yields client, stage and client_user rows", () => {
    const items = buildClientsItems(sampleExport(), BASE, NOW);
    expect(items.map((i) => i.resource_type).sort()).toEqual(["client", "client_user", "stage"]);
    const user = items.find((i) => i.resource_type === "client_user")!;
    expect(user.metadata.email_domain).toBe("austinbath.com");
    expect(user.title).not.toContain("@");
  });

  it("tasks capability resolves stage titles", () => {
    const items = buildTasksItems(sampleExport(), BASE, NOW);
    expect(items).toHaveLength(2);
    expect(items[0]!.metadata.stage_title).toBe("Kickoff");
  });

  it("leads capability removes soft-deleted leads and includes appointments + lead sources", () => {
    const { items, removedLeadIds } = buildLeadsItems(sampleExport(), BASE);
    expect(removedLeadIds).toEqual(["2"]);
    expect(items.map((i) => i.resource_type).sort()).toEqual(["appointment", "lead", "lead_source"]);
    expect(items.find((i) => i.resource_type === "lead_source")!.metadata.routing_key).toBe("123456789012345");
  });

  it("notifications capability includes failures and events only", () => {
    const items = buildNotificationItems(sampleExport(), BASE, NOW);
    expect(items.filter((i) => i.resource_type === "notification")).toHaveLength(2);
    expect(items.filter((i) => i.resource_type === "portal_event")).toHaveLength(1);
  });
});
