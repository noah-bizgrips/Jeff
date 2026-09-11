import { describe, expect, it } from "vitest";
import { resolveOwnerSessionFromClaims } from "@/lib/auth/claims";

const OWNER = { email: "noah@bizgrips.com", userId: "11111111-1111-4111-8111-111111111111" };

describe("owner identity from verified claims", () => {
  it("no claims → anonymous", () => {
    expect(resolveOwnerSessionFromClaims(null, OWNER)).toEqual({ status: "anonymous" });
  });
  it("email matches but user id does not → unauthorized", () => {
    expect(resolveOwnerSessionFromClaims({ sub: "22222222-2222-4222-8222-222222222222", email: "noah@bizgrips.com", aal: "aal2" }, OWNER)).toEqual({ status: "unauthorized" });
  });
  it("user id matches but email does not → unauthorized", () => {
    expect(resolveOwnerSessionFromClaims({ sub: OWNER.userId, email: "someone@else.com", aal: "aal2" }, OWNER)).toEqual({ status: "unauthorized" });
  });
  it("OWNER_USER_ID unset → nobody is the owner (fail closed)", () => {
    expect(resolveOwnerSessionFromClaims({ sub: OWNER.userId, email: OWNER.email, aal: "aal2" }, { ...OWNER, userId: "" })).toEqual({ status: "unauthorized" });
  });
  it("both match → owner with the JWT's aal", () => {
    expect(resolveOwnerSessionFromClaims({ sub: OWNER.userId, email: OWNER.email, aal: "aal1" }, OWNER)).toEqual({ status: "owner", aal: "aal1" });
    expect(resolveOwnerSessionFromClaims({ sub: OWNER.userId, email: "Noah@BizGrips.com", aal: "aal2" }, OWNER)).toEqual({ status: "owner", aal: "aal2" });
  });
  it("missing aal defaults to aal1, never aal2", () => {
    expect(resolveOwnerSessionFromClaims({ sub: OWNER.userId, email: OWNER.email }, OWNER)).toEqual({ status: "owner", aal: "aal1" });
  });
});
