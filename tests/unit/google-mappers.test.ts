import { describe, expect, it } from "vitest";
import { mapCalendarEvent, mapDriveFile, mapGmailMessage, minimiseAddresses } from "@/lib/integrations/sync/google-mappers";

describe("Gmail mapper", () => {
  const msg = {
    id: "18f0abc",
    threadId: "18f0aaa",
    snippet: "Approved the direction. Revised proposal by Thursday.",
    internalDate: "1757347320000",
    labelIds: ["INBOX", "IMPORTANT", "CATEGORY_PERSONAL", "Label_42"],
    payload: {
      headers: [
        { name: "Subject", value: "Atlas launch: green light" },
        { name: "From", value: "Oliver Chen <oliver@example.com>" },
        { name: "To", value: "Noah <noah@bizgrips.com>, Maya <maya@example.com>" },
        { name: "X-Body-Leak", value: "SHOULD NOT MATTER" },
      ],
    },
  };

  it("keeps only metadata + snippet, never a body", () => {
    const out = mapGmailMessage(msg)!;
    expect(out).toMatchObject({
      provider: "google",
      capability: "gmail",
      resource_type: "email",
      external_id: "18f0abc",
      title: "Atlas launch: green light",
      author: "Oliver Chen <oliver@example.com>",
      source_url: "https://mail.google.com/mail/u/0/#all/18f0aaa",
      tags: ["inbox", "important", "personal"],
    });
    expect(out.summary).toBe(msg.snippet);
    expect(out.source_timestamp).toBe(new Date(1757347320000).toISOString());
    expect(out.metadata).toEqual({ threadId: "18f0aaa", labelIds: msg.labelIds, to: ["noah@bizgrips.com", "maya@example.com"] });
    expect(out.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(out)).not.toContain("body");
    expect(JSON.stringify(out)).not.toContain("SHOULD NOT MATTER");
  });

  it("skips spam, trash and promotions", () => {
    expect(mapGmailMessage({ ...msg, labelIds: ["SPAM"] })).toBeNull();
    expect(mapGmailMessage({ ...msg, labelIds: ["TRASH"] })).toBeNull();
    expect(mapGmailMessage({ ...msg, labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] })).toBeNull();
  });

  it("minimises addresses", () => {
    expect(minimiseAddresses("A <a@x.com>, b@y.com , C <c@z.com>", 2)).toEqual(["a@x.com", "b@y.com"]);
    expect(minimiseAddresses(null)).toEqual([]);
  });
});

describe("Calendar mapper", () => {
  it("maps events with attendees and truncates descriptions", () => {
    const out = mapCalendarEvent({
      id: "ev1",
      status: "confirmed",
      summary: "Atlas / Scope alignment",
      description: "x".repeat(1000),
      location: "Zoom",
      htmlLink: "https://calendar.google.com/event?eid=ev1",
      start: { dateTime: "2026-09-09T16:00:00Z" },
      end: { dateTime: "2026-09-09T16:30:00Z" },
      attendees: [{ email: "maya@example.com", displayName: "Maya" }, { email: "jordan@example.com" }],
    })!;
    expect(out).toMatchObject({ resource_type: "event", capability: "calendar", external_id: "ev1", title: "Atlas / Scope alignment", tags: ["meeting"], source_timestamp: "2026-09-09T16:00:00Z" });
    expect(out.summary!.length).toBeLessThan(520);
    expect(out.summary).toContain("Attendees (2): Maya, jordan@example.com");
    expect(out.metadata).toMatchObject({ location: "Zoom", attendees: ["maya@example.com", "jordan@example.com"], status: "confirmed" });
  });
  it("skips cancelled events and handles all-day dates", () => {
    expect(mapCalendarEvent({ id: "c", status: "cancelled" })).toBeNull();
    expect(mapCalendarEvent({ id: "d", start: { date: "2026-09-14" } })!.source_timestamp).toBe("2026-09-14T00:00:00Z");
  });
});

describe("Drive mapper", () => {
  it("maps files and skips trashed", () => {
    const out = mapDriveFile({
      id: "f1",
      name: "Atlas / Proposal v3",
      mimeType: "application/vnd.google-apps.document",
      modifiedTime: "2026-09-08T14:50:00Z",
      webViewLink: "https://docs.google.com/document/d/f1",
      owners: [{ displayName: "Noah", emailAddress: "noah@bizgrips.com" }],
      parents: ["p1"],
    })!;
    expect(out).toMatchObject({ resource_type: "file", capability: "drive", title: "Atlas / Proposal v3", author: "Noah", tags: ["document"], summary: "google document · owner Noah" });
    expect(out.metadata).toEqual({ mimeType: "application/vnd.google-apps.document", parents: ["p1"] });
    expect(mapDriveFile({ id: "t", trashed: true })).toBeNull();
  });
});
