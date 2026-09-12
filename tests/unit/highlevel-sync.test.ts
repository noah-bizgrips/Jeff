import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/integrations/store", () => ({
  readSecret: vi.fn(async () => ({ kind: "oauth_tokens", access_token: "hl-access-test", location_id: "loc_1" })),
  writeSecret: vi.fn(async () => {}),
}));
vi.mock("@/lib/integrations/providers/highlevel", async () => {
  const actual = await vi.importActual<typeof import("@/lib/integrations/providers/highlevel")>("@/lib/integrations/providers/highlevel");
  return { ...actual, highlevelAccessToken: vi.fn(async () => ({ token: "hl-access-test" })) };
});

const { highlevelSyncAdapter } = await import("@/lib/integrations/sync/highlevel");

const conn = {
  id: "33333333-3333-4333-8333-333333333333",
  provider: "highlevel",
  displayName: "HighLevel",
  status: "connected" as const,
  accessMode: "read" as const,
  scopes: [],
  capabilities: ["contacts", "opportunities", "conversations", "calendars"],
  accountIdentifier: "BizGrips",
  lastTestAt: null,
  lastTestOk: true,
  lastError: null,
  lastSyncAt: null,
  createdAt: "",
  updatedAt: "",
  metadata: { locationId: "loc_1" },
};

const calls: string[] = [];
function mockFetch(handler: (url: URL) => unknown) {
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const body = handler(url);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
}

describe("HighLevel sync adapter", () => {
  beforeEach(() => {
    calls.length = 0;
    vi.unstubAllGlobals();
  });

  it("paginates contacts with startAfterId/startAfter and stops on a short page", async () => {
    mockFetch((url) => {
      if (url.pathname === "/contacts/") {
        const after = url.searchParams.get("startAfterId");
        if (!after) return { contacts: Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, firstName: "A", dateAdded: "2026-09-01T00:00:00.000Z" })), meta: { startAfterId: "c99", startAfter: 1756684800000 } };
        return { contacts: [{ id: "c100", firstName: "B", dateAdded: "2026-09-02T00:00:00.000Z", phone: "3035550100", email: "b@x.io" }] };
      }
      return {};
    });
    const res = await highlevelSyncAdapter.capabilities.contacts!(conn, null);
    expect(res.seen).toBe(101);
    expect(res.items).toHaveLength(101);
    expect(calls[0]).toContain("locationId=loc_1");
    expect(calls[1]).toContain("startAfterId=c99");
    expect(calls[1]).toContain("startAfter=1756684800000");
    expect(JSON.stringify(res.items)).not.toContain("3035550100");
    expect(JSON.stringify(res.items)).not.toContain("b@x.io");
    // Authorization + Version headers are sent, token never appears in the URL
    expect(calls.every((c) => !c.includes("hl-access-test"))).toBe(true);
  });

  it("stops opportunity pagination when meta has no startAfterId", async () => {
    mockFetch((url) => {
      if (url.pathname === "/opportunities/pipelines") return { pipelines: [{ id: "p1", name: "Sales", stages: [{ id: "s1", name: "New" }] }] };
      if (url.pathname === "/opportunities/search") return { opportunities: Array.from({ length: 100 }, (_, i) => ({ id: `o${i}`, name: `Deal ${i}`, pipelineId: "p1", pipelineStageId: "s1", status: "open" })), meta: { total: 100 } };
      return {};
    });
    const res = await highlevelSyncAdapter.capabilities.opportunities!(conn, null);
    expect(res.items).toHaveLength(100);
    expect(calls.filter((c) => c.startsWith("/opportunities/search"))).toHaveLength(1);
    expect(res.items[0]!.metadata.stage).toBe("New");
  });

  it("conversations use last_message_date sorting and startAfterDate cursoring", async () => {
    let page = 0;
    mockFetch((url) => {
      if (url.pathname === "/conversations/search") {
        page++;
        if (page === 1) return { conversations: Array.from({ length: 100 }, (_, i) => ({ id: `cv${i}`, contactId: `c${i}`, contactName: "N", lastMessageBody: "hi", lastMessageDate: 1757500000000 - i })) };
        return { conversations: [] };
      }
      return {};
    });
    const res = await highlevelSyncAdapter.capabilities.conversations!(conn, null);
    expect(res.items).toHaveLength(100);
    expect(calls[0]).toContain("sortBy=last_message_date");
    expect(calls[0]).toContain("sort=desc");
    expect(calls[1]).toContain("startAfterDate=1757499999901");
  });

  it("calendar events iterate calendars with millisecond windows", async () => {
    mockFetch((url) => {
      if (url.pathname === "/calendars/") return { calendars: [{ id: "cal1", name: "Estimates" }, { id: "cal2", name: "Installs" }] };
      if (url.pathname === "/calendars/events") return { events: [{ id: `${url.searchParams.get("calendarId")}-e1`, title: "Appt", startTime: "2026-09-12T13:00:00.000Z", endTime: "2026-09-12T14:00:00.000Z", appointmentStatus: "confirmed" }] };
      return {};
    });
    const res = await highlevelSyncAdapter.capabilities.calendars!(conn, null);
    expect(res.items.map((i) => i.external_id)).toEqual(["cal1-e1", "cal2-e1"]);
    const ev = calls.find((c) => c.startsWith("/calendars/events"))!;
    expect(ev).toMatch(/startTime=\d{13}/);
    expect(ev).toMatch(/endTime=\d{13}/);
    expect(ev).toContain("calendarId=cal1");
  });
});
