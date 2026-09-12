import { describe, expect, it } from "vitest";
import { contactDisplayName, emailParts, mapCalendarEvent, mapContact, mapConversation, mapOpportunity, maskPhone, toIso } from "@/lib/integrations/sync/highlevel-mappers";

const LOC = "loc_123";

describe("HighLevel mappers — PII minimisation", () => {
  it("contacts store no full phone or email, but a matching hash + domain", () => {
    const item = mapContact(
      { id: "c1", firstName: "Sam", lastName: "Rivera", email: "Sam.Rivera@Example.com", phone: "+1 (303) 555-0199", tags: ["Lead", "FENCE"], source: "website", assignedTo: "u9", dateAdded: "2026-09-01T00:00:00.000Z", dateUpdated: "2026-09-10T12:00:00.000Z", lastActivity: 1789041600000 },
      LOC,
    )!;
    const flat = JSON.stringify(item);
    expect(flat).not.toContain("sam.rivera@example.com");
    expect(flat).not.toContain("Sam.Rivera@Example.com");
    expect(flat).not.toContain("5550199");
    expect(item.metadata.phone).toBe("•••0199");
    expect(item.metadata.email_domain).toBe("example.com");
    expect(item.metadata.email_hash).toBe(emailParts("sam.rivera@example.com").hash);
    expect(item.title).toBe("Sam Rivera");
    expect(item.tags).toEqual(["lead", "fence"]);
    expect(item.resource_type).toBe("contact");
    expect(item.source_url).toBe("https://app.gohighlevel.com/v2/location/loc_123/contacts/detail/c1");
    expect(item.source_timestamp).toBe("2026-09-10T12:00:00.000Z");
    expect(item.metadata.lastActivity).toBe("2026-09-10T12:00:00.000Z");
  });

  it("falls back to a masked identity when the name is missing", () => {
    expect(contactDisplayName({ id: "abcdef12", email: "x@corp.io" })).toBe("Contact @corp.io");
    expect(contactDisplayName({ id: "abcdef12", phone: "3035550142" })).toBe("Contact •••0142");
    expect(contactDisplayName({ id: "abcdef12", firstNameLowerCase: "jo", lastNameLowerCase: "kim" })).toBe("Jo Kim");
  });

  it("helpers", () => {
    expect(maskPhone("12")).toBeNull();
    expect(emailParts("nope")).toEqual({ domain: null, hash: null });
    expect(toIso(1789041600000)).toBe("2026-09-10T12:00:00.000Z");
    expect(toIso("1789041600000")).toBe("2026-09-10T12:00:00.000Z");
    expect(toIso("garbage")).toBeNull();
    expect(toIso(null)).toBeNull();
  });
});

describe("HighLevel mappers — opportunities, conversations, appointments", () => {
  it("resolves stage names from pipelines and keeps status/value", () => {
    const item = mapOpportunity(
      { id: "o1", name: "Cedar fence — Rivera", monetaryValue: 8400, pipelineId: "p1", pipelineStageId: "s2", status: "open", contactId: "c1", lastStageChangeAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z" },
      LOC,
      [{ id: "p1", name: "Sales", stages: [{ id: "s1", name: "New" }, { id: "s2", name: "Estimate sent", position: 1 }] }],
    )!;
    expect(item.resource_type).toBe("opportunity");
    expect(item.metadata.stage).toBe("Estimate sent");
    expect(item.metadata.pipeline).toBe("Sales");
    expect(item.metadata.monetaryValue).toBe(8400);
    expect(item.tags).toEqual(["pipeline", "open"]);
    expect(item.summary).toContain("$8,400");
  });

  it("conversations keep only a 140-char preview of the last message", () => {
    const long = "x".repeat(500);
    const item = mapConversation({ id: "cv1", contactId: "c1", contactName: "Sam Rivera", lastMessageBody: long, lastMessageType: "TYPE_SMS", lastMessageDirection: "inbound", unreadCount: 2, lastMessageDate: "2026-09-11T10:00:00.000Z" }, LOC)!;
    expect(item.title.length).toBeLessThanOrEqual(200);
    expect(item.title.startsWith("Sam Rivera: ")).toBe(true);
    expect(item.title.length).toBe("Sam Rivera: ".length + 140);
    expect(JSON.stringify(item)).not.toContain("x".repeat(141));
    expect(item.metadata.contactId).toBe("c1");
    expect(item.metadata.unreadCount).toBe(2);
    expect(item.source_timestamp).toBe("2026-09-11T10:00:00.000Z");
  });

  it("appointments map start/end and status", () => {
    const item = mapCalendarEvent({ id: "e1", title: "Estimate: side-yard gate", calendarId: "cal1", contactId: "c2", appointmentStatus: "confirmed", startTime: "2026-09-12T13:00:00.000Z", endTime: "2026-09-12T14:00:00.000Z" }, LOC)!;
    expect(item.resource_type).toBe("event");
    expect(item.capability).toBe("calendars");
    expect(item.metadata.start).toBe("2026-09-12T13:00:00.000Z");
    expect(item.metadata.end).toBe("2026-09-12T14:00:00.000Z");
    expect(item.tags).toEqual(["appointment", "confirmed"]);
  });

  it("rejects rows without ids", () => {
    expect(mapContact({ id: "" }, LOC)).toBeNull();
    expect(mapOpportunity({ id: "" }, LOC)).toBeNull();
  });
});
