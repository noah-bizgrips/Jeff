import { describe, expect, it } from "vitest";
import { buildClientMap, isPublicMailboxDomain, resolveClient, type MapSourceRow } from "@/lib/jeff/clients/map-core";
import { attributeRows } from "@/lib/jeff/clients/attribution-core";

const row = (provider: string, resource_type: string, external_id: string, metadata: Record<string, unknown>, title: string | null = null): MapSourceRow => ({ provider, resource_type, external_id, title, metadata });

const ROWS: MapSourceRow[] = [
  row("portal", "client", "7", { client_id: "7", slug: "austin-bath-co", status: "delivery", ghl_contact_id: "ghl_7" }, "Austin Bath Co"),
  row("portal", "client", "8", { client_id: "8", slug: "valley-bath", status: "active_setup", ghl_contact_id: null }, "Valley Bath"),
  row("portal", "lead_source", "5", { client_id: "7", source_type: "meta_page", routing_key: "123456789012345" }),
  row("portal", "lead_source", "6", { client_id: "8", source_type: "meta_form", routing_key: "form-8", meta_form_id: "form-8" }),
  row("portal", "client_user", "30", { client_id: "7", email_hash: "hash-jordan", email_domain: "austinbath.com" }),
  row("portal", "client_user", "31", { client_id: "8", email_hash: "hash-val", email_domain: "gmail.com" }),
  // A homeowner lead must not become the client's identity.
  row("portal", "lead", "1", { client_id: "7", email_hash: "hash-homeowner", email_domain: "gmail.com" }),
  // Stripe customers: one by exact hash, one by company domain, one public-domain that must NOT match.
  row("stripe", "customer", "cus_hash", { email_hash: "hash-jordan", email_domain: "austinbath.com" }),
  row("stripe", "customer", "cus_domain", { email_hash: "hash-other", email_domain: "austinbath.com" }),
  row("stripe", "customer", "cus_gmail", { email_hash: "hash-somebody", email_domain: "gmail.com" }),
  row("stripe", "customer", "cus_homeowner", { email_hash: "hash-homeowner", email_domain: "gmail.com" }),
  // HighLevel contacts: by ghl contact id and by hash.
  row("highlevel", "contact", "ghl_7", { email_hash: "x" }),
  row("highlevel", "contact", "ghl_x", { email_hash: "hash-jordan" }),
  row("highlevel", "contact", "ghl_none", { email_hash: "nope" }),
];

describe("client map", () => {
  const map = buildClientMap(ROWS);
  const austin = map.find((c) => c.slug === "austin-bath-co")!;
  const valley = map.find((c) => c.slug === "valley-bath")!;

  it("builds one entry per portal client with page/form ids and non-public domains", () => {
    expect(map).toHaveLength(2);
    expect(austin.meta_page_ids).toEqual(["123456789012345"]);
    expect(valley.meta_form_ids).toEqual(["form-8"]);
    expect(austin.email_domains).toEqual(["austinbath.com"]);
    expect(valley.email_domains).toEqual([]);
    expect(valley.email_hashes).toEqual(["hash-val"]);
  });

  it("derives Stripe customers by hash and by unique company domain, never by public mailbox domain", () => {
    expect(austin.stripe_customer_ids.sort()).toEqual(["cus_domain", "cus_hash"]);
    expect(valley.stripe_customer_ids).toEqual([]);
    expect(map.flatMap((c) => c.stripe_customer_ids)).not.toContain("cus_gmail");
  });

  it("does not treat a homeowner lead's email as the client's", () => {
    expect(austin.email_hashes).not.toContain("hash-homeowner");
    expect(map.flatMap((c) => c.stripe_customer_ids)).not.toContain("cus_homeowner");
  });

  it("derives HighLevel contacts by ghl contact id or hash", () => {
    expect(austin.highlevel_contact_ids.sort()).toEqual(["ghl_7", "ghl_x"]);
  });

  it("resolves by page, form, stripe customer, ghl contact, hash, and unique domain", () => {
    expect(resolveClient(map, { pageId: "123456789012345" })?.slug).toBe("austin-bath-co");
    expect(resolveClient(map, { formId: "form-8" })?.slug).toBe("valley-bath");
    expect(resolveClient(map, { stripeCustomerId: "cus_domain" })?.slug).toBe("austin-bath-co");
    expect(resolveClient(map, { ghlContactId: "ghl_x" })?.slug).toBe("austin-bath-co");
    expect(resolveClient(map, { emailHash: "hash-val" })?.slug).toBe("valley-bath");
    expect(resolveClient(map, { emailDomain: "austinbath.com" })?.slug).toBe("austin-bath-co");
    expect(resolveClient(map, { emailDomain: "gmail.com" })).toBeNull();
    expect(resolveClient(map, { pageId: "999" })).toBeNull();
  });

  it("public mailbox domains are recognised", () => {
    expect(isPublicMailboxDomain("Gmail.com")).toBe(true);
    expect(isPublicMailboxDomain("austinbath.com")).toBe(false);
    expect(isPublicMailboxDomain(null)).toBe(true);
  });
});

describe("attribution", () => {
  const map = buildClientMap(ROWS);
  it("stamps client_id on invoices/charges by Stripe customer, contacts/opportunities by HighLevel id, page insights by page id, and leaves ad insights without a page unattributed", () => {
    const { updates, unattributedAds } = attributeRows(
      [
        { id: "i1", provider: "stripe", resource_type: "invoice", metadata: { customerId: "cus_hash", status: "open" } },
        { id: "i2", provider: "stripe", resource_type: "invoice", metadata: { customerId: "cus_gmail" } },
        { id: "o1", provider: "highlevel", resource_type: "opportunity", metadata: { contactId: "ghl_x" } },
        { id: "p1", provider: "meta", resource_type: "page_insight", metadata: { page_id: "123456789012345" } },
        { id: "a1", provider: "meta", resource_type: "ad_insight", metadata: { account_id: "act_1" } },
        { id: "a2", provider: "meta", resource_type: "ad_insight", metadata: { account_id: "act_1", page_id: "123456789012345" } },
        { id: "already", provider: "stripe", resource_type: "charge", metadata: { customerId: "cus_hash", client_id: "7" } },
      ],
      map,
    );
    const ids = Object.fromEntries(updates.map((u) => [u.id, u.metadata.client_id]));
    expect(ids).toEqual({ i1: "7", o1: "7", p1: "7", a2: "7" });
    expect(updates.find((u) => u.id === "i1")!.metadata.attribution).toBe("stripe_customer");
    expect(unattributedAds).toBe(1);
  });
});
