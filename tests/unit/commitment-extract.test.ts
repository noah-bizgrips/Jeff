import { describe, expect, it } from "vitest";
import { composeContext, extractCommitments, isOverdue } from "@/lib/jeff/commitments/extract";
import type { SourceRow } from "@/lib/jeff/monitors/types";
import { emailHash } from "@/lib/jeff/clients/client-leads";

const NOW = new Date("2026-09-16T18:00:00.000Z");

function row(over: Partial<SourceRow>): SourceRow {
  return {
    id: over.id ?? "r1",
    provider: "google",
    capability: "gmail",
    resource_type: "email",
    external_id: over.id ?? "r1",
    title: "Re: fence estimate",
    summary: "",
    author: "Sam Rivera <sam@example.com>",
    source_url: "https://mail.google.com/mail/u/0/#all/t1",
    source_timestamp: new Date(NOW.getTime() - 4 * 86_400_000).toISOString(),
    tags: ["inbox"],
    metadata: { threadId: "t1" },
    ...over,
  };
}

/** HighLevel contact rows make these senders known counterparties (classifier v2). */
const contact = (id: string, address: string): SourceRow =>
  row({ id: `hl-${id}`, provider: "highlevel", capability: "contacts", resource_type: "contact", external_id: id, title: id, author: null, source_url: null, metadata: { email_hash: emailHash(address) } });
const KNOWN = [contact("sam", "sam@example.com"), contact("jordan", "jordan@client.com")];

describe("commitment extraction", () => {
  it("extracts a human promise with a due date and who owes whom", () => {
    const rows = [
      row({ id: "m1", author: "noah@bizgrips.com", summary: "Thanks Sam — I'll send the revised proposal by Thursday.", metadata: { threadId: "t1" } }),
    ];
    const out = extractCommitments(rows, { ownAddresses: ["noah@bizgrips.com"], now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]!.direction).toBe("owed_by_me");
    expect(out[0]!.due_at).toBeTruthy();
    expect(out[0]!.action_text).toContain("proposal");
    expect(out[0]!.context_text).toContain("You promised");
  });
  it("counterparty promise → owed_to_me, with counterparty name", () => {
    const rows = [...KNOWN, row({ id: "m2", summary: "Jordan will send the access details tomorrow.", author: "Jordan Lee <jordan@client.com>" })];
    const out = extractCommitments(rows, { ownAddresses: ["noah@bizgrips.com"], now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]!.direction).toBe("owed_to_me");
    expect(out[0]!.counterparty).toBe("Jordan Lee");
  });
  it("ignores bot/system notifications and threads already answered by the other side", () => {
    const bot = row({ id: "b1", author: "notifications@github.com", title: "[BizGrips-Site-Builds/site-x] change webhook destination to n8n", summary: "I'll merge this by Friday." });
    const promise = row({ id: "p1", author: "sam@example.com", summary: "I'll send the deposit tomorrow.", metadata: { threadId: "t9" } });
    const reply = row({ id: "p2", author: "noah@bizgrips.com", summary: "Got it, thanks.", metadata: { threadId: "t9" }, source_timestamp: new Date(NOW.getTime() - 3 * 86_400_000).toISOString() });
    const out = extractCommitments([...KNOWN, bot, promise, reply], { ownAddresses: ["noah@bizgrips.com"], now: NOW });
    // The bot is excluded; the human promise was replied to, so its confidence drops below the floor.
    expect(out.find((c) => c.source_item_id === "b1")).toBeUndefined();
    expect(out.filter((c) => c.confidence >= 0.45).every((c) => c.source_item_id !== "p1" || c.confidence < 0.6)).toBe(true);
  });
  it("dedupes the same sentence from the same message and sorts by due date", () => {
    const a = row({ id: "d1", summary: "I'll send the contract by Friday.", metadata: { threadId: "ta" } });
    const b = row({ id: "d2", summary: "We'll call you tomorrow.", metadata: { threadId: "tb" } });
    const out = extractCommitments([...KNOWN, a, a, b], { ownAddresses: [], now: NOW });
    expect(out.map((c) => c.source_item_id)).toEqual(["d2", "d1"]);
  });
  it("composes context from the linked CRM opportunity", () => {
    const msg = row({ id: "hl1", provider: "highlevel", resource_type: "message", author: "Sam Rivera", metadata: { contactId: "c123", lastMessageDirection: "outbound" } });
    const opp: SourceRow = { ...row({ id: "o1" }), provider: "highlevel", resource_type: "opportunity", title: "Sam Rivera / Estimate", metadata: { contactId: "c123", monetaryValue: 8400, stage: "Estimate sent" } };
    const text = composeContext(msg, opp, "owed_by_me", "Sam", NOW);
    expect(text).toContain("$8,400");
    expect(text).toContain("4 days ago");
    expect(text).toContain("you said you would follow up");
  });
  it("overdue detection", () => {
    expect(isOverdue({ due_at: new Date(NOW.getTime() - 1000).toISOString(), status: "open" }, NOW)).toBe(true);
    expect(isOverdue({ due_at: new Date(NOW.getTime() + 1000).toISOString(), status: "open" }, NOW)).toBe(false);
    expect(isOverdue({ due_at: new Date(NOW.getTime() - 1000).toISOString(), status: "done" }, NOW)).toBe(false);
  });
});
