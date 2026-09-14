import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, jsonReq, OWNER_ID, OTHER_ID, type Claims } from "../helpers";
import { FakeDb } from "../fake-db";
import { emailHash } from "@/lib/jeff/clients/client-leads";

let claims: Claims = null;
let db = new FakeDb();
const audit = vi.fn(async () => {});

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeSupabase(claims) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => db.client() }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...(a as [])) }));

const route = await import("@/app/api/commitments/reprocess/route");
const { reclassifyCommitments, RECLASSIFY_NOTE } = await import("@/lib/jeff/commitments/reclassify");

const NOW = new Date("2026-09-14T16:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const owner = () => (claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal2" });
const params = () => ({ params: Promise.resolve({}) });

const PROMO_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const QB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const LIKE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const CLIENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
const CONTACT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5";

function seed() {
  const email = (id: string, title: string, author: string, summary: string) => ({
    id,
    owner_id: OWNER_ID,
    provider: "google",
    capability: "gmail",
    resource_type: "email",
    external_id: id,
    title,
    summary,
    author,
    source_url: `https://mail.google.com/mail/u/0/#all/${id}`,
    source_timestamp: daysAgo(5),
    tags: ["inbox"],
    metadata: { threadId: id, labelIds: ["INBOX"] },
    is_sample: false,
  });
  db.seed("source_items", [
    email(PROMO_ID, "Last call: 15% off ends tonight.", "My Metal Business Card <mmbc@mymetalbusinesscard.com>", "Last call: 15% off ends tonight. We'll ship your order by Friday."),
    email(QB_ID, "QuickBooks Capital", "QuickBooks Capital <servicing@quickbookscapital.intuit.com>", "Hello Noah, we will get back to you by tomorrow."),
    email(LIKE_ID, "Steve Seever: Like, comment and share", "Steve Seever <steve.seever@gmail.com>", "If we have a hard time getting the billing set up we'll circle back tomorrow."),
    email(CLIENT_ID, "Re: signed contract", "Oliver Chen <oliver@atlasclient.com>", "Thanks Noah — I'll send the signed contract Thursday."),
    { id: CONTACT_ID, owner_id: OWNER_ID, provider: "highlevel", capability: "contacts", resource_type: "contact", external_id: "hl-oliver", title: "Oliver Chen", summary: null, author: null, source_url: null, source_timestamp: daysAgo(30), tags: [], metadata: { email_hash: emailHash("oliver@atlasclient.com") }, is_sample: false },
  ]);
  const commitment = (id: string, source: string, action_text: string, status = "overdue") => ({ id, owner_id: OWNER_ID, source_item_id: source, fingerprint: `fp-${id}`, actor: "we", action_text, context_text: "", due_at: daysAgo(2), confidence: 0.7, status, direction: "owed_to_me", counterparty: "x", provider: "google", source_url: null, last_seen_at: daysAgo(1) });
  db.seed("commitments", [
    commitment("c-promo", PROMO_ID, "Last call: 15% off ends tonight."),
    commitment("c-qb", QB_ID, "we will get back to you by tomorrow"),
    commitment("c-like", LIKE_ID, "If we have a hard time getting the billing set up we'll circle back tomorrow."),
    commitment("c-client", CLIENT_ID, "I'll send the signed contract Thursday.", "open"),
    commitment("c-done", PROMO_ID, "already decided by the owner", "done"),
    commitment("c-orphan", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "source no longer synced"),
  ]);
  db.seed("obligations", [
    { id: "o-promo", owner_id: OWNER_ID, title: "Last call: 15% off ends tonight.", status: "overdue", origin: "commitment", commitment_id: "c-promo", fingerprint: "commitment:c-promo", metadata: { people: [] }, due_at: daysAgo(2), assigned_to: "other", scope: "business", priority: "normal", tracking_mode: "persistent", cadence: {}, reminder_count: 0, updated_at: daysAgo(1) },
    { id: "o-client", owner_id: OWNER_ID, title: "Signed contract", status: "open", origin: "commitment", commitment_id: "c-client", fingerprint: "commitment:c-client", metadata: {}, due_at: null, assigned_to: "other", scope: "business", priority: "normal", tracking_mode: "persistent", cadence: {}, reminder_count: 0, updated_at: daysAgo(1) },
  ]);
  db.seed("alerts", [{ id: "a-promo", owner_id: OWNER_ID, kind: "obligation", ref_id: "o-promo", status: "open", fingerprint: "al-1", title: "Reminder" }]);
}

beforeEach(() => {
  claims = null;
  db = new FakeDb();
  audit.mockClear();
  seed();
});

describe("reclassifyCommitments (classifier v2, idempotent)", () => {
  it("dismisses marketing/vendor/social commitments, keeps the genuine one, and never deletes or completes", async () => {
    const s = await reclassifyCommitments(OWNER_ID, NOW);
    expect(s.version).toBe(2);
    expect(s.scanned).toBe(5); // open/overdue only — the owner's `done` row is never scanned
    expect(s.dismissed).toBe(3);
    expect(s.kept).toBe(1);
    expect(s.unverifiable).toBe(1);
    const status = Object.fromEntries(db.rows("commitments").map((r) => [r.id, r.status]));
    expect(status).toMatchObject({ "c-promo": "dismissed", "c-qb": "dismissed", "c-like": "dismissed", "c-client": "open", "c-done": "done", "c-orphan": "overdue" });
    expect(db.writesTo("commitments", "delete")).toHaveLength(0);
    expect(db.rows("commitments").some((r) => r.status === "done" && r.id !== "c-done")).toBe(false);
    // Linked obligation: dismissed (not completed), explained, versioned; unrelated obligation untouched.
    const ob = db.rows("obligations").find((r) => r.id === "o-promo")!;
    expect(ob.status).toBe("dismissed");
    expect((ob.metadata as { classifier_version: number }).classifier_version).toBe(2);
    expect(db.rows("obligations").find((r) => r.id === "o-client")!.status).toBe("open");
    const events = db.rows("obligation_events").filter((e) => e.obligation_id === "o-promo");
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("note");
    expect((events[0]!.payload as { note: string }).note).toBe(RECLASSIFY_NOTE);
    expect(RECLASSIFY_NOTE).toBe("reclassified as marketing/system by classifier v2");
    expect(db.rows("alerts").find((a) => a.id === "a-promo")!.status).toBe("resolved");
  });
  it("is idempotent: a second run changes nothing", async () => {
    await reclassifyCommitments(OWNER_ID, NOW);
    const before = db.writes.length;
    const s = await reclassifyCommitments(OWNER_ID, NOW);
    expect(s.dismissed).toBe(0);
    expect(s.kept).toBe(1);
    expect(db.writes.length).toBe(before);
    expect(db.rows("obligation_events").filter((e) => e.obligation_id === "o-promo")).toHaveLength(1);
  });
});

describe("POST /api/commitments/reprocess", () => {
  it("requires the owner at aal2", async () => {
    expect((await route.POST(jsonReq("/api/commitments/reprocess", {}), params())).status).toBe(401);
    claims = { sub: OTHER_ID, email: "other@example.com", aal: "aal2" };
    expect((await route.POST(jsonReq("/api/commitments/reprocess", {}), params())).status).toBe(403);
    claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal1" };
    expect((await route.POST(jsonReq("/api/commitments/reprocess", {}), params())).status).toBe(403);
    expect(db.writesTo("commitments")).toHaveLength(0);
  });
  it("runs the reclassifier for the owner and audits it", async () => {
    owner();
    const res = await route.POST(jsonReq("/api/commitments/reprocess", {}), params());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; dismissed: number; kept: number; version: number };
    expect(body).toMatchObject({ ok: true, dismissed: 3, kept: 1, version: 2 });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: "commitments_reprocessed" }));
  });
});
