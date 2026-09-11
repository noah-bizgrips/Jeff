import { describe, expect, it } from "vitest";
import { classifyRoute, decideAccess } from "@/lib/auth/routes";

describe("route classification", () => {
  it("marks public routes", () => {
    for (const p of ["/login", "/unauthorized", "/api/health", "/api/auth/login", "/api/webhooks/stripe", "/api/webhooks/plaid", "/_next/static/x.js"]) {
      expect(classifyRoute(p)).toBe("public");
    }
  });
  it("marks MFA routes as aal1-reachable", () => {
    expect(classifyRoute("/mfa")).toBe("aal1");
    expect(classifyRoute("/api/auth/mfa/enroll")).toBe("aal1");
  });
  it("everything else is protected", () => {
    for (const p of ["/", "/connections", "/security", "/api/connections", "/api/jeff/chat", "/api/oauth/google/start"]) {
      expect(classifyRoute(p)).toBe("protected");
    }
  });
});

describe("access decisions", () => {
  it("unauthenticated protected route → redirected to /login (401 for API)", () => {
    const d = decideAccess("/connections", { status: "anonymous" });
    expect(d).toMatchObject({ allow: false, redirect: "/login", apiStatus: 401 });
    expect(decideAccess("/api/connections", { status: "anonymous" })).toMatchObject({ allow: false, apiStatus: 401, apiCode: "unauthenticated" });
  });
  it("wrong user → /unauthorized (403 for API)", () => {
    expect(decideAccess("/", { status: "unauthorized" })).toMatchObject({ allow: false, redirect: "/unauthorized", apiStatus: 403 });
    expect(decideAccess("/api/jeff/chat", { status: "unauthorized" })).toMatchObject({ allow: false, apiStatus: 403, apiCode: "not_owner" });
  });
  it("owner at aal1 → only the MFA flow is allowed", () => {
    expect(decideAccess("/", { status: "owner", aal: "aal1" })).toMatchObject({ allow: false, redirect: "/mfa", apiStatus: 403, apiCode: "mfa_required" });
    expect(decideAccess("/api/connections", { status: "owner", aal: "aal1" })).toMatchObject({ allow: false, apiStatus: 403, apiCode: "mfa_required" });
    expect(decideAccess("/mfa", { status: "owner", aal: "aal1" })).toEqual({ allow: true });
    expect(decideAccess("/api/auth/mfa/verify", { status: "owner", aal: "aal1" })).toEqual({ allow: true });
  });
  it("owner at aal2 → allowed everywhere", () => {
    for (const p of ["/", "/connections", "/security", "/api/connections", "/api/jeff/chat", "/mfa"]) {
      expect(decideAccess(p, { status: "owner", aal: "aal2" })).toEqual({ allow: true });
    }
  });
  it("wrong user cannot even reach /mfa", () => {
    expect(decideAccess("/mfa", { status: "unauthorized" })).toMatchObject({ allow: false, redirect: "/unauthorized" });
  });
});
