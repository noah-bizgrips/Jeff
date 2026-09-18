import { describe, expect, it } from "vitest";
import { CLASSIFIER_VERSION, UNKNOWN_COUNTERPARTY_CAP, classifyCommitment } from "@/lib/gomez/monitors/commitment-classifier";
import { extractCommitments } from "@/lib/gomez/commitments/extract";
import { isKnownCounterparty, knownCounterparties } from "@/lib/gomez/commitments/counterparties";
import { classifyAuthor } from "@/lib/gomez/rules/engine";
import { hasMarketingLabel, isPromotionalText, isSocialNotification, isVendorAddress } from "@/lib/gomez/rules/marketing";
import { emailHash } from "@/lib/gomez/clients/client-leads";
import type { SourceRow } from "@/lib/gomez/monitors/types";

const NOW = new Date("2026-09-14T16:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const OWN = ["noah@bizgrips.com"];

function email(p: Partial<SourceRow> & { id: string }): SourceRow {
  return { provider: "google", capability: "gmail", resource_type: "email", external_id: p.id, title: null, summary: null, author: null, source_url: `https://mail.google.com/mail/u/0/#all/${p.id}`, source_timestamp: daysAgo(4), tags: ["inbox"], metadata: { threadId: p.id, labelIds: ["INBOX"] }, ...p };
}
const contact = (id: string, address: string): SourceRow => ({ id: `hl-${id}`, provider: "highlevel", capability: "contacts", resource_type: "contact", external_id: id, title: id, summary: null, author: null, source_url: null, source_timestamp: daysAgo(40), tags: [], metadata: { email_hash: emailHash(address) } });

// The three rows from the owner's Mission Control screenshot.
const LAST_CALL = email({ id: "promo", title: "Last call: 15% off ends tonight.", author: "My Metal Business Card <mmbc@mymetalbusinesscard.com>", summary: "Last call: 15% off ends tonight. We'll ship your order by Friday if you order now." });
const QB_CAPITAL = email({ id: "qb", title: "QuickBooks Capital", author: "QuickBooks Capital <servicing@quickbookscapital.intuit.com>", summary: "Hello Noah, we will review your application and get back to you by tomorrow." });
const SOCIAL_LIKE = email({ id: "like", title: "Steve Seever: Like, comment and share", author: "Steve Seever <steve.seever@gmail.com>", summary: "If we have a hard time getting the billing set up we'll circle back tomorrow. Like this post." });
// A genuine client promise from a known HighLevel contact.
const CLIENT = email({ id: "client", title: "Re: signed contract", author: "Oliver Chen <oliver@atlasclient.com>", summary: "Thanks Noah — I'll send the signed contract Thursday." });
const KNOWN = [contact("oliver", "oliver@atlasclient.com")];

describe("commitment classifier v2 — marketing, vendor and social mail never become commitments", () => {
  it("is version 2", () => {
    expect(CLASSIFIER_VERSION).toBe(2);
  });
  it("excludes the three screenshot rows before scoring", () => {
    for (const r of [LAST_CALL, QB_CAPITAL, SOCIAL_LIKE]) {
      const s = classifyCommitment(r, { ownAddresses: OWN, knownCounterparty: true });
      expect(s.sender_class, r.id).toBe("system");
      expect(s.confidence, r.id).toBe(0);
      expect(s.sentence, r.id).toBeNull();
    }
    expect(extractCommitments([...KNOWN, LAST_CALL, QB_CAPITAL, SOCIAL_LIKE], { ownAddresses: OWN, now: NOW })).toEqual([]);
  });
  it("still accepts a genuine client promise from a known contact", () => {
    const s = classifyCommitment(CLIENT, { ownAddresses: OWN, knownCounterparty: true });
    expect(s.sender_class).toBe("human");
    expect(s.sentence).toMatch(/signed contract Thursday/);
    expect(s.confidence).toBeGreaterThanOrEqual(0.45);
    const out = extractCommitments([...KNOWN, CLIENT], { ownAddresses: OWN, now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]!.direction).toBe("owed_to_me");
    expect(out[0]!.counterparty).toBe("Oliver Chen");
  });
  it("promotional copy is detected structurally (not by vendor name)", () => {
    expect(isPromotionalText("Last call: 15% off ends tonight.")).toBe(true);
    expect(isPromotionalText("Limited time offer — free trial, unsubscribe anytime")).toBe(true);
    expect(isPromotionalText("Join our webinar Thursday; view in browser")).toBe(true);
    expect(isPromotionalText("I'll send the signed contract Thursday.")).toBe(false);
    expect(isPromotionalText("The sale of the house closes Friday; I'll send the docs.")).toBe(false);
    expect(isPromotionalText("I can give you a discount on the second bathroom.")).toBe(false); // one weak hint is not marketing
    expect(isPromotionalText("Subscribe to our newsletter for weekly deals")).toBe(true); // several weak hints are
  });
  it("vendor / transactional mailboxes are system senders", () => {
    for (const a of ["servicing@quickbookscapital.intuit.com", "no-reply@example.com", "noreply@x.io", "notifications@app.com", "billing@vendor.com", "support@tool.io", "info@shop.com", "hello@brand.co", "marketing@brand.co", "news@site.com", "weekly-digest@site.com", "mailer@site.com"]) {
      expect(isVendorAddress(a), a).toBe(true);
    }
    for (const a of ["oliver@atlasclient.com", "steve.seever@gmail.com", "contact@smallbiz.com", "noah@bizgrips.com"]) {
      expect(isVendorAddress(a), a).toBe(false);
    }
  });
  it("social notification subjects and relays are system", () => {
    expect(isSocialNotification(null, "Steve Seever: Like, comment and share")).toBe(true);
    expect(isSocialNotification("Jane Doe via LinkedIn", "New message")).toBe(true);
    expect(isSocialNotification(null, "Jane commented on your post")).toBe(true);
    expect(isSocialNotification("Oliver Chen", "Re: signed contract")).toBe(false);
  });
  it("Gmail promotions/updates/social/forums categories are system, by labelIds or lowercased tags", () => {
    expect(hasMarketingLabel({ tags: [], metadata: { labelIds: ["CATEGORY_UPDATES"] } })).toBe(true);
    expect(hasMarketingLabel({ tags: ["promotions"], metadata: {} })).toBe(true);
    expect(hasMarketingLabel({ tags: ["inbox"], metadata: { labelIds: ["INBOX"] } })).toBe(false);
    expect(classifyAuthor(email({ id: "u", author: "Acme <ceo@acme.com>", title: "Hi", metadata: { labelIds: ["CATEGORY_SOCIAL"] } }))).toBe("system");
  });
  it("keeps GitHub notifications excluded", () => {
    const gh = email({ id: "gh", title: "[BizGrips-Site-Builds/site-x] change webhook destination", author: "noah-bizgrips <notifications@github.com>", summary: "I'll update the workflow by Friday." });
    expect(classifyCommitment(gh).sender_class).toBe("bot");
  });
});

describe("commitment classifier v2 — owed_to_me needs a known counterparty", () => {
  const stranger = email({ id: "stranger", title: "Partnership", author: "Alex Stone <alex@randomagency.co>", summary: "We'll send over the proposal tomorrow and follow up Friday." });
  it("caps confidence for a promise from an unknown sender, below the monitor threshold", () => {
    const s = classifyCommitment(stranger, { ownAddresses: OWN, knownCounterparty: false });
    expect(s.sender_class).toBe("human");
    expect(s.sentence).toBeTruthy();
    expect(s.confidence).toBeLessThanOrEqual(UNKNOWN_COUNTERPARTY_CAP);
    expect(s.reasons.join(" ")).toMatch(/not a known counterparty/);
    expect(extractCommitments([stranger], { ownAddresses: OWN, now: NOW })).toEqual([]);
  });
  it("does not cap when the counterparty is known: CRM contact, portal user/lead, calendar attendee, Slack, or a thread the owner replied in", () => {
    const rows: SourceRow[] = [
      contact("alex", "alex@randomagency.co"),
      { ...email({ id: "cal", title: "Kickoff", author: null }), resource_type: "event", capability: "calendar", metadata: { attendees: ["jamie@client.io", "noah@bizgrips.com"] } },
      { ...email({ id: "portal-c", author: null }), provider: "portal", capability: "clients", resource_type: "client", metadata: { client_id: "c1", client_users: [{ email_hash: emailHash("owner@bathco.com") }] } },
      { ...email({ id: "portal-l", author: null }), provider: "portal", capability: "leads", resource_type: "lead", metadata: { client_id: "c1", email_hash: emailHash("lead@gmail.com") } },
      email({ id: "own", author: "Noah <noah@bizgrips.com>", title: "Re: pricing", metadata: { threadId: "th-pricing", to: ["sam@newclient.com"] } }),
    ];
    const known = knownCounterparties(rows, OWN);
    const isKnown = (author: string, threadId = "x") => isKnownCounterparty(email({ id: "probe", author, metadata: { threadId } }), known);
    expect(isKnown("Alex <alex@randomagency.co>")).toBe(true);
    expect(isKnown("Jamie <jamie@client.io>")).toBe(true);
    expect(isKnown("Owner <owner@bathco.com>")).toBe(true);
    expect(isKnown("Lead <lead@gmail.com>")).toBe(true);
    expect(isKnown("Sam <sam@newclient.com>")).toBe(true);
    expect(isKnown("Someone <someone@else.com>", "th-pricing")).toBe(true); // owner replied in this thread
    expect(isKnown("Someone <someone@else.com>")).toBe(false);
    expect(isKnownCounterparty({ ...email({ id: "sl", author: "U123" }), provider: "slack", resource_type: "message" }, known)).toBe(true);
    expect(isKnownCounterparty({ ...email({ id: "hl", author: "Contact" }), provider: "highlevel", resource_type: "message", metadata: { contactId: "c9" } }, known)).toBe(true);
    const out = extractCommitments([...rows, stranger], { ownAddresses: OWN, now: NOW });
    expect(out.map((c) => c.source_item_id)).toContain("stranger");
  });
  it("owed_by_me still only needs actor + action + future marker", () => {
    const own = email({ id: "own2", author: "Noah <noah@bizgrips.com>", title: "Fence estimate", summary: "We will send the revised estimate by 9/18.", metadata: { threadId: "th-fence" } });
    const out = extractCommitments([own], { ownAddresses: OWN, now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]!.direction).toBe("owed_by_me");
    expect(out[0]!.due_at).toBe("2026-09-18T23:59:59.000Z");
    // A promise by the owner is never capped even when the classifier is told the counterparty is unknown.
    expect(classifyCommitment(own, { ownAddresses: OWN, knownCounterparty: false }).confidence).toBeGreaterThanOrEqual(0.45);
  });
});
