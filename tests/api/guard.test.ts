import { describe, expect, it, vi, beforeEach } from "vitest";
import { fakeSupabase, OWNER_ID, OTHER_ID, req, type Claims } from "../helpers";

let claims: Claims = null;
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeSupabase(claims) }));

const { requireOwnerAal2, isTrustedOrigin } = await import("@/lib/auth/guard");

describe("requireOwnerAal2", () => {
  beforeEach(() => (claims = null));

  it("no auth → 401", async () => {
    const r = await requireOwnerAal2(req("/api/connections", { method: "POST" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });
  it("wrong user → 403 not_owner", async () => {
    claims = { sub: OTHER_ID, email: "noah@bizgrips.com", aal: "aal2" };
    const r = await requireOwnerAal2(req("/api/connections"));
    if (!r.ok) {
      expect(r.response.status).toBe(403);
      expect(await r.response.json()).toEqual({ error: "not_owner" });
    } else throw new Error("should deny");
  });
  it("owner at aal1 → 403 mfa_required", async () => {
    claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal1" };
    const r = await requireOwnerAal2(req("/api/connections"));
    if (!r.ok) expect(await r.response.json()).toEqual({ error: "mfa_required" });
    else throw new Error("should deny");
  });
  it("owner at aal2 → ok", async () => {
    claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal2" };
    const r = await requireOwnerAal2(req("/api/connections"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.session.userId).toBe(OWNER_ID);
  });
  it("cross-site POST from another origin → 403 even for the owner", async () => {
    claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal2" };
    const r = await requireOwnerAal2(req("/api/connections", { method: "POST", sameOrigin: false, origin: "https://evil.example" }));
    if (!r.ok) expect(await r.response.json()).toEqual({ error: "untrusted_origin" });
    else throw new Error("should deny");
  });
});

describe("isTrustedOrigin", () => {
  it("allows GET without origin", () => expect(isTrustedOrigin(req("/x", { sameOrigin: false }))).toBe(true));
  it("blocks POST without any origin signal", () => expect(isTrustedOrigin(req("/x", { method: "POST", sameOrigin: false }))).toBe(false));
  it("allows POST whose Origin matches the app URL", () => expect(isTrustedOrigin(req("/x", { method: "POST", sameOrigin: false, origin: "https://gomez.test" }))).toBe(true));
});
